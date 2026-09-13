import { randomUUID } from "node:crypto";
import {
  DEAL_FIELDS,
  TransientError,
  type ChatAdapter,
  type CrmAdapter,
  type DealField,
  type DealSnapshot,
  type DraftContent,
  type DraftSnapshot,
  type FileRef,
  type FileSource,
  type MailAdapter,
} from "./types.js";

/** Queue of injected failures per operation name. */
export type Fault = "transient" | "lost_response" | "crash_after_commit";

/** Simulates the process dying mid-write: the change is committed but nothing after it runs. */
export class SimulatedCrash extends Error {
  fatal = true;
  constructor(op: string) {
    super(`simulated process crash after ${op}`);
  }
}

export class Faults {
  private queue = new Map<string, Fault[]>();
  inject(op: string, ...faults: Fault[]) {
    this.queue.set(op, [...(this.queue.get(op) ?? []), ...faults]);
  }
  take(op: string) {
    return this.queue.get(op)?.shift();
  }
}

interface FakeDeal {
  id: string;
  threadKey: string;
  fields: Record<DealField, string | null>;
  lastChangedBy: DealSnapshot["lastChangedBy"];
  modifiedAt: number;
}

export class FakeCrm implements CrmAdapter {
  deals = new Map<string, FakeDeal>();
  calls: string[] = [];
  constructor(public faults = new Faults()) {}

  private async gate(op: string, action: () => void = () => {}) {
    this.calls.push(op);
    const f = this.faults.take(op);
    if (f === "transient") throw new TransientError(`${op}: 429 rate limited`);
    action();
    if (f === "lost_response") throw new TransientError(`${op}: connection reset after commit`);
    if (f === "crash_after_commit") throw new SimulatedCrash(op);
  }

  private snap(d: FakeDeal): DealSnapshot {
    return structuredClone({ id: d.id, fields: d.fields, lastChangedBy: d.lastChangedBy });
  }

  async findDealByThreadKey(threadKey: string) {
    await this.gate("crm.find");
    const d = [...this.deals.values()].find((x) => x.threadKey === threadKey);
    return d ? this.snap(d) : null;
  }

  async createDeal(threadKey: string, fields: Partial<Record<DealField, string>>) {
    const d: FakeDeal = {
      id: `deal_${this.deals.size + 1}`,
      threadKey,
      fields: Object.fromEntries(DEAL_FIELDS.map((k) => [k, fields[k] ?? null])) as FakeDeal["fields"],
      lastChangedBy: Object.fromEntries(Object.keys(fields).map((k) => [k, { sourceType: "INTEGRATION" }])),
      modifiedAt: Date.now(),
    };
    await this.gate("crm.create", () => this.deals.set(d.id, d));
    return this.snap(d);
  }

  async findChangedSince(sinceMs: number) {
    await this.gate("crm.changedSince");
    return [...this.deals.values()].filter((d) => d.modifiedAt >= sinceMs).map((d) => ({ ...this.snap(d), threadKey: d.threadKey }));
  }

  async getDeal(id: string) {
    await this.gate("crm.get");
    const d = this.deals.get(id);
    return d ? this.snap(d) : null;
  }

  async updateDeal(id: string, fields: Partial<Record<DealField, string>>) {
    await this.gate("crm.update", () => {
      const d = this.deals.get(id);
      if (!d) throw new Error("404 deal not found");
      for (const [k, v] of Object.entries(fields)) {
        d.fields[k as DealField] = v || null;
        d.lastChangedBy[k as DealField] = { sourceType: "INTEGRATION" };
      }
      d.modifiedAt = Date.now();
    });
  }

  // ---- human actions (not part of the adapter contract)
  humanEdit(id: string, fields: Partial<Record<DealField, string>>, userId = "u_sam") {
    const d = this.deals.get(id)!;
    for (const [k, v] of Object.entries(fields)) {
      d.fields[k as DealField] = v ?? null;
      d.lastChangedBy[k as DealField] = { sourceType: "CRM_UI", userId, at: new Date().toISOString() };
    }
    d.modifiedAt = Date.now();
  }
  humanDelete(id: string) {
    this.deals.delete(id);
  }
}

/** Drafts keep attachment metadata only; the bytes are checked at write time. */
function metaOnly(content: DraftContent): DraftContent {
  const { attachments, ...rest } = content;
  if (attachments === undefined) return rest;
  if (attachments.some((a) => a.data && a.data.length !== a.size)) throw new Error("attachment bytes do not match their declared size");
  return { ...rest, attachments: attachments.map(({ name, mimeType, size }) => ({ name, mimeType, size })) };
}

export class FakeFiles implements FileSource {
  files = new Map<string, Buffer>();
  calls: string[] = [];
  constructor(public faults = new Faults()) {}
  add(id: string, content: string) {
    this.files.set(id, Buffer.from(content));
    return Buffer.byteLength(content);
  }
  async download(ref: FileRef) {
    this.calls.push(`files.download:${ref.id}`);
    if (this.faults.take("files.download") === "transient") throw new TransientError("files.download: 429 rate limited");
    const data = this.files.get(ref.id);
    if (!data) throw new Error(`file ${ref.name} is no longer available in Slack`);
    return data;
  }
}

export class FakeMail implements MailAdapter {
  drafts = new Map<string, DraftSnapshot & { createdAt: number }>();
  sent: Array<DraftSnapshot & { sentAt: number; threadId: string; rfcMessageId: string }> = [];
  createdTotal = 0;
  calls: string[] = [];
  constructor(public faults = new Faults()) {}

  private async gate(op: string, action: () => void = () => {}) {
    this.calls.push(op);
    const f = this.faults.take(op);
    if (f === "transient") throw new TransientError(`${op}: 429 rate limited`);
    action();
    if (f === "lost_response") throw new TransientError(`${op}: connection reset after commit`);
    if (f === "crash_after_commit") throw new SimulatedCrash(op);
  }

  async createDraft(input: DraftContent) {
    const content = metaOnly(input);
    const d = { id: `draft_${randomUUID().slice(0, 8)}`, ...content, threadId: content.inReplyTo?.threadId ?? `thread_${randomUUID().slice(0, 8)}`, createdAt: Date.now() };
    await this.gate("mail.create", () => {
      this.drafts.set(d.id, d);
      this.createdTotal++;
    });
    return { id: d.id, ...content, threadId: d.threadId };
  }

  async getDraft(id: string) {
    await this.gate("mail.get");
    const d = this.drafts.get(id);
    return d ? (({ createdAt: _c, ...rest }) => rest)(d) : null;
  }

  async updateDraft(id: string, input: DraftContent) {
    const content = metaOnly(input);
    await this.gate("mail.update", () => {
      const d = this.drafts.get(id);
      if (!d) throw new Error("404 draft not found");
      // Same contract as Gmail: omitting attachments keeps the ones already on the draft.
      Object.assign(d, content, input.attachments === undefined ? { attachments: d.attachments } : {});
    });
    const d = this.drafts.get(id);
    return { id, ...content, ...(d?.attachments ? { attachments: d.attachments } : {}), threadId: d?.threadId };
  }

  async deleteDraft(id: string) {
    await this.gate("mail.delete", () => this.drafts.delete(id));
  }

  async findDraft(q: { to: string; subject: string; opId: string }) {
    await this.gate("mail.findDraft");
    const d = [...this.drafts.values()].find((x) => x.to === q.to && x.subject === q.subject && x.amendOpId === q.opId);
    return d ? { ...d } : null;
  }

  async sendDraft(id: string) {
    await this.gate("mail.send", () => {
      const d = this.drafts.get(id);
      if (!d) throw new Error("404 draft not found");
      this.drafts.delete(id);
      this.sent.push(this.toSent(d));
    });
    const m = this.sent.find((x) => x.id === id)!;
    return { id: m.id, threadId: m.threadId, rfcMessageId: m.rfcMessageId };
  }

  async findSent(q: { to: string; subject: string; afterMs: number; opId?: string }) {
    await this.gate("mail.findSent");
    // Newest first: with no opId to disambiguate, the most recent matching send is the best guess.
    const m = [...this.sent]
      .reverse()
      .find((s) => s.to === q.to && s.subject === q.subject && s.sentAt >= q.afterMs && (q.opId === undefined || s.amendOpId === q.opId));
    return m ? { id: m.id, threadId: m.threadId, rfcMessageId: m.rfcMessageId } : null;
  }

  // ---- human actions
  humanCreateDraft(content: DraftContent) {
    const d = { id: `human_${randomUUID().slice(0, 8)}`, ...content, threadId: `thread_${randomUUID().slice(0, 8)}`, createdAt: Date.now() };
    this.drafts.set(d.id, d);
    return d.id;
  }
  humanEdit(id: string, patch: Partial<DraftContent>) {
    Object.assign(this.drafts.get(id)!, patch);
  }
  humanSend(id: string) {
    const d = this.drafts.get(id)!;
    this.drafts.delete(id);
    this.sent.push(this.toSent(d));
  }
  private toSent(d: DraftSnapshot) {
    return {
      id: d.id,
      to: d.to,
      subject: d.subject,
      body: d.body,
      ...(d.attachments ? { attachments: d.attachments } : {}),
      threadId: d.threadId ?? d.id,
      rfcMessageId: `<${d.id}@fake.mail>`,
      sentAt: Date.now(),
      ...(d.amendOpId ? { amendOpId: d.amendOpId } : {}),
      ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}),
    };
  }
  humanDelete(id: string) {
    this.drafts.delete(id);
  }
}

export class FakeChat implements ChatAdapter {
  posts: Array<{ channel: string; threadTs: string; text: string; blocks?: unknown[]; ts: string }> = [];
  async postReply(channel: string, threadTs: string, text: string, blocks?: unknown[]) {
    const ts = `${Date.now()}.${String(++this.seq).padStart(6, "0")}`;
    this.posts.push({ channel, threadTs, text, blocks, ts });
    return { ts };
  }
  private seq = 0;
  /** Every message ever posted, including ones later deleted. */
  history: Array<{ channel: string; threadTs: string; text: string; ts: string; deleted?: boolean }> = [];
  async deleteMessage(channel: string, ts: string) {
    const i = this.posts.findIndex((p) => p.channel === channel && p.ts === ts);
    if (i >= 0) this.history.push({ ...this.posts[i], deleted: true });
    if (i >= 0) this.posts.splice(i, 1);
  }
}
