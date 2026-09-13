/**
 * Adversarial tests for the reconciliation engine (src/engine/engine.ts + src/core/reconcile.ts).
 *
 * Every test drives the real engine through test/helpers/world.ts. Tests marked `// BUG:` assert the
 * behavior the system promises (README / docs/reliability-brief.md) and currently fail.
 */
import { describe, expect, it } from "vitest";
import { BASE_FACTS, V1, createWorld, editOf, type Msg } from "../helpers/world.js";
import type { EmailRequest, EmailWriter } from "../../src/llm/draft-email.js";
import type { DealField } from "../../src/adapters/types.js";
import type { FieldOutcome, RunReport } from "../../src/engine/engine.js";

// ---------------------------------------------------------------- fixtures

/** $42k → $50k, nothing else. */
const amount50k = (): Msg => editOf([["$42k", "$50k"]], { deal_amount: ["50000", "$50k"] });
/** $42k → $55k. */
const amount55k = (): Msg => editOf([["$42k", "$55k"]], { deal_amount: ["55000", "$55k"] });
/** Oct 15 → Nov 3, amount untouched. */
const dateNov3 = (): Msg => editOf([["Oct 15", "Nov 3"]], { close_date: ["2026-11-03", "Nov 3"] });
/** $50k *and* Nov 3 in one edit. */
const amount50kDateNov3 = (): Msg =>
  editOf([["$42k", "$50k"], ["Oct 15", "Nov 3"]], { deal_amount: ["50000", "$50k"], close_date: ["2026-11-03", "Nov 3"] });
/** Only the deal stage moves: no draft field depends on it. */
const stageOnly = (): Msg =>
  editOf([["contract sent", "decision maker bought in"]], { deal_stage: ["decisionmakerboughtin", "decision maker bought in"] });
/** 10% discount added (net $37,800). */
const withDiscount = (): Msg =>
  editOf([["Deal is $42k", "Deal is $42k with a 10% discount"]], { discount_pct: ["10", "10%"] });
/** The "next step" sentence is deleted from the message. */
const noNextStep = (): Msg => editOf([[" Next step: legal review.", ""]], {}, ["next_step"]);
/** The contact's email address is deleted from the message. */
const noContactEmail = (): Msg => editOf([[" (priya@acme.com)", ""]], {}, ["contact_email"]);
/** Same facts, different words. */
const rewordedSameFacts = (): Msg =>
  editOf([["is ready to move forward", "is all set and ready to move forward"]], {});
const cancel = (): Msg => ({ text: `${V1.text} UPDATE: deal is cancelled.`, facts: { ...BASE_FACTS, cancelled: ["true", "deal is cancelled"] } });
const sendNow = (): Msg => ({ text: `${V1.text} Go ahead and email it to her now.`, facts: { ...BASE_FACTS, delivery: ["send", "Go ahead and email it to her now"] } });

// ---------------------------------------------------------------- helpers

const MUTATING = /^(crm\.(create|update)|mail\.(create|update|delete|send))$/;
const mutations = (calls: string[]) => calls.filter((c) => MUTATING.test(c));

type World = Awaited<ReturnType<typeof createWorld>>;
const openConflicts = async (w: World) => (await w.store.listConflicts(w.THREAD)).filter((c) => c.status === "open");
const outcome = (r: Pick<RunReport, "outcomes">, resource: string, field: string): FieldOutcome | undefined =>
  r.outcomes.find((o) => o.resource === resource && o.field === field);
const failedChecks = (r: { checks: Array<{ ok: boolean; name: string; detail?: string }> }) =>
  r.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
const dealField = async (w: World, f: DealField) => (await w.deal())?.fields[f];

/** A writer whose output is fully controlled by the test. */
const writerOf = (fn: (req: EmailRequest) => Promise<string> | string): EmailWriter => ({ write: async (req) => fn(req) });

// ---------------------------------------------------------------- reconcile decision branches

describe("reconcile decision branches, driven through the engine", () => {
  it("create: records a per-field reconciliation base for every deal field it wrote", async () => {
    const w = await createWorld();
    const r = await w.instruct(V1);
    expect(r.status).toBe("completed");
    const ledger = await w.store.listLedger(w.THREAD);
    const creates = ledger.filter((e) => e.resource === "deal" && e.field === "*" && e.action === "create" && e.status === "applied");
    expect(creates).toHaveLength(1);
    for (const f of ["dealname", "amount", "closedate", "dealstage", "hs_next_step"] as DealField[]) {
      const base = await w.store.ledgerBase(w.THREAD, "deal", f);
      expect(base?.observedToken, `base for deal.${f}`).toBe((await w.deal())!.fields[f]);
    }
    for (const f of ["to", "subject", "body"]) {
      expect((await w.store.ledgerBase(w.THREAD, "draft", f))?.status, `base for draft.${f}`).toBe("applied");
    }
    expect(failedChecks(r)).toEqual([]);
  });

  it("noop_unchanged: rewording the message with identical facts performs zero writes", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const crmBefore = mutations(w.crm.calls).length;
    const mailBefore = mutations(w.mail.calls).length;

    const r = await w.instruct(rewordedSameFacts());
    expect(r.status).toBe("completed");
    expect(r.writes).toBe(0);
    expect(mutations(w.crm.calls).length).toBe(crmBefore);
    expect(mutations(w.mail.calls).length).toBe(mailBefore);
    expect(r.outcomes.filter((o) => o.kind === "unchanged").length).toBeGreaterThan(0);
    expect(failedChecks(r)).toEqual([]);
  });

  it("noop_already: a human who set exactly the value the new instruction wants causes no write and no conflict", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "50000" });

    const r = await w.instruct(amount50k());
    expect(outcome(r, "deal", "amount")?.kind).toBe("already_correct");
    expect(w.crm.calls.filter((c) => c === "crm.update")).toHaveLength(0);
    expect(await openConflicts(w)).toHaveLength(0);
    expect(await dealField(w, "amount")).toBe("50000");
    // the base must have moved to the new spec, so the next run is a plain no-op
    const r2 = await w.instruct(editOf([["$42k", "$50k"], ["is ready", "is now ready"]], { deal_amount: ["50000", "$50k"] }));
    expect(r2.writes).toBe(0);
    expect(failedChecks(r2)).toEqual([]);
  });

  it("preserve_human: an unrelated human field survives an amount edit, and only one field is written", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { hs_next_step: "security questionnaire" });

    const r = await w.instruct(amount50k());
    expect(outcome(r, "deal", "hs_next_step")?.kind).toBe("human_edit_preserved");
    expect(await dealField(w, "hs_next_step")).toBe("security questionnaire");
    expect(await dealField(w, "amount")).toBe("50000");
    expect(r.writes).toBe(2); // one crm.update + one mail.update
    expect(mutations(w.crm.calls).filter((c) => c === "crm.update")).toHaveLength(1);
    expect(failedChecks(r)).toEqual([]);
  });

  it("human edits several fields at once: one conflicts, the untouched-by-spec one is preserved", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000", hs_next_step: "security questionnaire" });

    const r = await w.instruct(amount50k());
    expect(outcome(r, "deal", "amount")?.kind).toBe("conflict");
    expect(outcome(r, "deal", "hs_next_step")?.kind).toBe("human_edit_preserved");
    expect(await dealField(w, "amount")).toBe("45000");
    expect(await dealField(w, "hs_next_step")).toBe("security questionnaire");
    expect(r.status).toBe("needs_attention");
    expect(await openConflicts(w)).toHaveLength(1);
  });

  it("conflict on one field while another field applies: the email is held, the CRM date still moves", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000" });

    const r = await w.instruct(amount50kDateNov3());
    expect(outcome(r, "deal", "amount")?.kind).toBe("conflict");
    expect(outcome(r, "deal", "closedate")?.kind).toBe("updated");
    expect(outcome(r, "draft", "body")?.kind).toBe("held");
    expect(await dealField(w, "closedate")).toBe("2026-11-03");
    expect(await dealField(w, "amount")).toBe("45000");
    // the held email must still state the last agreed numbers, not the contested one
    const draft = await w.draft();
    expect(draft?.body).toContain("$42,000");
    expect(draft?.body).not.toContain("$50,000");
    expect(r.status).toBe("needs_attention");
  });

  it("apply_new resolution converges the CRM and the previously held email in one run", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000" });
    await w.instruct(amount50k());
    const c = (await openConflicts(w))[0]!;

    const r = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "apply_new" });
    expect(r.status).toBe("completed");
    expect(await dealField(w, "amount")).toBe("50000");
    expect((await w.draft())?.body).toContain("$50,000");
    expect((await w.draft())?.body).not.toContain("$42,000");
    expect(await openConflicts(w)).toHaveLength(0);
    expect(failedChecks(r)).toEqual([]);
  });

  it("keep_human resolution accepts the human value and does not re-ask on the next unrelated edit", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000" });
    await w.instruct(amount50k());
    const c = (await openConflicts(w))[0]!;
    const r = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "keep_human" });
    expect(outcome(r, "deal", "amount")?.kind).toBe("human_edit_accepted");
    expect(await dealField(w, "amount")).toBe("45000");

    const r2 = await w.instruct(amount50kDateNov3());
    expect(await dealField(w, "amount")).toBe("45000");
    expect(await dealField(w, "closedate")).toBe("2026-11-03");
    expect(await openConflicts(w)).toHaveLength(0);
    expect(failedChecks(r2)).toEqual([]);
  });
});

// ---------------------------------------------------------------- conflict binding & resolution

describe("conflict binding and resolution", () => {
  it("rejects an unknown conflict id instead of silently re-running", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    await expect(w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: "nope", choice: "apply_new" })).rejects.toThrow(/unknown conflict/);
  });

  it("a decision is not applied to a value the user never saw (stale decision after a further Slack edit)", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000" });
    await w.instruct(amount50k());
    const stale = (await openConflicts(w))[0]!;
    // The lead edits Slack again before clicking: the decision was about $50k, the instruction now says $55k.
    await w.instruct(amount55k());

    const r = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: stale.id, choice: "apply_new" });
    expect(await dealField(w, "amount")).toBe("45000"); // no silent write of a value nobody approved
    expect(outcome(r, "deal", "amount")?.kind).toBe("conflict");
    expect(r.status).toBe("needs_attention");
  });

  // BUG: a conflict raised for an older instruction value is never closed, so the thread keeps an
  // un-actionable open conflict forever, which permanently blocks auto-send and the Send button.
  it("resolving the current conflict leaves no stale open conflict behind", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000" });
    await w.instruct(amount50k()); // conflict A (spec $50k)
    await w.instruct(amount55k()); // conflict B (spec $55k) — A is now meaningless
    const current = (await openConflicts(w)).find((c) => c.desired === "55000")!;

    await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: current.id, choice: "apply_new" });
    expect(await dealField(w, "amount")).toBe("55000");
    expect(await openConflicts(w)).toHaveLength(0);
  });

  // BUG: the second, newest explicit decision by a person is silently discarded (resolveConflict only
  // stores a choice while status === "open"). Both buttons stay clickable in Slack, the click returns a
  // normal receipt, and nothing tells the user their choice was ignored. Either the newest decision must
  // win (asserted here) or the click must say it was refused; silently doing neither is the defect.
  it("clicking the other button after a decision applies the newest decision", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000" });
    await w.instruct(amount50k());
    const c = (await openConflicts(w))[0]!;

    await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "keep_human" });
    expect(await dealField(w, "amount")).toBe("45000");
    await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "apply_new" });
    expect(await dealField(w, "amount")).toBe("50000");
  });

  it("clicking the same button twice is idempotent", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000" });
    await w.instruct(amount50k());
    const c = (await openConflicts(w))[0]!;

    await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "apply_new" });
    const updates = w.crm.calls.filter((x) => x === "crm.update").length;
    const r = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "apply_new" });
    expect(w.crm.calls.filter((x) => x === "crm.update").length).toBe(updates);
    expect(await dealField(w, "amount")).toBe("50000");
    expect(r.status).toBe("completed");
  });

  it("a human who reverts to Amend's base before resolving gets the instruction applied cleanly", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const dealId = (await w.thread()).dealId!;
    w.crm.humanEdit(dealId, { amount: "45000" });
    await w.instruct(amount50k());
    const c = (await openConflicts(w))[0]!;
    w.crm.humanEdit(dealId, { amount: "42000" }); // rep undoes their own change

    const r = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "keep_human" });
    // "keep human" was about $45k, which no longer exists: the instruction wins and nothing is lost.
    expect(await dealField(w, "amount")).toBe("50000");
    expect(r.status).toBe("completed");
    expect(failedChecks(r)).toEqual([]);
  });

  // BUG: after "keep human edit", a human who later moves the field to exactly the instruction's value
  // (everything now agrees) makes verification fail forever: the run is never marked complete and Amend
  // keeps retrying / reporting needs_attention on a perfectly consistent state.
  it("keep_human then the human adopts Amend's value: the run completes", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const dealId = (await w.thread()).dealId!;
    w.crm.humanEdit(dealId, { amount: "45000" });
    await w.instruct(amount50k());
    await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: (await openConflicts(w))[0]!.id, choice: "keep_human" });
    w.crm.humanEdit(dealId, { amount: "50000" }); // rep changes their mind, matches the instruction

    const r = await w.instruct(amount50kDateNov3());
    expect(await dealField(w, "amount")).toBe("50000");
    expect(failedChecks(r)).toEqual([]);
    expect(r.status).toBe("completed");
    expect((await w.thread()).completedVersion).toBe(3);
  });

  it("two conflicting fields: resolving one leaves the other open and untouched", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000", closedate: "2026-12-01" });
    await w.instruct(amount50kDateNov3());
    expect(await openConflicts(w)).toHaveLength(2);

    const amountConflict = (await openConflicts(w)).find((c) => c.field === "amount")!;
    const r = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: amountConflict.id, choice: "apply_new" });
    expect(await dealField(w, "amount")).toBe("50000");
    expect(await dealField(w, "closedate")).toBe("2026-12-01");
    expect((await openConflicts(w)).map((c) => c.field)).toEqual(["closedate"]);
    expect(r.status).toBe("needs_attention");
  });

  // BUG: the email change is held during a conflict so "apps don't disagree" (README), but choosing
  // "keep human edit" releases the hold and writes the instruction's number into the customer email,
  // leaving HubSpot at $45,000 and the email promising $50,000.
  it("keep_human does not leave the email contradicting HubSpot", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000" });
    await w.instruct(amount50k());
    await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: (await openConflicts(w))[0]!.id, choice: "keep_human" });

    expect(await dealField(w, "amount")).toBe("45000");
    expect((await w.draft())?.body).not.toContain("$50,000");
  });
});

// ---------------------------------------------------------------- cleared fields (facts removed)

describe("fields cleared because their facts disappeared", () => {
  it("deleting the next-step sentence clears the HubSpot field and drops it from the email", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const r = await w.instruct(noNextStep());
    expect(await dealField(w, "hs_next_step")).toBeNull();
    expect((await w.draft())?.body).not.toContain("legal review");
    expect(outcome(r, "deal", "hs_next_step")?.kind).toBe("updated");
    expect(r.status).toBe("completed");
    expect(failedChecks(r)).toEqual([]);
  });

  it("clearing a field a human just edited raises a conflict instead of wiping their value", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { hs_next_step: "security questionnaire" });

    const r = await w.instruct(noNextStep());
    expect(outcome(r, "deal", "hs_next_step")?.kind).toBe("conflict");
    expect(await dealField(w, "hs_next_step")).toBe("security questionnaire");
    expect(r.status).toBe("needs_attention");

    const c = (await openConflicts(w))[0]!;
    const r2 = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "apply_new" });
    expect(await dealField(w, "hs_next_step")).toBeNull();
    expect(r2.status).toBe("completed");
    expect(failedChecks(r2)).toEqual([]);
  });

  it("a cleared field is not re-cleared (and not rewritten) on later runs", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    await w.instruct(noNextStep());
    const updates = w.crm.calls.filter((c) => c === "crm.update").length;

    const r = await w.instruct(editOf([[" Next step: legal review.", ""], ["Oct 15", "Nov 3"]], { close_date: ["2026-11-03", "Nov 3"] }, ["next_step"]));
    expect(w.crm.calls.filter((c) => c === "crm.update").length).toBe(updates + 1); // just the date
    expect(await dealField(w, "hs_next_step")).toBeNull();
    expect(failedChecks(r)).toEqual([]);
  });

  it("discount added then removed puts the amount back and leaves no stale number in the email", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    await w.instruct(withDiscount());
    expect(await dealField(w, "amount")).toBe("37800");
    expect((await w.draft())?.body).toContain("$37,800");

    const r = await w.instruct(V1); // discount sentence removed again
    expect(await dealField(w, "amount")).toBe("42000");
    const body = (await w.draft())!.body;
    expect(body).toContain("$42,000");
    expect(body).not.toContain("$37,800");
    expect(body).not.toContain("10%");
    expect(failedChecks(r)).toEqual([]);
  });

  it("dropping the company asks a clarification and writes nothing at all", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const crmBefore = mutations(w.crm.calls).length;
    const mailBefore = mutations(w.mail.calls).length;

    const r = await w.instruct(editOf([["Acme Corp is ready", "They are ready"]], {}, ["company"]));
    expect(r.status).toBe("clarification");
    expect(r.clarifications.length).toBeGreaterThan(0);
    expect(r.writes).toBe(0);
    expect(mutations(w.crm.calls).length).toBe(crmBefore);
    expect(mutations(w.mail.calls).length).toBe(mailBefore);
    expect(await dealField(w, "dealname")).toBe("Acme Corp");
    expect((await w.draft())?.subject).toBe("Proposal for Acme Corp");
  });

  it("a field Amend never managed is applied from the instruction and the overwritten value is reported", async () => {
    const w = await createWorld();
    await w.instruct(noNextStep()); // Amend never writes hs_next_step
    w.crm.humanEdit((await w.thread()).dealId!, { hs_next_step: "security questionnaire" });

    const r = await w.instruct(V1); // the sentence comes back
    expect(await dealField(w, "hs_next_step")).toBe("legal review");
    const o = outcome(r, "deal", "hs_next_step")!;
    expect(o.kind).toBe("updated");
    expect(o.before).toBe("security questionnaire"); // the receipt shows what was replaced
  });
});

// ---------------------------------------------------------------- draft lifecycle

describe("draft lifecycle", () => {
  it("cancelling deletes the unsent draft and moves the stage", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const r = await w.instruct(cancel());
    expect(await dealField(w, "dealstage")).toBe("closedlost");
    expect(w.mail.drafts.size).toBe(0);
    expect((await w.thread()).draftId).toBeUndefined();
    expect(r.status).toBe("completed");
    expect(failedChecks(r)).toEqual([]);
  });

  // BUG: un-cancelling never restores the email. createDraft's idempotency key for a fresh draft is
  // `draft:<thread>:create:new:replacing:none`, which is still marked applied from the first create, so
  // the create is skipped ("Skipped duplicate draft creation"), the draft never comes back, and the run
  // fails its own "Gmail draft exists" check forever.
  it("cancel then un-cancel recreates the draft", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    await w.instruct(cancel());
    const r = await w.instruct(V1); // "actually it's back on"

    expect(await dealField(w, "dealstage")).toBe("contractsent");
    expect(await w.draft()).toBeDefined();
    expect((await w.draft())?.body).toContain("$42,000");
    expect(failedChecks(r)).toEqual([]);
    expect(r.status).toBe("completed");
  });

  // BUG: same root cause as cancel/un-cancel — removing the contact email deletes the draft, and putting
  // the address back never recreates it.
  it("contact email removed then restored brings the draft back", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const r1 = await w.instruct(noContactEmail());
    expect(w.mail.drafts.size).toBe(0); // no recipient => no draft
    expect(r1.status).toBe("completed");

    const r2 = await w.instruct(V1);
    expect(await w.draft()).toBeDefined();
    expect((await w.draft())?.to).toBe("priya@acme.com");
    expect(failedChecks(r2)).toEqual([]);
  });

  // BUG: Amend deliberately leaves a human-deleted draft deleted ("human_edit_preserved"), but it keeps
  // thread.draftId pointing at the dead draft, so verify() then reports "Gmail draft exists = false".
  // The run is marked needs_attention and retried up to 5 times over a state Amend chose on purpose.
  it("a human-deleted draft that the instruction does not touch leaves the run completed", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.mail.humanDelete((await w.thread()).draftId!);

    const r = await w.instruct(stageOnly()); // no draft field depends on deal_stage
    expect(outcome(r, "draft", "*")?.kind).toBe("human_edit_preserved");
    expect(await dealField(w, "dealstage")).toBe("decisionmakerboughtin");
    expect(failedChecks(r)).toEqual([]);
    expect(r.status).toBe("completed");
    expect((await w.thread()).retry).toBeUndefined();
  });

  it("a human-deleted draft plus a cancellation is a clean no-op", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.mail.humanDelete((await w.thread()).draftId!);

    const r = await w.instruct(cancel());
    expect(await dealField(w, "dealstage")).toBe("closedlost");
    expect(w.mail.drafts.size).toBe(0);
    expect(await openConflicts(w)).toHaveLength(0);
    expect(failedChecks(r)).toEqual([]);
    expect(r.status).toBe("completed");
  });

  it("a human-deleted draft plus a draft-affecting edit asks before recreating, and keep_human leaves it deleted", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.mail.humanDelete((await w.thread()).draftId!);
    const r = await w.instruct(amount50k());
    expect(outcome(r, "draft", "*")?.kind).toBe("conflict");
    expect(w.mail.createdTotal).toBe(1);

    const c = (await openConflicts(w)).find((x) => x.resource === "draft")!;
    await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "keep_human" });
    expect(w.mail.createdTotal).toBe(1);
    expect(w.mail.drafts.size).toBe(0);
    expect(await openConflicts(w)).toHaveLength(0);
  });

  it("a human who rewrites the recipient in Gmail is asked before the contact edit overwrites it", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.mail.humanEdit((await w.thread()).draftId!, { to: "assistant@acme.com" });

    const r = await w.instruct(editOf([["Priya Shah (priya@acme.com)", "Marcus Lee (marcus@acme.com)"]], { contact_name: "Marcus Lee", contact_email: "marcus@acme.com" }));
    expect(outcome(r, "draft", "to")?.kind).toBe("conflict");
    expect((await w.draft())?.to).toBe("assistant@acme.com");

    const c = (await openConflicts(w)).find((x) => x.resource === "draft" && x.field === "to")!;
    const r2 = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "apply_new" });
    expect((await w.draft())?.to).toBe("marcus@acme.com");
    expect(failedChecks(r2)).toEqual([]);
  });

  it("a human recipient change that the instruction does not touch is preserved, and the body still updates", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.mail.humanEdit((await w.thread()).draftId!, { to: "assistant@acme.com" });

    const r = await w.instruct(amount50k());
    expect(outcome(r, "draft", "to")?.kind).toBe("human_edit_preserved");
    expect((await w.draft())?.to).toBe("assistant@acme.com");
    expect((await w.draft())?.body).toContain("$50,000");
    expect(failedChecks(r)).toEqual([]);
  });

  it("a human-edited subject conflicts when the company changes; the body still follows the CRM", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.mail.humanEdit((await w.thread()).draftId!, { subject: "Our proposal (v2)" });

    const r = await w.instruct(editOf([["Acme Corp", "Acme Industries"]], { company: "Acme Industries" }));
    expect(outcome(r, "draft", "subject")?.kind).toBe("conflict");
    expect((await w.draft())?.subject).toBe("Our proposal (v2)"); // their wording is not clobbered
    // Only draft.subject is contested; the hold exists to keep apps consistent, and HubSpot did take the
    // new company, so the body must state it too.
    expect(outcome(r, "draft", "body")?.kind).toBe("updated");
    expect(await dealField(w, "dealname")).toBe("Acme Industries");
    expect((await w.draft())?.body).toContain("Acme Industries");
    expect(r.status).toBe("needs_attention");
    expect(failedChecks(r)).toEqual([]);

    const c = (await openConflicts(w)).find((x) => x.resource === "draft" && x.field === "subject")!;
    const r2 = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "apply_new" });
    expect((await w.draft())?.subject).toBe("Proposal for Acme Industries");
    expect(failedChecks(r2)).toEqual([]);
  });

  it("a human-rewritten body conflicts, and keep_human preserves their words", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const personal = "Hi Priya, personal note from Sam. Total is $42,000. Best regards";
    w.mail.humanEdit((await w.thread()).draftId!, { body: personal });

    const r = await w.instruct(amount50k());
    expect(outcome(r, "draft", "body")?.kind).toBe("conflict");
    expect((await w.draft())?.body).toBe(personal);

    const c = (await openConflicts(w)).find((x) => x.resource === "draft" && x.field === "body")!;
    const r2 = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "keep_human" });
    expect((await w.draft())?.body).toBe(personal);
    expect(outcome(r2, "draft", "body")?.kind).toBe("human_edit_accepted");
    expect(await openConflicts(w)).toHaveLength(0);
    expect(failedChecks(r2)).toEqual([]);
  });

  it("apply_new on a rewritten body replaces it with the regenerated one", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.mail.humanEdit((await w.thread()).draftId!, { body: "Hi Priya, personal note from Sam. Total is $42,000. Best regards" });
    await w.instruct(amount50k());

    const c = (await openConflicts(w)).find((x) => x.resource === "draft" && x.field === "body")!;
    const r = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "apply_new" });
    const body = (await w.draft())!.body;
    expect(body).toContain("$50,000");
    expect(body).not.toContain("personal note from Sam");
    expect(failedChecks(r)).toEqual([]);
  });
});

// ---------------------------------------------------------------- body() generation + verification

describe("email body generation and its verification", () => {
  it("falls back to the template when the writer throws", async () => {
    const w = await createWorld({ writer: writerOf(() => { throw new Error("model exploded"); }) });
    const r = await w.instruct(V1);
    expect((await w.draft())?.body).toContain("$42,000");
    expect(r.notes.some((n) => /Email generation failed/.test(n))).toBe(true);
    expect(failedChecks(r)).toEqual([]);
  });

  it("falls back to the template when the writer returns empty text", async () => {
    const w = await createWorld({ writer: writerOf(() => "") });
    const r = await w.instruct(V1);
    const body = (await w.draft())!.body;
    expect(body).toContain("Priya");
    expect(body).toContain("$42,000");
    expect(body).toContain("October 15, 2026");
    expect(r.notes.some((n) => /failed fact verification/.test(n))).toBe(true);
    expect(failedChecks(r)).toEqual([]);
  });

  it("falls back to the template when the writer omits a required fact token", async () => {
    const w = await createWorld({ writer: writerOf(() => "Hi Priya,\n\nLet's get this over the line by October 15, 2026.\n\nBest regards") });
    const r = await w.instruct(V1);
    expect((await w.draft())?.body).toContain("$42,000");
    expect(r.notes.some((n) => /failed fact verification/.test(n))).toBe(true);
    expect(failedChecks(r)).toEqual([]);
  });

  it("falls back to the template when the writer keeps a stale number from the previous version", async () => {
    const w = await createWorld({
      writer: writerOf(() => "Hi Priya,\n\nThe total moves from $42,000 to $50,000, closing October 15, 2026.\n\nBest regards"),
    });
    await w.instruct(V1);
    const r = await w.instruct(amount50k());
    const body = (await w.draft())!.body;
    expect(body).toContain("$50,000");
    expect(body).not.toContain("$42,000");
    expect(r.notes.some((n) => /failed fact verification/.test(n))).toBe(true);
    expect(failedChecks(r)).toEqual([]);
  });

  it("falls back to the template when the writer claims a file is attached (drafts carry no attachments)", async () => {
    const w = await createWorld({
      writer: writerOf(() => "Hi Priya,\n\nI've attached the proposal: $42,000, closing October 15, 2026.\n\nBest regards"),
    });
    const r = await w.instruct(V1);
    const body = (await w.draft())!.body;
    expect(body).not.toMatch(/attach/i);
    expect(body).toContain("$42,000");
    expect(r.notes.some((n) => /failed fact verification/.test(n))).toBe(true);
  });

  it("keeps a generated body that states every current fact", async () => {
    const w = await createWorld({
      writer: writerOf(() => "Hi Priya,\n\nCustom prose: $42,000 total, closing October 15, 2026.\n\nBest regards"),
    });
    const r = await w.instruct(V1);
    expect((await w.draft())?.body).toContain("Custom prose");
    expect(r.notes.some((n) => /template/.test(n))).toBe(false);
    expect(failedChecks(r)).toEqual([]);
  });
});

// ---------------------------------------------------------------- failure, verification and retry semantics

describe("failed writes, read-back mismatches and retry semantics", () => {
  it("a hard write failure is reported, not marked complete, and scheduled for retry", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.updateDeal = async () => { throw new Error("boom"); };

    const r = await w.instruct(amount50k());
    expect(outcome(r, "deal", "amount")?.kind).toBe("failed");
    expect(r.status).toBe("needs_attention");
    expect(r.notes.some((n) => /Will retry automatically \(attempt 1 of 5\)/.test(n))).toBe(true);
    const t = await w.thread();
    expect(t.completedVersion).toBe(1);
    expect(t.retry).toMatchObject({ version: 2, attempts: 1 });
  });

  it("retries are counted per version and give up after MAX_RETRY_ATTEMPTS", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.updateDeal = async () => { throw new Error("boom"); };
    await w.instruct(amount50k());

    for (let i = 2; i <= 5; i++) {
      w.restart();
      const [report] = await w.engine.recover({ ignoreBackoff: true });
      expect(report, `recovery ${i}`).toBeDefined();
      expect((await w.thread()).retry?.attempts).toBe(i);
      expect(report!.notes.some((n) => /Retried after/.test(n))).toBe(true);
    }
    const last = await w.thread();
    expect(last.retry?.attempts).toBe(5);
    w.restart();
    expect(await w.engine.recover({ ignoreBackoff: true })).toEqual([]); // gave up, stays quiet
    expect((await w.thread()).completedVersion).toBe(1);
  });

  it("a successful retry clears the retry state and advances completedVersion", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const real = w.crm.updateDeal.bind(w.crm);
    w.crm.updateDeal = async () => { throw new Error("boom"); };
    await w.instruct(amount50k());
    w.crm.updateDeal = real;

    w.restart();
    const [r] = await w.engine.recover({ ignoreBackoff: true });
    expect(r?.status).toBe("completed");
    expect(await dealField(w, "amount")).toBe("50000");
    const t = await w.thread();
    expect(t.retry).toBeUndefined();
    expect(t.completedVersion).toBe(2);
  });

  it("a read-back mismatch fails the field instead of claiming success", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const real = w.crm.updateDeal.bind(w.crm);
    // The CRM normalizes the value it stores (HubSpot does this with currency and dates).
    w.crm.updateDeal = async (id: string, fields: Partial<Record<DealField, string>>) =>
      real(id, { ...fields, ...(fields.amount ? { amount: `${fields.amount}.00` } : {}) });

    const r = await w.instruct(amount50k());
    expect(outcome(r, "deal", "amount")?.kind).toBe("failed");
    expect(r.status).toBe("needs_attention");
    const entry = (await w.store.listLedger(w.THREAD)).find((e) => e.field === "amount" && e.version === 2)!;
    expect(entry.status).toBe("failed");
    expect(entry.error).toMatch(/read-back mismatch/);
    expect((await w.thread()).completedVersion).toBe(1);
  });

  // BUG: after a read-back mismatch, the value Amend wrote is in the app but not in the ledger, so the
  // promised automatic retry sees its own write as an out-of-band human edit and raises a conflict
  // (attributed to "INTEGRATION"). The run never converges and the deal is left at the normalized value
  // with an open conflict nobody can meaningfully answer.
  it("the automatic retry after a read-back mismatch converges instead of inventing a conflict", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const real = w.crm.updateDeal.bind(w.crm);
    w.crm.updateDeal = async (id: string, fields: Partial<Record<DealField, string>>) =>
      real(id, { ...fields, ...(fields.amount ? { amount: `${fields.amount}.00` } : {}) });
    await w.instruct(amount50k());
    w.crm.updateDeal = real; // the glitch is over

    w.restart();
    const [r] = await w.engine.recover({ ignoreBackoff: true });
    expect(await openConflicts(w)).toHaveLength(0);
    expect(await dealField(w, "amount")).toBe("50000");
    expect(r?.status).toBe("completed");
  });

  it("a deal deleted in HubSpot is never silently recreated", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const dealId = (await w.thread()).dealId!;
    w.crm.humanDelete(dealId);

    const r = await w.instruct(amount50k());
    expect(w.crm.deals.size).toBe(0);
    expect(outcome(r, "deal", "*")?.kind).toBe("conflict");
    expect(outcome(r, "deal", "*")?.note).toMatch(/deleted outside Amend/);
    expect(r.status).toBe("needs_attention");
    expect(r.checks.some((c) => c.name === "HubSpot deal exists" && !c.ok)).toBe(true);
    expect((await w.thread()).dealId).toBe(dealId); // still linked, waiting for a person
  });
});

// ---------------------------------------------------------------- accounting

describe("receipt accounting", () => {
  it("reported writes equal the mutating adapter calls across a whole conversation", async () => {
    const w = await createWorld();
    const reports = [
      await w.instruct(V1),
      await w.instruct(amount50k()),
      await w.instruct(amount50kDateNov3()),
      await w.instruct(
        editOf([["$42k", "$50k"], ["Oct 15", "Nov 3"], ["legal review", "security review"]], {
          deal_amount: ["50000", "$50k"],
          close_date: ["2026-11-03", "Nov 3"],
          next_step: "security review",
        }),
      ),
    ];
    const reported = reports.reduce((n, r) => n + r.writes, 0);
    expect(mutations(w.crm.calls).length + mutations(w.mail.calls).length).toBe(reported);
    expect(reports.every((r) => r.status === "completed")).toBe(true);
    expect(w.crm.deals.size).toBe(1);
    expect(w.mail.createdTotal).toBe(1);
  });

  it("a run that only conflicts performs no writes at all", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000" });
    const crmBefore = mutations(w.crm.calls).length;
    const mailBefore = mutations(w.mail.calls).length;

    const r = await w.instruct(amount50k());
    expect(r.writes).toBe(0);
    expect(mutations(w.crm.calls).length).toBe(crmBefore);
    expect(mutations(w.mail.calls).length).toBe(mailBefore);
  });

  it("an explicit send request stays blocked while a conflict is open and goes out once it is resolved", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "45000" });
    const blocked = await w.instruct({
      text: sendNow().text.replace("$42k", "$50k"),
      facts: { ...BASE_FACTS, deal_amount: ["50000", "$50k"], delivery: ["send", "Go ahead and email it to her now"] },
    });
    expect(blocked.email?.decision).toBe("blocked");
    expect(w.mail.sent).toHaveLength(0);

    const c = (await openConflicts(w))[0]!;
    const r = await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId: c.id, choice: "apply_new" });
    expect(r.email?.decision).toBe("auto_sent");
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]!.body).toContain("$50,000");
  });
});
