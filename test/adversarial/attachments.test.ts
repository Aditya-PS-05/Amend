import { describe, expect, it } from "vitest";
import type { gmail_v1 } from "googleapis";
import { MAX_ATTACHMENT_BYTES, type FileRef } from "../../src/adapters/types.js";
import { attachmentParts, buildMime, findTextPlain } from "../../src/adapters/gmail/real.js";
import { attachmentsToken, compile } from "../../src/core/compile.js";
import { composeInstruction, instructionFiles, type EmailCard, type RunReport } from "../../src/engine/engine.js";
import type { EmailRequest, EmailWriter } from "../../src/llm/draft-email.js";
import { messageFiles, selectMessage, type RawMessage } from "../../src/slack-app/app.js";
import { renderEmailCard } from "../../src/slack-app/receipt.js";
import { BASE_FACTS, V1, createWorld, type Msg } from "../helpers/world.js";

type World = Awaited<ReturnType<typeof createWorld>>;

const failedChecks = (r: RunReport) => r.checks.filter((c) => !c.ok);
const card = (r: RunReport | null): EmailCard => {
  if (!r?.email) throw new Error(`expected an email card, got ${JSON.stringify(r?.status)}`);
  return r.email;
};

/** Registers a Slack file with the fake downloader and returns its ref. */
function file(w: World, id: string, name: string, content = `contents of ${name}`, mimeType = "application/pdf"): FileRef {
  return { id, name, mimeType, size: w.files.add(id, content) };
}

const SEND_NOW: Msg = {
  text: `${V1.text} Go ahead and email it to her now.`,
  facts: { ...BASE_FACTS, delivery: ["send", "Go ahead and email it to her now"] },
};
const AMOUNT_50K: Msg = { text: V1.text.replace("$42k", "$50k"), facts: { ...BASE_FACTS, deal_amount: ["50000", "$50k"] } };
const REPLY_TS = "1726000100.000200";

describe("attachments on a new instruction", () => {
  it("attaches every file shared on the @Amend message to the Gmail draft", async () => {
    const w = await createWorld();
    const proposal = file(w, "F1", "Acme proposal.pdf");
    const pricing = file(w, "F2", "pricing.xlsx", "rows", "application/vnd.ms-excel");
    const r = await w.say(V1, { files: [proposal, pricing] });

    const draft = (await w.draft())!;
    expect(draft.attachments?.map((a) => a.name)).toEqual(["Acme proposal.pdf", "pricing.xlsx"]);
    expect(draft.attachments?.map((a) => a.size)).toEqual([proposal.size, pricing.size]);
    expect(draft.body).toContain("Attached: Acme proposal.pdf, pricing.xlsx.");
    expect(w.files.calls).toEqual(["files.download:F1", "files.download:F2"]);
    expect(failedChecks(r!)).toEqual([]);
    expect(r!.checks.some((c) => c.name === "draft attachments current" && c.ok)).toBe(true);
    expect(card(r).attachments).toEqual(["Acme proposal.pdf", "pricing.xlsx"]);
  });

  it("shows the attachments on the Slack email card", async () => {
    const { blocks } = renderEmailCard("T", {
      state: "drafted",
      decision: "ask",
      reason: "r",
      draftId: "d",
      to: "a@b.com",
      subject: "s",
      body: "b",
      bodyToken: "t",
      attachments: ["deck *final*.pdf"],
    });
    const header = (blocks[0] as { text: { text: string } }).text.text;
    expect(header).toMatch(/\*Attachments:\* deck .*final.*\.pdf/);
  });

  it("accepts a mention whose only content is a file", async () => {
    const w = await createWorld();
    await w.say(V1);
    const deck = file(w, "F9", "deck.pdf");
    const r = await w.say({ text: "", facts: BASE_FACTS }, { ts: REPLY_TS, threadTs: w.ROOT_TS, files: [deck] });
    expect(r?.status).toBe("completed");
    expect((await w.draft())!.attachments?.map((a) => a.name)).toEqual(["deck.pdf"]);
    expect(w.mail.createdTotal).toBe(1);
  });

  it("does not track attachments at all for an instruction that never had files", async () => {
    const w = await createWorld();
    const r = await w.instruct(V1);
    expect((await w.draft())!.attachments).toBeUndefined();
    expect(r.checks.some((c) => c.name === "draft attachments current")).toBe(false);
    expect(compile({ company: { key: "company", value: "Acme", source: "Acme" }, contact_email: { key: "contact_email", value: "p@a.com", source: "p@a.com" } } as never).draft.fields.map((f) => f.field)).toEqual(["to", "subject", "body"]);
  });

  it("never creates a draft missing the files when one can't be downloaded", async () => {
    const w = await createWorld();
    const gone: FileRef = { id: "F404", name: "deleted.pdf", mimeType: "application/pdf", size: 10 };
    const r = await w.say(V1, { files: [gone] });
    expect(w.mail.createdTotal).toBe(0);
    expect(r!.status).not.toBe("completed");
    expect(r!.outcomes.some((o) => o.resource === "draft" && o.kind === "failed") || r!.notes.some((n) => /deleted\.pdf/.test(n))).toBe(true);
    expect((await w.thread()).completedVersion ?? 0).toBe(0);
    // The HubSpot side is unaffected by the email's problem.
    expect(w.crm.deals.size).toBe(1);
  });

  it("retries a transient download failure instead of failing the draft", async () => {
    const w = await createWorld();
    const deck = file(w, "F1", "deck.pdf");
    w.files.faults.inject("files.download", "transient", "transient");
    const r = await w.say(V1, { files: [deck] });
    expect(failedChecks(r!)).toEqual([]);
    expect((await w.draft())!.attachments).toHaveLength(1);
  });

  it("refuses files over Gmail's 25 MB limit before downloading anything", async () => {
    const w = await createWorld();
    const huge: FileRef = { id: "BIG", name: "video.mov", mimeType: "video/quicktime", size: MAX_ATTACHMENT_BYTES + 1 };
    const r = await w.say(V1, { files: [huge] });
    expect(w.files.calls).toEqual([]);
    expect(w.mail.createdTotal).toBe(0);
    expect(JSON.stringify(r)).toContain("25 MB");
  });
});

describe("attachments when the instruction changes", () => {
  it("adds a file shared in a thread reply to the same draft, not a new one", async () => {
    const w = await createWorld();
    const deck = file(w, "F1", "deck.pdf");
    await w.say(V1, { files: [deck] });
    const draftId = (await w.thread()).draftId;

    const msa = file(w, "F2", "msa.pdf");
    const r = await w.say({ text: "also attach the MSA", facts: BASE_FACTS, composedFacts: BASE_FACTS }, { ts: REPLY_TS, threadTs: w.ROOT_TS, files: [msa] });

    expect((await w.thread()).draftId).toBe(draftId);
    expect(w.mail.createdTotal).toBe(1);
    expect((await w.draft())!.attachments?.map((a) => a.name)).toEqual(["deck.pdf", "msa.pdf"]);
    expect(r!.outcomes.find((o) => o.field === "attachments")?.kind).toBe("updated");
    expect(failedChecks(r!)).toEqual([]);
    // The deal had nothing to do with the file.
    expect(r!.outcomes.filter((o) => o.resource === "deal" && o.kind === "updated")).toEqual([]);
  });

  it("keeps the files on the draft when only a fact changes, without downloading them again", async () => {
    const w = await createWorld();
    const deck = file(w, "F1", "deck.pdf");
    await w.instruct(V1, undefined, [deck]);
    const downloads = w.files.calls.length;

    const r = await w.instruct(AMOUNT_50K, undefined, [deck]);
    const draft = (await w.draft())!;
    expect(draft.body).toContain("$50,000");
    expect(draft.attachments?.map((a) => a.name)).toEqual(["deck.pdf"]);
    expect(w.files.calls.length).toBe(downloads);
    expect(failedChecks(r)).toEqual([]);
  });

  it("removes the file from the draft when the message is edited to drop it", async () => {
    const w = await createWorld();
    const deck = file(w, "F1", "deck.pdf");
    await w.say(V1, { files: [deck] });
    const r = await w.say(V1, { edited: true, files: [] });
    expect((await w.draft())!.attachments ?? []).toEqual([]);
    expect(failedChecks(r!)).toEqual([]);
  });

  it("does not put back an attachment a person removed in Gmail", async () => {
    const w = await createWorld();
    const deck = file(w, "F1", "deck.pdf");
    await w.instruct(V1, undefined, [deck]);
    const draftId = (await w.thread()).draftId!;
    w.mail.humanEdit(draftId, { attachments: [] });

    const r = await w.instruct(AMOUNT_50K, undefined, [deck]);
    const draft = (await w.draft())!;
    expect(draft.body).toContain("$50,000");
    expect(draft.attachments).toEqual([]);
    expect(r.outcomes.find((o) => o.field === "attachments")?.kind).toBe("human_edit_preserved");
  });

  it("raises a conflict when a person removed a file in Gmail and the instruction then adds another", async () => {
    const w = await createWorld();
    const deck = file(w, "F1", "deck.pdf");
    await w.say(V1, { files: [deck] });
    w.mail.humanEdit((await w.thread()).draftId!, { attachments: [] });
    const msa = file(w, "F2", "msa.pdf");
    const r = await w.say({ text: "attach the MSA too", facts: BASE_FACTS, composedFacts: BASE_FACTS }, { ts: REPLY_TS, threadTs: w.ROOT_TS, files: [msa] });
    expect(r!.outcomes.find((o) => o.field === "attachments")?.kind).toBe("conflict");
    expect((await w.draft())!.attachments).toEqual([]);
  });

  it("sends the files when the user asks to send", async () => {
    const w = await createWorld();
    const deck = file(w, "F1", "deck.pdf");
    const r = await w.instruct(SEND_NOW, undefined, [deck]);
    expect(card(r).decision).toBe("auto_sent");
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0].attachments?.map((a) => a.name)).toEqual(["deck.pdf"]);
  });

  it("refuses a Send click when the attachments changed after the preview", async () => {
    const w = await createWorld();
    const deck = file(w, "F1", "deck.pdf");
    const r = await w.instruct(V1, undefined, [deck]);
    const shown = card(r);
    w.mail.humanEdit(shown.draftId, { attachments: [] });
    const res = await w.engine.approveSend({ threadKey: w.THREAD, draftId: shown.draftId, bodyToken: shown.bodyToken });
    expect(res.ok).toBe(false);
    expect(w.mail.sent).toHaveLength(0);
  });

  it("attaches a file added after the email went out to the threaded correction", async () => {
    const w = await createWorld();
    const deck = file(w, "F1", "deck.pdf");
    await w.say(V1, { files: [deck] });
    w.mail.humanSend((await w.thread()).draftId!);

    const msa = file(w, "F2", "msa.pdf");
    const r = await w.say({ text: "forgot the MSA", facts: BASE_FACTS, composedFacts: BASE_FACTS }, { ts: REPLY_TS, threadTs: w.ROOT_TS, files: [msa] });
    const correction = (await w.draft())!;
    expect(correction.inReplyTo).toBeDefined();
    expect(correction.attachments?.map((a) => a.name)).toEqual(["deck.pdf", "msa.pdf"]);
    expect(failedChecks(r!)).toEqual([]);
  });

  it("lets a generated email say files are attached only when they really are", async () => {
    const said = "Hi Priya,\n\nI've attached the proposal: $42,000, closing October 15, 2026.\n\nBest regards";
    const seen: EmailRequest[] = [];
    const writer: EmailWriter = { write: async (req) => (seen.push(req), said) };
    const w = await createWorld({ writer });
    await w.instruct(V1, undefined, [file(w, "F1", "proposal.pdf")]);
    expect((await w.draft())!.body).toBe(said);
    expect(seen[0].attachments).toEqual(["proposal.pdf"]);
  });
});

describe("attachment plumbing", () => {
  it("gives the same token regardless of file order and a distinct one for no files", () => {
    const a = { name: "a.pdf", mimeType: "x", size: 1 };
    const b = { name: "b.pdf", mimeType: "x", size: 2 };
    expect(attachmentsToken([a, b])).toBe(attachmentsToken([b, a]));
    expect(attachmentsToken([])).toBe("none");
    expect(attachmentsToken(undefined)).toBe("none");
    expect(attachmentsToken([{ ...a, size: 3 }])).not.toBe(attachmentsToken([a]));
  });

  it("makes adding a file a new version of the instruction and dedupes a file shared twice", () => {
    const f: FileRef = { id: "F1", name: "x [v2].pdf", mimeType: "application/pdf", size: 3 };
    const plain = composeInstruction([{ ts: "1", text: "hi" }]);
    const withFile = composeInstruction([{ ts: "1", text: "hi", files: [f] }]);
    expect(withFile).not.toBe(plain);
    expect(withFile).toContain("(F1)");
    expect(withFile).not.toContain("[v2]");
    expect(instructionFiles({ parts: [{ ts: "2", text: "b", files: [f] }, { ts: "1", text: "a", files: [f] }] })).toEqual([f]);
  });

  it("builds a multipart message whose text part is the body and whose filenames can't inject headers", () => {
    const mime = buildMime({
      to: "p@acme.com",
      subject: "Proposal",
      body: "Hello",
      attachments: [{ name: 'evil".pdf\r\nBcc: x@evil.com', mimeType: "application/pdf", size: 3, data: Buffer.from("PDF") }],
    });
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="amend_[0-9a-f]+"/);
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(mime).toContain(`filename="evil_.pdf Bcc: x@evil.com"`);
    expect(mime).toContain(Buffer.from("PDF").toString("base64"));
    expect(mime).toContain(Buffer.from("Hello").toString("base64"));
    expect(mime.trimEnd().endsWith("--")).toBe(true);
  });

  it("keeps the plain single-part message when there are no files", () => {
    const mime = buildMime({ to: "p@acme.com", subject: "s", body: "Hello", attachments: [] });
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).not.toContain("multipart");
  });

  it("reads the body from the text part, not from an attached .txt file", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", filename: "notes.txt", body: { data: Buffer.from("attached notes").toString("base64url"), size: 14 } },
        { mimeType: "text/plain", filename: "", body: { data: Buffer.from("real body").toString("base64url"), size: 9 } },
        { mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "att1", size: 1234 } },
      ],
    };
    expect(Buffer.from(findTextPlain(payload)!.body!.data!, "base64url").toString()).toBe("real body");
    expect(attachmentParts(payload).map((p) => [p.name, p.size, p.attachmentId])).toEqual([
      ["notes.txt", 14, undefined],
      ["deck.pdf", 1234, "att1"],
    ]);
  });

  it("accepts a Slack file_share message, including one with no text, and skips deleted files", () => {
    const ev: RawMessage = {
      type: "message",
      subtype: "file_share",
      ts: "1.2",
      text: "",
      user: "U1",
      files: [
        { id: "F1", name: "deck.pdf", mimetype: "application/pdf", size: 10 },
        { id: "F2", mode: "tombstone" },
        { id: "F3", name: "link", mode: "external", size: 0 },
      ],
    };
    const sel = selectMessage(ev);
    expect(sel).not.toBeNull();
    expect(messageFiles(sel!.msg)).toEqual([{ id: "F1", name: "deck.pdf", mimeType: "application/pdf", size: 10 }]);
    expect(selectMessage({ ...ev, files: [{ id: "F2", mode: "tombstone" }] })).toBeNull();
  });
});
