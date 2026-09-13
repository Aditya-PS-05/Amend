import type { Extraction } from "../core/facts.js";
import type { ResourceKind } from "../core/compile.js";
import type { Resolution } from "../core/reconcile.js";
import type { FileRef } from "../adapters/types.js";

export interface ThreadRecord {
  threadKey: string;
  channel: string;
  ts: string;
  dealId?: string;
  draftId?: string;
  draftCreatedAt?: number;
  /** Drafts that were sent by a human before Amend could revise them. */
  sentDraftIds: string[];
  /**
   * The most recent draft that stopped being current for THIS thread (deleted on cancel, or a
   * human deletion Amend was told to recreate). Scopes the next create's idempotency key so it
   * never collides with the key from an earlier generation's create (e.g. create -> cancel-delete
   * -> un-cancel must create a NEW draft, not be silently skipped as "already applied").
   */
  lastDeletedDraftId?: string;
  /** The root instruction and any @Amend replies in its thread, by Slack ts. */
  parts?: Array<{ ts: string; text: string; files?: FileRef[] }>;
  /** Set once any message of this instruction carried files; from then on the email tracks attachments. */
  attachmentsTracked?: boolean;
  /** Emails that went out for this instruction, with their Gmail conversation, for threaded corrections. */
  sentEmails?: Array<{ draftId: string; id: string; threadId?: string; rfcMessageId?: string; to: string; subject: string }>;
  /** Slack user who posted or last edited the instruction. */
  requestedBy?: string;
  /** Highest instruction version whose run finished; lower than the latest version means a run was interrupted. */
  completedVersion?: number;
  /** Automatic retries of a version whose run failed (retryable), with backoff. */
  retry?: { version: number; attempts: number; lastAt: number; reason: string };
  /** Out-of-band changes the watcher already reported (so it speaks once per change). */
  watchNoticed?: string[];
  /** Quote of the send request Amend already fulfilled, so the same request never sends twice. */
  honoredSend?: string;
  /** Set when this conversation turned out to be about an existing deal and was folded into it. */
  mergedInto?: string;
  /** Slack thread (root ts) where the latest interaction happened; receipts and cards go there. */
  replyTs?: string;
  /** The user asked to send, but a safety check held it; send once the blocker clears. */
  pendingSend?: { version: number; source: string };
}

export interface VersionRecord {
  threadKey: string;
  version: number;
  text: string;
  textHash: string;
  extraction?: Extraction;
  createdAt: number;
}

export type LedgerStatus = "pending" | "applied" | "accepted_human" | "failed" | "superseded";

export interface LedgerEntry {
  id: string;
  threadKey: string;
  version: number;
  resource: ResourceKind;
  /** Field name, or "*" for resource-level actions (create/delete/compensate). */
  field: string;
  action: "create" | "update" | "delete" | "compensate" | "accept_human" | "send";
  idempotencyKey: string;
  status: LedgerStatus;
  desiredCmp: string;
  observedToken: string | null;
  value: string | null;
  error?: string;
  at: number;
}

/**
 * Whether a ledger entry can serve as the reconciliation base for its field: a write that fully
 * succeeded, a human decision that was accepted, OR a write whose read-back didn't match exactly
 * (e.g. HubSpot normalizing "50000" to "50000.00") but whose resulting value IS known — using that
 * known value as the base means the next run compares spec-to-spec, instead of mistaking our own
 * write's actual result for an out-of-band human edit. A failure with no observed value (a request
 * that errored before any read-back) carries no information and must not be used as a base.
 */
export function isUsableBase(e: Pick<LedgerEntry, "status" | "observedToken">): boolean {
  return e.status === "applied" || e.status === "accepted_human" || (e.status === "failed" && e.observedToken !== null);
}

export interface ConflictRecord {
  id: string;
  threadKey: string;
  version: number;
  resource: ResourceKind;
  field: string;
  base: string | null;
  human: string | null;
  desired: string | null;
  desiredCmp: string;
  changedBy?: string;
  status: "open" | "resolved";
  choice?: Resolution;
  resolvedBy?: string;
}

export interface Store {
  seenEvent(eventId: string): Promise<boolean>;
  upsertThread(t: ThreadRecord): Promise<void>;
  getThread(threadKey: string): Promise<ThreadRecord | null>;
  /** Appends a new version unless the text is identical to the latest one. */
  addVersion(threadKey: string, text: string, textHash: string): Promise<{ version: VersionRecord; duplicate: boolean }>;
  latestVersion(threadKey: string): Promise<VersionRecord | null>;
  getVersion(threadKey: string, version: number): Promise<VersionRecord | null>;
  saveExtraction(threadKey: string, version: number, extraction: Extraction): Promise<void>;

  appendLedger(e: LedgerEntry): Promise<void>;
  updateLedger(id: string, patch: Partial<LedgerEntry>): Promise<void>;
  /** Latest applied/accepted entry for a field: the reconciliation base. */
  ledgerBase(threadKey: string, resource: ResourceKind, field: string): Promise<LedgerEntry | null>;
  findLedgerByKey(idempotencyKey: string): Promise<LedgerEntry | null>;
  listLedger(threadKey: string): Promise<LedgerEntry[]>;

  saveConflict(c: ConflictRecord): Promise<void>;
  getConflict(id: string): Promise<ConflictRecord | null>;
  listConflicts(threadKey: string): Promise<ConflictRecord[]>;

  /** Serializes all work on one thread. */
  withLock<T>(threadKey: string, fn: () => Promise<T>): Promise<T>;

  /** Maps a Slack message (channel:ts) that was routed into another thread, so its edits and replies follow. */
  linkMessage(messageKey: string, threadKey: string): Promise<void>;
  resolveLink(messageKey: string): Promise<string | null>;

  /** Read-side helpers for the ledger viewer. */
  listThreads(limit?: number): Promise<ThreadRecord[]>;
  listVersions(threadKey: string): Promise<VersionRecord[]>;
}

export class MemoryStore implements Store {
  private events = new Set<string>();
  private threads = new Map<string, ThreadRecord>();
  private versions = new Map<string, VersionRecord[]>();
  private ledger: LedgerEntry[] = [];
  private conflicts = new Map<string, ConflictRecord>();
  private locks = new Map<string, Promise<unknown>>();
  private links = new Map<string, string>();

  async linkMessage(messageKey: string, threadKey: string) {
    this.links.set(messageKey, threadKey);
  }
  async resolveLink(messageKey: string) {
    return this.links.get(messageKey) ?? null;
  }

  async seenEvent(eventId: string) {
    if (this.events.has(eventId)) return true;
    this.events.add(eventId);
    return false;
  }
  private threadUpdatedAt = new Map<string, number>();
  private threadUpdateSeq = 0;
  async upsertThread(t: ThreadRecord) {
    this.threads.set(t.threadKey, structuredClone(t));
    // Matches PgStore's `order by updated_at desc`: an update to an existing thread must move it
    // to the front, not just leave it wherever it happened to be first inserted. A counter (rather
    // than a wall-clock timestamp) keeps ordering deterministic even for same-tick updates.
    this.threadUpdatedAt.set(t.threadKey, ++this.threadUpdateSeq);
  }
  async getThread(k: string) {
    const t = this.threads.get(k);
    return t ? structuredClone(t) : null;
  }
  async addVersion(threadKey: string, text: string, textHash: string) {
    const list = this.versions.get(threadKey) ?? [];
    const last = list[list.length - 1];
    if (last && last.textHash === textHash) return { version: structuredClone(last), duplicate: true };
    const v: VersionRecord = { threadKey, version: list.length + 1, text, textHash, createdAt: Date.now() };
    list.push(v);
    this.versions.set(threadKey, list);
    return { version: structuredClone(v), duplicate: false };
  }
  async latestVersion(k: string) {
    const list = this.versions.get(k);
    return list?.length ? structuredClone(list[list.length - 1]) : null;
  }
  async getVersion(k: string, n: number) {
    const v = this.versions.get(k)?.[n - 1];
    return v ? structuredClone(v) : null;
  }
  async saveExtraction(k: string, n: number, extraction: Extraction) {
    const v = this.versions.get(k)?.[n - 1];
    if (v) v.extraction = structuredClone(extraction);
  }
  async appendLedger(e: LedgerEntry) {
    this.ledger.push(structuredClone(e));
  }
  async updateLedger(id: string, patch: Partial<LedgerEntry>) {
    const e = this.ledger.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
  }
  async ledgerBase(k: string, resource: ResourceKind, field: string) {
    for (let i = this.ledger.length - 1; i >= 0; i--) {
      const e = this.ledger[i];
      if (e.threadKey === k && e.resource === resource && e.field === field && isUsableBase(e)) return structuredClone(e);
    }
    return null;
  }
  async findLedgerByKey(key: string) {
    const e = [...this.ledger].reverse().find((x) => x.idempotencyKey === key);
    return e ? structuredClone(e) : null;
  }
  async listLedger(k: string) {
    return structuredClone(this.ledger.filter((e) => e.threadKey === k));
  }
  async saveConflict(c: ConflictRecord) {
    this.conflicts.set(c.id, structuredClone(c));
  }
  async getConflict(id: string) {
    const c = this.conflicts.get(id);
    return c ? structuredClone(c) : null;
  }
  async listConflicts(k: string) {
    return structuredClone([...this.conflicts.values()].filter((c) => c.threadKey === k));
  }
  async listThreads(limit = 50) {
    const ordered = [...this.threads.values()].sort((a, b) => (this.threadUpdatedAt.get(b.threadKey) ?? 0) - (this.threadUpdatedAt.get(a.threadKey) ?? 0));
    return structuredClone(ordered.slice(0, limit));
  }
  async listVersions(k: string) {
    return structuredClone(this.versions.get(k) ?? []);
  }
  async withLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(k) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(k, run.catch(() => undefined));
    return run;
  }
}
