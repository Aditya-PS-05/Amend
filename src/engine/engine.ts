import { randomUUID } from "node:crypto";
import {
  DEAL_FIELDS,
  MAX_ATTACHMENT_BYTES,
  TransientError,
  type Attachment,
  type ChatAdapter,
  type CrmAdapter,
  type DealSnapshot,
  type DraftContent,
  type DraftSnapshot,
  type FileRef,
  type FileSource,
  type MailAdapter,
  type SentMessage,
} from "../adapters/types.js";
import {
  CLEARED_CMP,
  DEAL_FIELD_DEPS,
  attachmentsToken,
  bodyToken,
  compile,
  requiredBodyTokens,
  sha,
  staleBodyTokens,
  type DesiredField,
  type DesiredState,
  type ResourceKind,
} from "../core/compile.js";
import { diffFacts, type Extraction, type FactKey, type FactSet } from "../core/facts.js";
import { reconcileBase, reconcileField, type Resolution } from "../core/reconcile.js";
import type { LedgerEntry, Store, ThreadRecord } from "../db/store.js";
import type { Extractor } from "../llm/extract.js";
import { CLAIMS_ATTACHMENT, TemplateWriter, type EmailRequest, type EmailWriter } from "../llm/draft-email.js";
import { HeuristicRouter, mentionsCandidate, sameCompany, type RouteCandidate, type Router } from "../llm/route.js";

/** A raw Slack message event, before Amend decides which instruction (if any) it belongs to. */
export interface SlackMessageInput {
  channel: string;
  ts: string;
  /** Parent ts when the message is a thread reply. */
  threadTs?: string;
  text: string;
  mentioned: boolean;
  edited: boolean;
  /** Dedicated-channel mode: top-level messages count without a mention. */
  channelMode?: boolean;
  userId?: string;
  eventId?: string;
  /** Files shared on this message; they are attached to the email. */
  files?: FileRef[];
}

/** Slack mrkdwn → plain text: <mailto:a|a> → a, <url|label> → label, entities decoded. */
export function cleanSlackText(t: string): string {
  return t
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<mailto:([^>]+)>/g, "$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<#(C\w+)\|([^>]*)>/g, (_m, id: string, label: string) => `#${label || id}`)
    .replace(/<#(C\w+)>/g, "#$1")
    // A user mention anywhere in the message (not just a leading one — that's handled separately
    // for the bot's own mention) must not survive into the instruction text or an email quote.
    .replace(/\s*<@[UW][A-Z0-9]+(\|[^>]*)?>\s*/g, " ")
    // Broadcast markup (<!here>, <!channel>, <!everyone>, <!subteam^ID|@label>) rendered readably
    // instead of left as raw, unresolved markup.
    .replace(/<!(here|channel|everyone)>/gi, "@$1")
    .replace(/<!([^>|]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => label || `@${id}`)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

const DELETED = /^this message was deleted\.?$/i;

function stripRe(subject: string): string {
  return subject.replace(/^(re|correction):\s*/i, "");
}

/**
 * Identity token for an email preview shown in Slack (the Send button's `bodyToken`). Must cover
 * the recipient and subject too, not just the body — `to`/`subject` aren't part of BODY_DEPS, so an
 * edit that only changes the contact leaves the body byte-for-byte identical; hashing the body
 * alone would let a stale card's Send button go through to a recipient the card never showed.
 */
function previewToken(d: { to: string; subject: string; body: string; attachments?: DraftSnapshot["attachments"] }): string {
  const files = d.attachments?.length ? `\n${attachmentsToken(d.attachments)}` : "";
  return sha(`${d.to}\n${d.subject}\n${bodyToken(d.body)}${files}`);
}

/**
 * Whether two "delivery: send" source quotes describe the same underlying request rather than a
 * new one — an exact string match would treat fixing a typo in the same sentence ("emial" ->
 * "email") as a brand-new send request and re-send an already-honored one. Compares by word
 * overlap: sentences sharing most of their words are the same request reworded, not a new ask.
 */
function sameSendWish(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  if (a === b) return true;
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,!?'"]/g, "")
      .split(/\s+/)
      .filter(Boolean);
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return false;
  const setA = new Set(wa);
  const shared = wb.filter((w) => setA.has(w)).length;
  return shared / Math.max(wa.length, wb.length) >= 0.7;
}

export type OutcomeKind =
  | "created"
  | "updated"
  | "deleted"
  | "compensated"
  | "unchanged"
  | "already_correct"
  | "human_edit_preserved"
  | "human_edit_accepted"
  | "conflict"
  | "failed"
  | "superseded"
  | "held";

export interface Cause {
  key: FactKey;
  from?: string;
  to?: string;
  source?: string;
}

export interface FieldOutcome {
  resource: ResourceKind;
  field: string;
  kind: OutcomeKind;
  before: string | null;
  after: string | null;
  because: Cause[];
  changedBy?: string;
  conflictId?: string;
  note?: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export type RunStatus = "completed" | "needs_attention" | "superseded" | "duplicate" | "clarification" | "failed";

export interface RunReport {
  threadKey: string;
  version: number;
  status: RunStatus;
  changedFacts: FactKey[];
  outcomes: FieldOutcome[];
  checks: Check[];
  rejected: string[];
  clarifications: string[];
  writes: number;
  notes: string[];
  email?: EmailCard;
}

/** User-facing email message posted in the thread whenever the email is drafted, updated, or sent. */
export interface EmailCard {
  state: "drafted" | "updated" | "correction_drafted" | "sent";
  /** ask = Send button; auto_sent = user explicitly asked and every gate passed; blocked = asked but held; draft_only = user asked for review. */
  decision: "ask" | "auto_sent" | "blocked" | "draft_only";
  reason: string;
  draftId: string;
  to: string;
  subject: string;
  body: string;
  bodyToken: string;
  attachments?: string[];
  requestedBy?: string;
}

export interface SendApproval {
  threadKey: string;
  draftId: string;
  /** Token of the body the user saw; the send is refused if the draft changed since. */
  bodyToken: string;
  userId?: string;
}

export interface InstructionInput {
  threadKey: string;
  channel: string;
  /** Root message ts (the thread). */
  ts: string;
  text: string;
  /** ts of this message when it is a reply in the thread; defaults to the root. */
  partTs?: string;
  eventId?: string;
  /** Slack user who posted or edited this message. */
  userId?: string;
  /** Slack thread where the user is talking to Amend; replies go there. Defaults to the root. */
  replyTs?: string;
  files?: FileRef[];
}

/** Root instruction first, then thread corrections in order; later lines override earlier ones. */
export function composeInstruction(parts: Array<{ ts: string; text: string; files?: FileRef[] }>): string {
  return [...parts]
    .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
    .map((p, i) => {
      // File ids are part of the text so adding or removing a file is a new version of the instruction.
      const files = p.files?.length ? ` [attached files: ${p.files.map((f) => `${f.name.replace(/[\[\]]/g, "")} (${f.id})`).join(", ")}]` : "";
      return (i === 0 ? p.text : `Update: ${p.text}`) + files;
    })
    .join("\n");
}

/** Every file shared across the instruction's messages, oldest first, each file once. */
export function instructionFiles(thread: Pick<ThreadRecord, "parts">): FileRef[] {
  const seen = new Set<string>();
  return [...(thread.parts ?? [])]
    .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
    .flatMap((p) => p.files ?? [])
    .filter((f) => !seen.has(f.id) && !!seen.add(f.id));
}

export interface EngineHooks {
  /** Called right before every external write. Evals use it to inject races. */
  beforeWrite?(info: { threadKey: string; version: number; resource: ResourceKind; op: string }): Promise<void>;
  afterExtract?(info: { threadKey: string; version: number }): Promise<void>;
  /** Named points between persistence steps; evals throw here to simulate a crash. */
  checkpoint?(name: string): Promise<void>;
}

export interface EngineDeps {
  store: Store;
  crm: CrmAdapter;
  mail: MailAdapter;
  chat?: ChatAdapter;
  extractor: Extractor;
  writer: EmailWriter;
  router?: Router;
  hooks?: EngineHooks;
  /** Downloads files shared in Slack so they can be attached to emails. */
  files?: FileSource;
  retry?: { attempts: number; baseMs: number };
  now?: () => Date;
  log?: (msg: string, data?: unknown) => void;
}

class Superseded extends Error {
  constructor(public latest: number) {
    super(`superseded by version ${latest}`);
  }
}

interface RunCtx {
  thread: ThreadRecord;
  version: number;
  facts: FactSet;
  prevFacts?: FactSet;
  changed: FactKey[];
  desired: DesiredState;
  resolutions: Map<string, { choice: Resolution; desiredCmp: string; humanToken?: string | null }>;
  outcomes: FieldOutcome[];
  notes: string[];
  writes: number;
  /** Deal fields cleared this run because their facts were removed. */
  cleared?: string[];
  /** Files the email should carry (empty when the instruction never had any). */
  files: FileRef[];
}

const DRAFT_DELETED_CMP = "deleted";
export const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 20_000;

export class Engine {
  private template = new TemplateWriter();
  constructor(private d: EngineDeps) {}

  private log(msg: string, data?: unknown) {
    this.d.log?.(msg, data);
  }

  // ---------------------------------------------------------------- entrypoints

  /**
   * Decides which instruction a Slack message belongs to:
   *  - edits of any tracked message (root, reply, or a routed follow-up) update that instruction;
   *  - @Amend replies in a tracked thread add an update;
   *  - a new top-level @Amend message that names an existing deal is routed into it (not a duplicate deal).
   */
  async handleSlackMessage(m: SlackMessageInput): Promise<RunReport | null> {
    const { store } = this.d;
    const cleaned = cleanSlackText(m.text);
    if (cleaned && DELETED.test(cleaned)) return null;
    const files = m.files?.length ? m.files : undefined;
    const text = cleaned || (files ? "Attach these files to the email." : "");
    if (!text) return null;
    const msgKey = `${m.channel}:${m.ts}`;
    const isReply = !!m.threadTs && m.threadTs !== m.ts;
    const replyTs = isReply ? m.threadTs! : m.ts;

    let threadKey = await store.resolveLink(msgKey);
    let partTs: string | undefined = threadKey ? m.ts : undefined;
    let notice: string | undefined;

    if (!threadKey && isReply) {
      const parentKey = `${m.channel}:${m.threadTs}`;
      threadKey = (await store.resolveLink(parentKey)) ?? parentKey;
      if (!m.mentioned) {
        // An unmentioned reply only counts as a continuation when this thread is a pending
        // clarification Amend itself asked (no deal yet, but a real conversation on file) —
        // replies to an already-resolved thread (one with a deal) still require a mention, as
        // documented. (Not `isTracked(threadKey, m.ts)`: that checks whether THIS message's own ts
        // is already recorded, which is never true for a first-time reply — only for re-processing
        // an edit of one already seen.)
        const t = await store.getThread(threadKey);
        if (!t || t.dealId || !t.parts?.length) return null;
      }
      partTs = m.ts;
    } else if (!threadKey) {
      if (await store.getThread(msgKey)) {
        threadKey = msgKey;
      } else {
        if (!m.mentioned && !m.channelMode) return null;
        const route = await this.routeNewMessage(m.channel, text);
        if (route.kind === "unclear") {
          // Dedupe here too: the unclear path returns before ever reaching handleInstruction's own
          // seenEvent check, so a redelivered event would otherwise ask the same question twice.
          if (m.eventId && (await store.seenEvent(m.eventId))) return null;
          // Remember the message so a reply like "it's Acme" can be folded into the right deal.
          await store.upsertThread({ threadKey: msgKey, channel: m.channel, ts: m.ts, sentDraftIds: [], parts: [{ ts: m.ts, text, ...(files ? { files } : {}) }], attachmentsTracked: !!files || undefined, replyTs, ...(m.userId ? { requestedBy: m.userId } : {}) });
          await this.postTo(m.channel, replyTs, `:thinking_face: Which deal is this about? ${route.reason}. Reply here with the company (or "new deal").`);
          return null;
        }
        if (route.kind === "existing" && !(await store.getThread(route.threadKey))) {
          // The router pointed at a thread key it invented or that no longer exists — trust nothing
          // it wasn't actually offered as a candidate rather than link to (or crash on) a ghost.
          threadKey = msgKey;
        } else if (route.kind === "existing") {
          threadKey = route.threadKey;
          partTs = m.ts;
          await store.linkMessage(msgKey, threadKey);
          const target = await store.getThread(threadKey);
          const company = (await store.latestVersion(threadKey))?.extraction?.facts.company?.value ?? "existing";
          notice = `:link: Treating this as an update to the *${company}* deal (<https://slack.com/archives/${m.channel}/p${target!.ts.replace(".", "")}|original request>), not a new deal. ${route.reason}`;
        } else {
          threadKey = msgKey;
        }
      }
    }

    // A conversation that never produced a deal (e.g. waiting on "which company?") may now point at an existing one.
    const pendingThread = !notice ? await store.getThread(threadKey!) : null;
    if (pendingThread && !pendingThread.dealId && !pendingThread.mergedInto && pendingThread.parts?.length) {
      const ownTs = partTs ?? m.ts;
      const prospective = composeInstruction([...pendingThread.parts.filter((p) => p.ts !== ownTs), { ts: ownTs, text, ...(files ? { files } : {}) }]);
      const route = await this.routeNewMessage(m.channel, prospective, pendingThread.threadKey);
      if (route.kind === "existing" && (await store.getThread(route.threadKey))) {
        const target = await this.mergeThread(pendingThread, route.threadKey);
        threadKey = route.threadKey;
        partTs = m.ts;
        const company = (await store.latestVersion(threadKey))?.extraction?.facts.company?.value ?? "existing";
        notice = `:link: Got it: applying this conversation to the existing *${company}* deal (<https://slack.com/archives/${m.channel}/p${target.ts.replace(".", "")}|original request>) instead of creating a new one.`;
      }
    }

    const thread = await store.getThread(threadKey!);
    // A thread first created from a reply (someone answered before the root was ever tracked) must
    // key on the real Slack root, not the reply's own ts — otherwise an edit of the untracked root
    // message later reuses this same ts as its part id and silently overwrites the reply's content.
    const rootTs = thread?.ts ?? (isReply ? m.threadTs! : m.ts);
    if (notice) await this.postTo(m.channel, replyTs, notice);
    return this.handleInstruction({
      threadKey: threadKey!,
      channel: m.channel,
      ts: rootTs,
      partTs: threadKey === msgKey ? undefined : partTs,
      text,
      replyTs,
      ...(m.userId ? { userId: m.userId } : {}),
      ...(m.eventId ? { eventId: m.eventId } : {}),
      ...(files ? { files } : {}),
    });
  }

  /** Moves a pending conversation's messages into an existing deal's instruction and links them for future edits. */
  private async mergeThread(orphan: ThreadRecord, targetKey: string): Promise<ThreadRecord> {
    const { store } = this.d;
    const target = (await store.getThread(targetKey))!;
    const have = new Set((target.parts ?? []).map((p) => p.ts));
    target.parts = [...(target.parts ?? []), ...(orphan.parts ?? []).filter((p) => !have.has(p.ts))];
    if (orphan.attachmentsTracked) target.attachmentsTracked = true;
    await store.upsertThread(target);
    await store.linkMessage(orphan.threadKey, targetKey);
    for (const p of orphan.parts ?? []) await store.linkMessage(`${orphan.channel}:${p.ts}`, targetKey);
    await store.upsertThread({ ...orphan, mergedInto: targetKey });
    return target;
  }

  /**
   * Which existing deal (if any) a message is about. If the message names a company, only deals for that
   * company are candidates (none → new deal). If it names none ("sorry, it's $65k not $60k"), the most
   * recent deals are offered and the router decides from context.
   */
  private async routeNewMessage(channel: string, text: string, excludeKey?: string) {
    const { store } = this.d;
    const own = await this.d.extractor.extract(text, this.today());
    const namedCompany = own.facts.company?.value;
    const deals: RouteCandidate[] = [];
    for (const t of await store.listThreads(50)) {
      if (t.channel !== channel || t.threadKey === excludeKey || t.mergedInto) continue;
      if (!t.dealId) {
        // No confirmed deal yet — but if HubSpot's create is still in flight (a correction can
        // arrive before the create response comes back), this thread is still a real candidate.
        // Without this, the correction finds no candidates and starts its own, duplicate deal.
        const inFlight = (await store.listLedger(t.threadKey)).some((e) => e.resource === "deal" && e.field === "*" && e.action === "create" && e.status === "pending");
        if (!inFlight) continue;
      }
      const v = await store.latestVersion(t.threadKey);
      const facts = v?.extraction?.facts;
      if (!facts?.company) continue;
      const c: RouteCandidate = {
        threadKey: t.threadKey,
        company: facts.company.value,
        contact: facts.contact_name?.value ?? facts.contact_email?.value,
        amount: facts.deal_amount?.value,
        instruction: v!.text,
      };
      deals.push(c);
    }
    if (!deals.length) return { kind: "new" as const, reason: "no existing deals in this channel" };
    const named = deals.filter((c) => (namedCompany && sameCompany(namedCompany, c.company)) || mentionsCandidate(text, c));
    let candidates: RouteCandidate[];
    if (named.length) candidates = named;
    else if (namedCompany) return { kind: "new" as const, reason: `no existing deal for ${namedCompany}` };
    else candidates = deals.slice(0, 3);
    return (this.d.router ?? new HeuristicRouter()).route(text, candidates.slice(0, 5));
  }

  private async postTo(channel: string, ts: string, text: string) {
    if (!this.d.chat) return;
    await this.retry(() => this.d.chat!.postReply(channel, ts, text)).catch((e) => this.log("failed to post message", e));
  }

  async handleInstruction(input: InstructionInput): Promise<RunReport> {
    const { store } = this.d;
    if (input.eventId && (await store.seenEvent(input.eventId))) {
      return this.emptyReport(input.threadKey, 0, "duplicate", ["duplicate Slack event ignored"]);
    }
    // Read-modify-write of parts under its own short lock (not the run lock, so a version can still be
    // registered while a run is in flight and fence it): concurrent replies must not clobber each other.
    const { version, duplicate, text } = await store.withLock(`${input.threadKey}#parts`, async () => {
      const thread = (await store.getThread(input.threadKey)) ?? { threadKey: input.threadKey, channel: input.channel, ts: input.ts, sentDraftIds: [] };
      const partTs = input.partTs ?? input.ts;
      thread.parts = [...(thread.parts ?? []).filter((p) => p.ts !== partTs), { ts: partTs, text: input.text.trim(), ...(input.files?.length ? { files: input.files } : {}) }];
      if (input.files?.length) thread.attachmentsTracked = true;
      if (input.userId) thread.requestedBy = input.userId;
      thread.replyTs = input.replyTs ?? input.ts;
      await store.upsertThread(thread);
      const text = composeInstruction(thread.parts);
      return { ...(await store.addVersion(input.threadKey, text, sha(text))), text };
    });
    if (duplicate) {
      return this.emptyReport(input.threadKey, version.version, "duplicate", ["instruction text unchanged; nothing to do"]);
    }
    const working = await this.showWorking(input.channel, input.replyTs ?? input.ts);
    try {
      const extraction = await this.d.extractor.extract(text, this.today());
      await store.saveExtraction(input.threadKey, version.version, extraction);
      await this.d.hooks?.afterExtract?.({ threadKey: input.threadKey, version: version.version });

      const report = await store.withLock(input.threadKey, () => this.run(input.threadKey, version.version));
      await this.postReceipt(report);
      return report;
    } finally {
      await working();
    }
  }

  async resolveConflict(input: { threadKey: string; conflictId: string; choice: Resolution; userId?: string }) {
    const { store } = this.d;
    const report = await store.withLock(input.threadKey, async () => {
      const c = await store.getConflict(input.conflictId);
      if (!c || c.threadKey !== input.threadKey) throw new Error(`unknown conflict ${input.conflictId}`);
      // Always record the latest click, even on an already-resolved conflict: someone clicking the
      // other button is a real change of mind, not a no-op, and re-running afterward is what
      // actually applies it.
      await store.saveConflict({ ...c, status: "resolved", choice: input.choice, resolvedBy: input.userId });
      const latest = await store.latestVersion(input.threadKey);
      return this.run(input.threadKey, latest!.version);
    });
    await this.postReceipt(report);
    return report;
  }

  // ---------------------------------------------------------------- core run

  private async run(threadKey: string, versionNo: number): Promise<RunReport> {
    const { store } = this.d;
    const latest = await store.latestVersion(threadKey);
    if (!latest || latest.version !== versionNo) {
      return this.emptyReport(threadKey, versionNo, "superseded", [`version ${latest?.version} arrived before this run started`]);
    }
    const extraction = latest.extraction as Extraction;
    const prev = versionNo > 1 ? await store.getVersion(threadKey, versionNo - 1) : null;
    const facts = extraction.facts;
    const prevFacts = prev?.extraction?.facts;

    if (!facts.company) {
      const r = this.emptyReport(threadKey, versionNo, "clarification", []);
      r.clarifications = extraction.clarifications.length
        ? extraction.clarifications
        : ["Which company is this for? I need at least a company name to update HubSpot."];
      r.rejected = extraction.rejected;
      await this.markCompleted(threadKey, versionNo);
      return r;
    }

    const runThread = (await store.getThread(threadKey))!;
    const files = instructionFiles(runThread);
    const desired = compile(facts, runThread.attachmentsTracked ? files : undefined);
    // What the instruction currently wants for each field the resolution/conflict machinery keys
    // on — used below to retire a conflict the instruction has since moved past.
    const currentCmp = new Map<string, string>();
    for (const f of desired.deal) currentCmp.set(`deal.${f.field}`, f.cmp);
    for (const f of desired.draft.fields) currentCmp.set(`draft.${f.field}`, f.cmp);
    currentCmp.set("draft.*", desired.draft.exists ? (desired.draft.fields.find((f) => f.field === "body")?.cmp ?? DRAFT_DELETED_CMP) : DRAFT_DELETED_CMP);

    const resolutions = new Map<string, { choice: Resolution; desiredCmp: string; humanToken?: string | null }>();
    for (const c of await store.listConflicts(threadKey)) {
      if (c.status === "open") {
        const nowCmp = currentCmp.get(`${c.resource}.${c.field}`);
        if (nowCmp !== undefined && nowCmp !== c.desiredCmp) {
          // The instruction has since changed away from the value that raised this conflict — it
          // is no longer relevant to anything the run is about to do. Leaving it open would keep
          // blocking auto-send and showing dead resolve buttons for a question nobody is asking.
          await store.saveConflict({ ...c, status: "resolved" });
          continue;
        }
      }
      if (c.status === "resolved" && c.choice) {
        const humanToken = c.resource === "draft" && c.field === "body" ? bodyToken(c.human ?? "") : c.field === "*" ? undefined : c.human;
        resolutions.set(`${c.resource}.${c.field}`, { choice: c.choice, desiredCmp: c.desiredCmp, humanToken });
      }
    }

    const ctx: RunCtx = {
      files,
      thread: runThread,
      version: versionNo,
      facts,
      prevFacts,
      changed: diffFacts(prevFacts, facts),
      desired,
      resolutions,
      outcomes: [],
      notes: [],
      writes: 0,
    };

    let status: RunStatus = "completed";
    try {
      await this.syncDeal(ctx);
      await this.syncDraft(ctx);
    } catch (e) {
      if (e instanceof Superseded) {
        status = "superseded";
        ctx.notes.push(`Stopped before further writes: version ${e.latest} arrived mid-run and will reconcile from here.`);
        await this.markPendingSuperseded(threadKey);
      } else {
        if ((e as { fatal?: boolean }).fatal) throw e;
        status = "failed";
        ctx.notes.push(`Run failed: ${(e as Error).message}`);
        this.log("run failed", e);
      }
    }

    const checks = status === "superseded" ? [] : await this.verify(ctx);
    if (status === "completed" && (ctx.outcomes.some((o) => o.kind === "conflict" || o.kind === "failed") || checks.some((c) => !c.ok))) {
      status = "needs_attention";
    }
    let email: EmailCard | undefined;
    if (status !== "superseded" && status !== "failed") {
      try {
        email = await this.decideDelivery(ctx, status, extraction);
      } catch (e) {
        if (!(e instanceof Superseded)) throw e;
        ctx.notes.push(`Send skipped: version ${e.latest} arrived.`);
      }
    }
    // Completed = nothing left for Amend to do: either success, or waiting on a person (conflict, held send).
    // Failed writes or failed checks are retryable and must not advance completedVersion.
    const failure =
      status === "failed"
        ? ctx.notes.find((n) => n.startsWith("Run failed")) ?? "run failed"
        : ctx.outcomes.find((o) => o.kind === "failed")?.note ?? (checks.some((c) => !c.ok) ? `check failed: ${checks.find((c) => !c.ok)!.name}` : undefined);
    if (status !== "superseded") {
      if (failure) {
        const attempts = await this.recordRetry(threadKey, versionNo, failure);
        ctx.notes.push(
          attempts >= MAX_RETRY_ATTEMPTS
            ? `Gave up after ${attempts} attempts (${failure}). Edit the message to try again.`
            : `Will retry automatically (attempt ${attempts} of ${MAX_RETRY_ATTEMPTS}).`,
        );
      } else {
        await this.markCompleted(threadKey, versionNo);
      }
    }
    return {
      email,
      threadKey,
      version: versionNo,
      status,
      changedFacts: ctx.changed,
      outcomes: ctx.outcomes,
      checks,
      rejected: extraction.rejected,
      clarifications: extraction.clarifications,
      writes: ctx.writes,
      notes: ctx.notes,
    };
  }

  // ---------------------------------------------------------------- HubSpot deal

  private async syncDeal(ctx: RunCtx) {
    const { crm, store } = this.d;
    const threadKey = ctx.thread.threadKey;
    // A field Amend wrote earlier whose facts are now gone from the instruction is cleared, not left stale.
    // Fields Amend never wrote stay unmanaged.
    const cleared: DesiredField[] = [];
    if (ctx.thread.dealId) {
      for (const field of DEAL_FIELDS) {
        if (ctx.desired.deal.some((f) => f.field === field)) continue;
        const base = await store.ledgerBase(threadKey, "deal", field);
        if (base && base.observedToken !== null && base.desiredCmp !== CLEARED_CMP) {
          cleared.push({ resource: "deal", field, value: "", cmp: CLEARED_CMP, expectedToken: null, deps: DEAL_FIELD_DEPS[field] });
        }
      }
    }
    ctx.cleared = cleared.map((f) => f.field);
    const fields = [...ctx.desired.deal, ...cleared];
    let createdNow = false;

    if (!ctx.thread.dealId) {
      let snap = await this.retry(() => crm.findDealByThreadKey(threadKey));
      if (snap) {
        ctx.notes.push("Recovered an existing deal for this thread instead of creating a duplicate.");
      } else {
        const values = Object.fromEntries(fields.map((f) => [f.field, f.value!]));
        const entry = await this.pending(ctx, "deal", "*", "create", `create:${threadKey}:deal`, "create", null);
        try {
          // Look up before every attempt: a create whose response was lost must not be repeated.
          snap = await this.write(ctx, "deal", "create", async () => (await crm.findDealByThreadKey(threadKey)) ?? crm.createDeal(threadKey, values));
        } catch (e) {
          await this.failEntry(entry, e);
          throw e;
        }
        await store.updateLedger(entry.id, { status: "applied", observedToken: snap.id });
        createdNow = true;
      }
      ctx.thread.dealId = snap.id;
      await this.saveThread(ctx.thread);
    }

    const snap = await this.retry(() => crm.getDeal(ctx.thread.dealId!));
    if (!snap) {
      ctx.outcomes.push({
        resource: "deal",
        field: "*",
        kind: "conflict",
        before: ctx.thread.dealId!,
        after: null,
        because: [],
        note: "The HubSpot deal was deleted outside Amend. Not recreating it without approval.",
      });
      return;
    }

    const updates: Partial<Record<string, string>> = {};
    const applying: DesiredField[] = [];
    for (const f of fields) {
      const base = await store.ledgerBase(threadKey, "deal", f.field);
      const current = snap.fields[f.field as keyof DealSnapshot["fields"]];
      const decision = reconcileField({
        desiredCmp: f.cmp,
        desiredToken: f.expectedToken,
        base: reconcileBase(base),
        currentToken: current,
        resolution: this.resolution(ctx, "deal", f.field, f.cmp, current),
      });
      const because = this.because(ctx, f.deps);
      const changedBy = describeSource(snap, f.field);
      switch (decision.kind) {
        case "apply":
          updates[f.field] = f.value!;
          applying.push(f);
          break;
        case "noop_already":
          if (!base || base.desiredCmp !== f.cmp) await this.applied(ctx, "deal", f, createdNow ? "create" : "update", current);
          ctx.outcomes.push({ resource: "deal", field: f.field, kind: createdNow ? "created" : "already_correct", before: createdNow ? null : current, after: current, because });
          break;
        case "noop_unchanged":
          ctx.outcomes.push({ resource: "deal", field: f.field, kind: "unchanged", before: current, after: current, because: [] });
          break;
        case "preserve_human":
          ctx.outcomes.push({ resource: "deal", field: f.field, kind: "human_edit_preserved", before: base?.value ?? null, after: current, because: [], changedBy });
          break;
        case "accept_human":
          await this.acceptHuman(ctx, "deal", f, current);
          ctx.outcomes.push({ resource: "deal", field: f.field, kind: "human_edit_accepted", before: f.value, after: current, because, changedBy });
          break;
        case "conflict":
          ctx.outcomes.push(await this.conflict(ctx, "deal", f, base?.value ?? null, current, f.value, because, changedBy));
          break;
      }
    }

    if (!applying.length) return;
    const entries = await Promise.all(
      applying.map((f) => this.pending(ctx, "deal", f.field, "update", `deal:${threadKey}:${f.field}:${f.cmp}`, f.cmp, f.value)),
    );
    try {
      await this.write(ctx, "deal", "update", () => crm.updateDeal(ctx.thread.dealId!, updates));
    } catch (e) {
      await Promise.all(entries.map((en) => this.failEntry(en, e)));
      if (e instanceof Superseded) throw e;
      for (const f of applying) {
        ctx.outcomes.push({ resource: "deal", field: f.field, kind: "failed", before: snap.fields[f.field as keyof DealSnapshot["fields"]], after: null, because: this.because(ctx, f.deps), note: (e as Error).message });
      }
      return;
    }
    const after = await this.retry(() => crm.getDeal(ctx.thread.dealId!));
    for (const [i, f] of applying.entries()) {
      const observed = after?.fields[f.field as keyof DealSnapshot["fields"]] ?? null;
      const ok = observed === f.expectedToken;
      // Status stays "failed" on a mismatch — that's an honest record that the write didn't produce
      // exactly what was asked (e.g. HubSpot normalized "50000" to "50000.00"). But `observed` IS
      // what's now in HubSpot because of OUR write, so it's still recorded: `ledgerBase` treats a
      // failed entry with a known observedToken as a usable base too, so the next run compares
      // spec-to-spec instead of mistaking our own write's result for an out-of-band human edit.
      await store.updateLedger(entries[i].id, {
        status: ok ? "applied" : "failed",
        observedToken: observed,
        error: ok ? undefined : `read-back mismatch: expected ${f.expectedToken}, got ${observed}`,
      });
      ctx.outcomes.push({
        resource: "deal",
        field: f.field,
        kind: ok ? (snap.fields[f.field as keyof DealSnapshot["fields"]] == null ? "created" : "updated") : "failed",
        before: snap.fields[f.field as keyof DealSnapshot["fields"]],
        after: observed,
        because: this.because(ctx, f.deps),
        note: ok ? undefined : "read-back did not match the write",
      });
    }
  }

  // ---------------------------------------------------------------- Gmail draft

  private async syncDraft(ctx: RunCtx) {
    const { mail, store } = this.d;
    const d = ctx.desired.draft;
    const threadKey = ctx.thread.threadKey;
    const byField = Object.fromEntries(d.fields.map((f) => [f.field, f]));

    if (!ctx.thread.draftId && ctx.thread.lastDeletedDraftId && ctx.thread.sentDraftIds.includes(ctx.thread.lastDeletedDraftId)) {
      // A crash between recording a correction draft and linking it to the thread leaves only the ledger
      // knowing about it; relink it through the correction's own key instead of drafting a new email.
      const sentId = ctx.thread.lastDeletedDraftId;
      const corr = await store.findLedgerByKey(`draft:${threadKey}:create:correction:replacing:${sentId}`);
      const original = ctx.thread.sentEmails?.find((e) => e.draftId === sentId);
      if (corr?.status === "applied" && original) {
        await this.createDraft(ctx, "correction", sentId, { to: original.to, subject: original.subject });
        if (ctx.thread.draftId) return;
      }
    }

    if (!ctx.thread.draftId) {
      if (!d.exists) return;
      // Scope the create by whatever generation of draft (if any) preceded this one, so recreating
      // after a deletion never collides with an earlier create's idempotency key.
      await this.createDraft(ctx, "new", ctx.thread.lastDeletedDraftId);
      return;
    }

    const snap = await this.retry(() => mail.getDraft(ctx.thread.draftId!));
    const baseTo = await store.ledgerBase(threadKey, "draft", "to");
    const baseSubject = await store.ledgerBase(threadKey, "draft", "subject");
    const baseBody = await store.ledgerBase(threadKey, "draft", "body");
    const baseFiles = byField.attachments ? await store.ledgerBase(threadKey, "draft", "attachments") : null;

    if (!snap) {
      const specChanged = !d.exists
        ? baseBody?.desiredCmp !== DRAFT_DELETED_CMP
        : d.fields.some((f) => f.cmp !== (f.field === "to" ? baseTo : f.field === "subject" ? baseSubject : f.field === "attachments" ? baseFiles : baseBody)?.desiredCmp);
      const sent = ctx.thread.sentDraftIds.includes(ctx.thread.draftId)
        ? { id: ctx.thread.draftId }
        : baseTo?.value && baseSubject?.value
          ? await this.retry(() => mail.findSent({ to: baseTo.value!, subject: baseSubject.value!, afterMs: ctx.thread.draftCreatedAt ?? 0 }))
          : null;

      if (sent) {
        this.recordSent(ctx.thread, ctx.thread.draftId, sent, baseTo?.value ?? "", baseSubject?.value ?? "");
        if (!specChanged) {
          if (!ctx.thread.sentDraftIds.includes(ctx.thread.draftId)) {
            ctx.thread.sentDraftIds.push(ctx.thread.draftId);
            await this.saveThread(ctx.thread);
          }
          ctx.outcomes.push({ resource: "draft", field: "*", kind: "unchanged", before: null, after: null, because: [], note: "Email was already sent and is still accurate." });
          return;
        }
        const sentId = ctx.thread.draftId;
        if (!ctx.thread.sentDraftIds.includes(sentId)) ctx.thread.sentDraftIds.push(sentId);
        ctx.thread.lastDeletedDraftId = sentId;
        ctx.thread.draftId = undefined;
        await this.saveThread(ctx.thread);
        const original = ctx.thread.sentEmails?.find((e) => e.draftId === sentId);
        const company = ctx.facts.company?.value;
        // Replies thread by subject; if the company itself changed, a "Re: … for OldName" reply would be wrong.
        const companyRenamed = !!company && d.exists && !stripRe(baseSubject!.value!).endsWith(`for ${company}`);
        // If the recipient changed, this is a different person who never received the original —
        // replying under that conversation (and opening with "a correction to my earlier email")
        // would address someone about an email they never got.
        const recipientChanged = d.exists && baseTo?.value !== undefined && byField.to.value !== baseTo.value;
        const startNew = companyRenamed || recipientChanged;
        if (companyRenamed) ctx.notes.push(`Company changed since the email was sent, so the correction starts a new email ("${byField.subject.value}") instead of replying under the old name.`);
        if (recipientChanged) ctx.notes.push(`Recipient changed since the email was sent, so a new email is drafted to ${byField.to.value} instead of replying under the conversation with ${baseTo!.value}.`);
        await this.createDraft(ctx, "correction", sentId, {
          to: baseTo!.value!,
          subject: startNew ? byField.subject.value! : baseSubject!.value!,
          ...(startNew ? {} : { inReplyTo: { threadId: original?.threadId, rfcMessageId: original?.rfcMessageId } }),
        });
        return;
      }

      // Not sent: a human deleted the draft.
      const res = this.resolution(ctx, "draft", "*", d.exists ? byField.body.cmp : DRAFT_DELETED_CMP);
      if (!d.exists || !specChanged || res === "keep_human") {
        ctx.outcomes.push({ resource: "draft", field: "*", kind: "human_edit_preserved", before: ctx.thread.draftId, after: null, because: [], note: "Draft was deleted by a human; leaving it deleted." });
        // The thread must stop pointing at a draft that's confirmed gone and won't be recreated —
        // otherwise every future run (even ones that don't touch the draft at all) re-checks for it,
        // fails to find it, and reports needs_attention forever over a decision already made.
        ctx.thread.lastDeletedDraftId = ctx.thread.draftId;
        ctx.thread.draftId = undefined;
        await this.saveThread(ctx.thread);
        return;
      }
      if (res === "apply_new") {
        const deletedId = ctx.thread.draftId;
        ctx.thread.lastDeletedDraftId = deletedId;
        ctx.thread.draftId = undefined;
        await this.saveThread(ctx.thread);
        await this.createDraft(ctx, "new", deletedId);
        return;
      }
      ctx.outcomes.push(
        await this.conflict(ctx, "draft", { ...byField.body, field: "*" }, "draft", null, "recreate draft with new facts", this.because(ctx, byField.body.deps), "deleted outside Amend"),
      );
      return;
    }

    if (!d.exists) {
      // Cancelled: remove the unsent draft unless a human has edited it.
      const humanEdited = baseBody ? bodyToken(snap.body) !== baseBody.observedToken : false;
      const res = this.resolution(ctx, "draft", "*", DRAFT_DELETED_CMP);
      const because = this.because(ctx, ["cancelled", "contact_email", "company"]);
      if (humanEdited && res !== "apply_new") {
        if (res === "keep_human") {
          ctx.outcomes.push({ resource: "draft", field: "*", kind: "human_edit_accepted", before: null, after: snap.subject, because });
        } else {
          const f: DesiredField = { resource: "draft", field: "*", value: null, cmp: DRAFT_DELETED_CMP, deps: ["cancelled"] };
          ctx.outcomes.push(await this.conflict(ctx, "draft", f, "draft (as written by Amend)", "draft edited by a human", "delete draft", because, "Gmail"));
        }
        return;
      }
      const entry = await this.pending(ctx, "draft", "*", "delete", `draft:${threadKey}:delete:${snap.id}`, DRAFT_DELETED_CMP, null);
      await this.write(ctx, "draft", "delete", () => mail.deleteDraft(snap.id));
      await store.updateLedger(entry.id, { status: "applied" });
      await store.appendLedger({ ...entry, id: randomUUID(), field: "body", action: "delete", status: "applied", desiredCmp: DRAFT_DELETED_CMP, observedToken: null });
      ctx.thread.lastDeletedDraftId = snap.id;
      ctx.thread.draftId = undefined;
      await this.saveThread(ctx.thread);
      ctx.outcomes.push({ resource: "draft", field: "*", kind: "deleted", before: snap.subject, after: null, because });
      // Deleting an unsent draft (whether the original or a not-yet-sent correction) is enough when
      // nothing was ever sent. But if an earlier version of this email DID already reach the
      // customer, cancelling now must still tell them — silently discarding the pending correction
      // would leave them holding a proposal nobody meant to send.
      if (ctx.thread.sentEmails?.length) {
        const last = ctx.thread.sentEmails[ctx.thread.sentEmails.length - 1];
        // Scope by the draft just deleted (snap.id), not the original sent email's id: an earlier,
        // still-pending correction for that same sent email may already have used `replacing:
        // <sentId>` as its create key — reusing it here would look like a duplicate of THAT
        // correction and be skipped, instead of creating this cancellation's own retraction.
        await this.createDraft(ctx, "correction", snap.id, {
          to: last.to,
          subject: last.subject,
          inReplyTo: { threadId: last.threadId, rfcMessageId: last.rfcMessageId },
        });
      }
      return;
    }

    const current: Record<string, string | null> = { to: snap.to, subject: snap.subject, body: bodyToken(snap.body), attachments: attachmentsToken(snap.attachments) };
    const bases: Record<string, LedgerEntry | null> = { to: baseTo, subject: baseSubject, body: baseBody, attachments: baseFiles };
    const fileNames = (list: DraftSnapshot["attachments"]) => list?.map((a) => a.name).join(", ") || "(no attachments)";
    // Facts whose HubSpot write is blocked by a conflict, OR whose HubSpot value a person's decision
    // just deliberately kept different from what the instruction now says: don't let the email
    // state a number/date the CRM was just told (or decided) not to match — that's the exact
    // cross-app disagreement the hold exists to prevent.
    const contested = new Set(
      ctx.outcomes.filter((o) => o.kind === "conflict" || o.kind === "human_edit_accepted").flatMap((o) => o.because.map((c) => c.key)),
    );
    const applying: DesiredField[] = [];
    for (const f of d.fields) {
      const base = bases[f.field];
      const decision = reconcileField({
        desiredCmp: f.cmp,
        desiredToken: f.expectedToken,
        base: reconcileBase(base),
        currentToken: current[f.field],
        resolution: this.resolution(ctx, "draft", f.field, f.cmp, current[f.field]),
      });
      const because = this.because(ctx, f.deps);
      const shown = f.field === "body" ? "(email body)" : f.field === "attachments" ? fileNames(snap.attachments) : current[f.field];
      switch (decision.kind) {
        case "apply": {
          const blockedBy = because.filter((c) => contested.has(c.key));
          if (blockedBy.length) {
            ctx.outcomes.push({ resource: "draft", field: f.field, kind: "held", before: shown, after: shown, because, note: `waiting on the ${blockedBy.map((c) => c.key).join(", ")} conflict so the email and CRM stay consistent` });
            break;
          }
          applying.push(f);
          break;
        }
        case "noop_already":
          if (!base || base.desiredCmp !== f.cmp) await this.applied(ctx, "draft", f, "update", current[f.field]);
          ctx.outcomes.push({ resource: "draft", field: f.field, kind: "already_correct", before: shown, after: shown, because });
          break;
        case "noop_unchanged":
          ctx.outcomes.push({ resource: "draft", field: f.field, kind: "unchanged", before: shown, after: shown, because: [] });
          break;
        case "preserve_human":
          ctx.outcomes.push({ resource: "draft", field: f.field, kind: "human_edit_preserved", before: null, after: shown, because: [], changedBy: "Gmail" });
          break;
        case "accept_human":
          await this.acceptHuman(ctx, "draft", f, current[f.field]);
          ctx.outcomes.push({ resource: "draft", field: f.field, kind: "human_edit_accepted", before: null, after: shown, because, changedBy: "Gmail" });
          break;
        case "conflict":
          ctx.outcomes.push(
            await this.conflict(ctx, "draft", f, f.field === "body" ? "(Amend's draft)" : base?.value ?? null, f.field === "body" ? snap.body : shown, f.value || (f.field === "attachments" ? "(no attachments)" : "(regenerated body)"), because, "Gmail"),
          );
          break;
      }
    }
    if (!applying.length) return;

    const applyBody = applying.some((f) => f.field === "body");
    const replyPrefix = snap.inReplyTo ? "Re: " : "";
    const content: DraftContent = {
      to: applying.some((f) => f.field === "to") ? byField.to.value! : snap.to,
      subject: applying.some((f) => f.field === "subject") ? replyPrefix + byField.subject.value! : snap.subject,
      body: applyBody ? await this.body(ctx, snap.inReplyTo ? "correction" : "revision") : snap.body,
      ...(snap.inReplyTo ? { inReplyTo: snap.inReplyTo } : {}),
      ...(snap.amendOpId ? { amendOpId: snap.amendOpId } : {}),
      // Omitted unless the attachments themselves are being changed: the draft keeps the files it has.
      ...(applying.some((f) => f.field === "attachments") ? { attachments: await this.attachmentFiles(ctx) } : {}),
    };
    const entries = await Promise.all(
      applying.map((f) => this.pending(ctx, "draft", f.field, "update", `draft:${threadKey}:${snap.id}:${f.field}:${f.cmp}`, f.cmp, f.field === "body" ? content.body : f.value)),
    );
    let after;
    try {
      after = await this.write(ctx, "draft", "update", () => mail.updateDraft(snap.id, content));
    } catch (e) {
      await Promise.all(entries.map((en) => this.failEntry(en, e)));
      if (e instanceof Superseded) throw e;
      for (const f of applying) ctx.outcomes.push({ resource: "draft", field: f.field, kind: "failed", before: null, after: null, because: this.because(ctx, f.deps), note: (e as Error).message });
      return;
    }
    const reread = (await this.retry(() => mail.getDraft(after.id))) ?? after;
    const observed: Record<string, string> = { to: reread.to, subject: reread.subject, body: bodyToken(reread.body), attachments: attachmentsToken(reread.attachments) };
    for (const [i, f] of applying.entries()) {
      const expected = f.field === "body" ? bodyToken(content.body) : f.field === "subject" ? content.subject : f.field === "attachments" ? f.expectedToken : f.value;
      const ok = observed[f.field] === expected;
      // See the matching comment in syncDeal: status stays honest ("failed" on mismatch); the
      // observed value is still recorded so `ledgerBase` can use it as a base without mistaking it
      // for a human edit.
      await store.updateLedger(entries[i].id, { status: ok ? "applied" : "failed", observedToken: observed[f.field], error: ok ? undefined : "read-back mismatch" });
      ctx.outcomes.push({
        resource: "draft",
        field: f.field,
        kind: ok ? "updated" : "failed",
        before: f.field === "body" ? "(previous body)" : f.field === "attachments" ? fileNames(snap.attachments) : current[f.field],
        after: f.field === "body" ? "(regenerated body)" : f.field === "attachments" ? fileNames(reread.attachments) : observed[f.field],
        because: this.because(ctx, f.deps),
      });
    }
  }

  /** `replacing` is the draft this one supersedes (sent or deleted); it scopes the idempotency key. */
  private async createDraft(ctx: RunCtx, mode: "new" | "correction", replacing?: string, original?: { to: string; subject: string; inReplyTo?: DraftContent["inReplyTo"] }) {
    const { mail, store } = this.d;
    const d = ctx.desired.draft;
    const byField = Object.fromEntries(d.fields.map((f) => [f.field, f]));
    const threadKey = ctx.thread.threadKey;
    const key = `draft:${threadKey}:create:${mode}:replacing:${replacing ?? "none"}`;
    // Stamped into the draft (X-Amend-Op header): the only proof a Gmail draft belongs to this operation.
    const opId = `op_${sha(key)}`;
    const to = byField.to?.value ?? original!.to;
    // Corrections reply in the original conversation so the customer sees one thread.
    const subject = mode === "correction" ? (original!.inReplyTo ? `Re: ${stripRe(original!.subject)}` : original!.subject) : byField.subject.value!;

    const existing = await store.findLedgerByKey(key);
    if (existing?.status === "applied") {
      // The create was recorded, but a crash may have happened before the thread learned the draft id.
      const knownId = existing.observedToken ?? undefined;
      if (knownId && ctx.thread.draftId !== knownId && !ctx.thread.sentDraftIds.includes(knownId)) {
        const snap = (await this.retry(() => mail.getDraft(knownId))) ?? (await this.retry(() => mail.findDraft({ to, subject, opId })));
        if (snap) {
          ctx.thread.draftId = snap.id;
          ctx.thread.draftCreatedAt ??= existing.at;
          await this.saveThread(ctx.thread);
          await this.recordDraftBase(ctx, key, mode, snap);
          ctx.notes.push("Restored the link to a draft created just before an interruption.");
          ctx.outcomes.push({ resource: "draft", field: "*", kind: mode === "correction" ? "compensated" : "created", before: null, after: snap.subject, because: [] });
          return;
        }
      }
      ctx.notes.push("Skipped duplicate draft creation (already applied).");
      return;
    }

    const content: DraftContent = {
      to,
      subject,
      body: await this.body(ctx, mode),
      amendOpId: opId,
      ...(byField.attachments ? { attachments: await this.attachmentFiles(ctx) } : {}),
      ...(mode === "correction" && original?.inReplyTo ? { inReplyTo: original.inReplyTo } : {}),
    };
    const entry = await this.pending(ctx, "draft", "*", mode === "correction" ? "compensate" : "create", key, "create", null);
    let snap;
    try {
      // If an earlier attempt was interrupted (crash, lost response), reuse the draft it made, identified by the
      // operation id; a person's draft with the same recipient and subject is never touched.
      const interrupted = (await store.listLedger(threadKey)).some((e) => e.idempotencyKey === key && e.status !== "applied" && e.id !== entry.id);
      let attempt = 0;
      snap = await this.write(ctx, "draft", mode === "correction" ? "compensate" : "create", async () => {
        attempt++;
        const orphan = interrupted || attempt > 1 ? await mail.findDraft({ to, subject, opId }) : null;
        if (!orphan) return mail.createDraft(content);
        ctx.notes.push("Reused the draft this operation created before an interruption instead of creating a duplicate.");
        return mail.updateDraft(orphan.id, content);
      });
    } catch (e) {
      await this.failEntry(entry, e);
      throw e;
    }
    await store.updateLedger(entry.id, { status: "applied", observedToken: snap.id });
    await this.d.hooks?.checkpoint?.("draft.create.recorded");
    ctx.thread.draftId = snap.id;
    ctx.thread.draftCreatedAt = this.now().getTime();
    await this.saveThread(ctx.thread);
    await this.recordDraftBase(ctx, key, mode, snap);

    const because = mode === "correction" ? this.because(ctx, [...new Set(d.fields.flatMap((f) => f.deps).concat("cancelled"))]) : [];
    ctx.outcomes.push({
      resource: "draft",
      field: "*",
      kind: mode === "correction" ? "compensated" : "created",
      before: null,
      after: snap.subject,
      because,
      note: mode === "correction" ? "Original email was already sent; drafted a correction as a reply in the same email thread." : undefined,
    });
  }

  /** Reconciliation base for each draft field after a create; skips fields already recorded (safe to repeat). */
  private async recordDraftBase(ctx: RunCtx, key: string, mode: "new" | "correction", snap: DraftSnapshot) {
    const { store } = this.d;
    const byField = Object.fromEntries(ctx.desired.draft.fields.map((f) => [f.field, f]));
    const tokens: Record<string, string> = { to: snap.to, subject: snap.subject, body: bodyToken(snap.body), attachments: attachmentsToken(snap.attachments) };
    for (const field of byField.attachments ? (["to", "subject", "body", "attachments"] as const) : (["to", "subject", "body"] as const)) {
      if ((await store.findLedgerByKey(`${key}:${field}`))?.status === "applied") continue;
      await store.appendLedger({
        id: randomUUID(),
        threadKey: ctx.thread.threadKey,
        version: ctx.version,
        resource: "draft",
        field,
        action: mode === "correction" ? "compensate" : "create",
        idempotencyKey: `${key}:${field}`,
        status: "applied",
        desiredCmp: byField[field]?.cmp ?? DRAFT_DELETED_CMP,
        observedToken: tokens[field],
        value: field === "body" ? snap.body : field === "attachments" ? (snap.attachments ?? []).map((a) => a.name).join(", ") : tokens[field],
        at: Date.now(),
      });
    }
  }

  /** Generates a body and verifies it against the facts; falls back to the template. */
  private async body(ctx: RunCtx, mode: EmailRequest["mode"]): Promise<string> {
    const attached = ctx.desired.draft.fields.some((f) => f.field === "attachments") ? ctx.files.map((f) => f.name) : [];
    const req: EmailRequest = { facts: ctx.facts, mode, changed: ctx.changed, previous: ctx.prevFacts, ...(attached.length ? { attachments: attached } : {}) };
    const required = requiredBodyTokens(ctx.facts);
    const stale = staleBodyTokens(ctx.prevFacts, ctx.facts);
    const valid = (b: string) =>
      required.every((t) => b.includes(t)) && (mode === "correction" || stale.every((t) => !b.includes(t))) && (attached.length > 0 || !CLAIMS_ATTACHMENT.test(b));
    try {
      const b = await this.d.writer.write(req);
      if (valid(b)) return b;
      ctx.notes.push("Generated email failed fact verification; used the verified template instead.");
    } catch (e) {
      ctx.notes.push(`Email generation failed (${(e as Error).message}); used the verified template instead.`);
    }
    return this.template.write(req);
  }

  // ---------------------------------------------------------------- verification

  private async verify(ctx: RunCtx): Promise<Check[]> {
    const { crm, mail, store } = this.d;
    const checks: Check[] = [];
    const outcomeOf = (resource: ResourceKind, field: string) =>
      [...ctx.outcomes].reverse().find((o) => o.resource === resource && (o.field === field || o.field === "*"));

    if (ctx.thread.dealId) {
      const deal = await this.retry(() => crm.getDeal(ctx.thread.dealId!));
      if (!deal) {
        checks.push({ name: "HubSpot deal exists", ok: false });
      } else {
        for (const f of ctx.desired.deal) {
          const o = outcomeOf("deal", f.field);
          const value = deal.fields[f.field];
          const base = await store.ledgerBase(ctx.thread.threadKey, "deal", f.field);
          if (o && (o.kind === "conflict" || o.kind === "human_edit_preserved" || o.kind === "human_edit_accepted")) {
            checks.push({ name: `deal.${f.field} human edit intact`, ok: value === o.after, detail: `found ${value}` });
          } else if (base?.status === "accepted_human" && base.desiredCmp === f.cmp) {
            // Either the human value we accepted is still there, or someone has since brought the
            // field in line with the instruction anyway — both are a legitimately settled state.
            // Only the accepted value having drifted to something else entirely is a real problem.
            checks.push({ name: `deal.${f.field} keeps accepted human value`, ok: value === base.observedToken || value === f.value, detail: `found ${value}` });
          } else {
            checks.push({ name: `deal.${f.field} = ${f.value}`, ok: value === f.value, detail: `found ${value}` });
          }
        }
        for (const field of ctx.cleared ?? []) {
          const o = outcomeOf("deal", field);
          if (o?.kind === "conflict" || o?.kind === "human_edit_preserved") continue;
          checks.push({ name: `deal.${field} cleared`, ok: deal.fields[field as keyof DealSnapshot["fields"]] === null, detail: `found ${deal.fields[field as keyof DealSnapshot["fields"]]}` });
        }
      }
    }
    const creates = (await store.listLedger(ctx.thread.threadKey)).filter((e) => e.resource === "deal" && e.field === "*" && e.action === "create" && e.status === "applied");
    checks.push({ name: "no duplicate deal created", ok: creates.length <= 1, detail: `${creates.length} create(s)` });

    const d = ctx.desired.draft;
    const draftOutcome = outcomeOf("draft", "*");
    if (draftOutcome?.kind === "conflict") return checks;
    if (!d.exists) {
      if (ctx.thread.draftId && draftOutcome?.kind !== "compensated" && draftOutcome?.kind !== "human_edit_accepted") {
        const still = await this.retry(() => mail.getDraft(ctx.thread.draftId!));
        checks.push({ name: "stale draft removed", ok: !still });
      }
      return checks;
    }
    if (!ctx.thread.draftId) {
      if (draftOutcome?.kind !== "human_edit_preserved" && draftOutcome?.kind !== "unchanged") checks.push({ name: "Gmail draft exists", ok: false });
      return checks;
    }
    if (ctx.thread.sentDraftIds.includes(ctx.thread.draftId)) {
      checks.push({ name: "sent email left untouched", ok: true });
      return checks;
    }
    const draft = await this.retry(() => mail.getDraft(ctx.thread.draftId!));
    if (!draft) {
      checks.push({ name: "Gmail draft exists", ok: false });
      return checks;
    }
    const byField = Object.fromEntries(d.fields.map((f) => [f.field, f]));
    const human = (field: string) => {
      const k = outcomeOf("draft", field)?.kind;
      return k === "conflict" || k === "human_edit_preserved" || k === "human_edit_accepted" || k === "held";
    };
    if (draftOutcome?.kind !== "compensated") {
      if (!human("to")) checks.push({ name: `draft.to = ${byField.to.value}`, ok: draft.to === byField.to.value, detail: `found ${draft.to}` });
      if (!human("subject")) checks.push({ name: "draft.subject current", ok: stripRe(draft.subject) === byField.subject.value, detail: `found ${draft.subject}` });
    }
    if (byField.attachments && !human("attachments") && draftOutcome?.kind !== "compensated") {
      checks.push({ name: "draft attachments current", ok: attachmentsToken(draft.attachments) === byField.attachments.expectedToken, detail: `found ${draft.attachments?.map((a) => a.name).join(", ") || "none"}` });
    }
    if (!human("body")) {
      const missing = requiredBodyTokens(ctx.facts).filter((t) => !draft.body.includes(t));
      checks.push({ name: "draft body states current facts", ok: missing.length === 0, detail: missing.length ? `missing ${missing.join(", ")}` : undefined });
      if (draftOutcome?.kind !== "compensated") {
        const stale = staleBodyTokens(ctx.prevFacts, ctx.facts).filter((t) => draft.body.includes(t));
        checks.push({ name: "draft body has no stale facts", ok: stale.length === 0, detail: stale.length ? `still says ${stale.join(", ")}` : undefined });
      }
    }
    return checks;
  }

  // ---------------------------------------------------------------- helpers

  /** Fetches the instruction's files from Slack for a draft write; any file that can't be fetched fails the write. */
  private async attachmentFiles(ctx: RunCtx): Promise<Attachment[]> {
    if (!ctx.files.length) return [];
    const total = ctx.files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attached files total ${Math.ceil(total / 1024 / 1024)} MB, over Gmail's 25 MB limit`);
    }
    const source = this.d.files;
    if (!source) throw new Error("file downloads are not configured, so the shared files can't be attached");
    const out: Attachment[] = [];
    for (const f of ctx.files) {
      const data = await this.retry(() => source.download(f, ctx.thread.channel));
      out.push({ name: f.name, mimeType: f.mimeType, size: data.length, data });
    }
    return out;
  }

  private async write<T>(ctx: RunCtx, resource: ResourceKind, op: string, fn: () => Promise<T>): Promise<T> {
    await this.d.hooks?.beforeWrite?.({ threadKey: ctx.thread.threadKey, version: ctx.version, resource, op });
    const latest = await this.d.store.latestVersion(ctx.thread.threadKey);
    if (latest && latest.version !== ctx.version) throw new Superseded(latest.version);
    const result = await this.retry(fn);
    ctx.writes++;
    return result;
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    const { attempts, baseMs } = this.d.retry ?? { attempts: 4, baseMs: 500 };
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof TransientError) || i >= attempts) throw e;
        const wait = Math.max(e.retryAfterMs, baseMs * 2 ** (i - 1));
        this.log(`transient error, retry ${i}/${attempts - 1} in ${wait}ms`, e.message);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  private async pending(
    ctx: RunCtx,
    resource: ResourceKind,
    field: string,
    action: LedgerEntry["action"],
    idempotencyKey: string,
    desiredCmp: string,
    value: string | null,
  ): Promise<LedgerEntry> {
    const entry: LedgerEntry = {
      id: randomUUID(),
      threadKey: ctx.thread.threadKey,
      version: ctx.version,
      resource,
      field,
      action,
      idempotencyKey,
      status: "pending",
      desiredCmp,
      observedToken: null,
      value,
      at: Date.now(),
    };
    await this.d.store.appendLedger(entry);
    return entry;
  }

  private async applied(ctx: RunCtx, resource: ResourceKind, f: DesiredField, action: LedgerEntry["action"], observed: string | null) {
    const e = await this.pending(ctx, resource, f.field, action, `${resource}:${ctx.thread.threadKey}:${f.field}:${f.cmp}`, f.cmp, f.value);
    await this.d.store.updateLedger(e.id, { status: "applied", observedToken: observed });
  }

  private async acceptHuman(ctx: RunCtx, resource: ResourceKind, f: DesiredField, observed: string | null) {
    const e = await this.pending(ctx, resource, f.field, "accept_human", `accept:${ctx.thread.threadKey}:${resource}:${f.field}:${f.cmp}`, f.cmp, observed);
    await this.d.store.updateLedger(e.id, { status: "accepted_human", observedToken: observed });
  }

  private async failEntry(entry: LedgerEntry, e: unknown) {
    await this.d.store.updateLedger(entry.id, {
      status: e instanceof Superseded ? "superseded" : "failed",
      error: (e as Error).message,
    });
  }

  private async markPendingSuperseded(threadKey: string) {
    for (const e of await this.d.store.listLedger(threadKey)) {
      if (e.status === "pending") await this.d.store.updateLedger(e.id, { status: "superseded" });
    }
  }

  private async conflict(
    ctx: RunCtx,
    resource: ResourceKind,
    f: DesiredField,
    base: string | null,
    human: string | null,
    desired: string | null,
    because: Cause[],
    changedBy?: string,
  ): Promise<FieldOutcome> {
    const id = sha(`${ctx.thread.threadKey}|${resource}|${f.field}|${f.cmp}|${human}`);
    const existing = await this.d.store.getConflict(id);
    if (!existing) {
      await this.d.store.saveConflict({
        id,
        threadKey: ctx.thread.threadKey,
        version: ctx.version,
        resource,
        field: f.field,
        base,
        human,
        desired,
        desiredCmp: f.cmp,
        changedBy,
        status: "open",
      });
    }
    return { resource, field: f.field, kind: "conflict", before: base, after: human, because, changedBy, conflictId: id, note: `wants ${desired}` };
  }

  /** A decision applies only to the instruction value AND the exact human value it was made about. */
  private resolution(ctx: RunCtx, resource: ResourceKind, field: string, desiredCmp: string, currentToken?: string | null): Resolution | undefined {
    const r = ctx.resolutions.get(`${resource}.${field}`);
    if (!r || r.desiredCmp !== desiredCmp) return undefined;
    if (r.humanToken !== undefined && currentToken !== undefined && r.humanToken !== currentToken) return undefined;
    return r.choice;
  }

  private because(ctx: RunCtx, deps: FactKey[]): Cause[] {
    return deps
      .filter((k) => ctx.changed.includes(k))
      .map((k) => ({ key: k, from: ctx.prevFacts?.[k]?.value, to: ctx.facts[k]?.value, source: ctx.facts[k]?.source }));
  }

  private emptyReport(threadKey: string, version: number, status: RunStatus, notes: string[]): RunReport {
    return { threadKey, version, status, changedFacts: [], outcomes: [], checks: [], rejected: [], clarifications: [], writes: 0, notes };
  }

  // ---------------------------------------------------------------- delivery

  /**
   * The model reads delivery intent from the user's words ("delivery" fact, with a quote);
   * this gate decides whether acting on it is safe right now.
   */
  private async decideDelivery(ctx: RunCtx, status: RunStatus, extraction: Extraction): Promise<EmailCard | undefined> {
    const { mail, store } = this.d;
    const thread = ctx.thread;
    const delivery = ctx.facts.delivery;
    const touched = [...ctx.outcomes].reverse().find((o) => o.resource === "draft" && (o.kind === "created" || o.kind === "updated" || o.kind === "compensated"));
    // A send request counts until it has actually been fulfilled (an interrupted run must not lose
    // it). Compared loosely (case/punctuation-insensitive) so fixing a typo in the same sentence
    // ("emial" -> "email") isn't read as a brand-new request and doesn't re-send a correction.
    const askedNow = delivery?.value === "send" && !sameSendWish(thread.honoredSend, delivery.source);
    const pending = delivery?.value === "send" && !!thread.pendingSend;
    if (delivery?.value !== "send" && thread.pendingSend) {
      thread.pendingSend = undefined;
      await this.saveThread(thread);
    }
    if (!touched && !askedNow && !pending) return undefined;
    if (!thread.draftId || thread.sentDraftIds.includes(thread.draftId)) return undefined;
    const draft = await this.retry(() => mail.getDraft(thread.draftId!));
    if (!draft) return undefined;

    const card: EmailCard = {
      state: touched?.kind === "compensated" ? "correction_drafted" : touched?.kind === "updated" ? "updated" : "drafted",
      decision: "ask",
      reason: "",
      draftId: draft.id,
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
      ...(draft.attachments?.length ? { attachments: draft.attachments.map((a) => a.name) } : {}),
      bodyToken: previewToken(draft),
      requestedBy: thread.requestedBy,
    };

    if (askedNow || pending) {
      const source = delivery!.source;
      const blockers: string[] = [];
      if (status !== "completed") blockers.push("this run needs attention (see receipt)");
      if ((await store.listConflicts(thread.threadKey)).some((c) => c.status === "open")) blockers.push("a conflict is still open");
      if (extraction.rejected.length) blockers.push("the message also contained instructions I refused, so I want a human to confirm");
      if (ctx.outcomes.some((o) => o.kind === "held")) blockers.push("an email change is held for a conflict");
      if (blockers.length) {
        thread.pendingSend = { version: ctx.version, source };
        await this.saveThread(thread);
        return { ...card, decision: "blocked", reason: `You asked me to send ("${source}"), but I'm holding it: ${blockers.join("; ")}. I'll send it automatically once that's resolved.` };
      }
      await this.sendOnce(ctx, draft);
      thread.pendingSend = undefined;
      thread.honoredSend = source;
      await this.saveThread(thread);
      return { ...card, state: "sent", reason: `Sent because you said "${source}". All checks passed before sending.`, decision: "auto_sent" };
    }
    if (delivery?.value === "draft") {
      return { ...card, decision: "draft_only", reason: `Kept as a draft because you said "${delivery.source}".` };
    }
    return {
      ...card,
      reason:
        card.state === "correction_drafted"
          ? draft.inReplyTo
            ? "The original email was already sent, so I drafted a correction as a reply in the same email thread instead of changing history. Want me to send it?"
            : "The original email was already sent and the company changed, so I drafted the correction as a new email. Want me to send it?"
          : "You didn't ask me to send it, so it's waiting as a draft. Want me to send it?",
    };
  }

  /** Sends a draft exactly once: ledger idempotency plus a sent-folder lookup before every attempt. */
  private async sendOnce(ctx: RunCtx, draft: { id: string; to: string; subject: string; amendOpId?: string }) {
    const { mail, store } = this.d;
    const key = `send:${ctx.thread.threadKey}:${draft.id}`;
    if ((await store.findLedgerByKey(key))?.status === "applied") return;
    const entry = await this.pending(ctx, "draft", "*", "send", key, "sent", draft.id);
    let sent: SentMessage;
    try {
      sent = await this.write(ctx, "draft", "send", async () =>
        // opId disambiguates this thread's send from another thread whose subject happens to match
        // (e.g. two deals for the same company) — without it, a same-subject send elsewhere would
        // look like this one already went out, and this one would never actually be sent.
        (await mail.findSent({ to: draft.to, subject: draft.subject, afterMs: ctx.thread.draftCreatedAt ?? 0, opId: draft.amendOpId })) ?? mail.sendDraft(draft.id),
      );
    } catch (e) {
      await this.failEntry(entry, e);
      throw e;
    }
    await store.updateLedger(entry.id, { status: "applied", observedToken: sent.threadId ?? sent.id });
    this.recordSent(ctx.thread, draft.id, sent, draft.to, draft.subject);
    if (!ctx.thread.sentDraftIds.includes(draft.id)) ctx.thread.sentDraftIds.push(draft.id);
    await this.saveThread(ctx.thread);
  }

  private async markCompleted(threadKey: string, version: number) {
    const t = await this.d.store.getThread(threadKey);
    if (t && ((t.completedVersion ?? 0) < version || t.retry)) await this.d.store.upsertThread({ ...t, completedVersion: Math.max(version, t.completedVersion ?? 0), retry: undefined });
  }

  private async recordRetry(threadKey: string, version: number, reason: string): Promise<number> {
    const t = await this.d.store.getThread(threadKey);
    if (!t) return 1;
    const attempts = t.retry?.version === version ? t.retry.attempts + 1 : 1;
    await this.d.store.upsertThread({ ...t, retry: { version, attempts, lastAt: Date.now(), reason } });
    return attempts;
  }

  /**
   * Resumes runs a restart or crash interrupted: any instruction whose latest version never finished is
   * reconciled again (every step is idempotent, so finished writes are not repeated).
   */
  async recover(opts: { maxAgeMs?: number; channel?: string; ignoreBackoff?: boolean } = {}): Promise<RunReport[]> {
    if (this.recovering) return [];
    this.recovering = true;
    try {
      return await this.recoverOnce(opts);
    } finally {
      this.recovering = false;
    }
  }

  private recovering = false;

  private async recoverOnce(opts: { maxAgeMs?: number; channel?: string; ignoreBackoff?: boolean }): Promise<RunReport[]> {
    const { store } = this.d;
    const reports: RunReport[] = [];
    const cutoff = Date.now() - (opts.maxAgeMs ?? 6 * 3600_000);
    for (const t of await store.listThreads(500)) {
      if (t.mergedInto || !t.parts?.length || (opts.channel && t.channel !== opts.channel)) continue;
      const latest = await store.latestVersion(t.threadKey);
      if (!latest || (t.completedVersion ?? 0) >= latest.version || latest.createdAt < cutoff) continue;
      const retry = t.retry?.version === latest.version ? t.retry : undefined;
      if (retry && retry.attempts >= MAX_RETRY_ATTEMPTS) continue;
      if (retry && !opts.ignoreBackoff && Date.now() < retry.lastAt + RETRY_BASE_MS * 2 ** (retry.attempts - 1)) continue;
      let report: RunReport | null;
      try {
        if (!latest.extraction) await store.saveExtraction(t.threadKey, latest.version, await this.d.extractor.extract(latest.text, this.today()));
        report = await store.withLock(t.threadKey, async () => {
          // Re-check under the lock: a live run (here or in another process) may have finished or
          // recorded a retry while this sweep waited, and must not be resumed a second time.
          const fresh = await store.getThread(t.threadKey);
          const newest = await store.latestVersion(t.threadKey);
          if (!fresh || !newest || newest.version !== latest.version || (fresh.completedVersion ?? 0) >= latest.version) return null;
          if ((fresh.retry?.version === latest.version ? fresh.retry.attempts : 0) !== (retry?.attempts ?? 0)) return null;
          this.log(`${retry ? `retrying (attempt ${retry.attempts + 1})` : "recovering"} ${t.threadKey} v${latest.version}`);
          return this.run(t.threadKey, latest.version);
        });
      } catch (e) {
        if ((e as { fatal?: boolean }).fatal) throw e;
        this.log(`recovery of ${t.threadKey} v${latest.version} failed`, e);
        await this.recordRetry(t.threadKey, latest.version, `recovery failed: ${(e as Error).message}`);
        continue;
      }
      if (!report) continue;
      report.notes.unshift(retry ? `Retried after: ${retry.reason}.` : "Resumed a run that was interrupted by a restart.");
      // Quiet while still retrying; speak up when it succeeds, needs a person, or gives up.
      const after = await store.getThread(t.threadKey);
      const stillRetrying = after?.retry?.version === latest.version && after.retry.attempts < MAX_RETRY_ATTEMPTS;
      if (!stillRetrying) await this.postReceipt(report);
      reports.push(report);
    }
    return reports;
  }

  // ---------------------------------------------------------------- watcher (change feed without webhooks)

  private watchCursor?: number;
  private watching = false;

  /**
   * Notices changes people make directly in HubSpot or Gmail between Slack messages and reports them in the
   * thread right away: a HubSpot field moved away from the instruction becomes a conflict with buttons;
   * a draft sent, edited, or deleted in Gmail is recorded and announced. Speaks once per change.
   */
  async watchOnce(opts: { channel?: string } = {}): Promise<number> {
    if (this.watching) return 0;
    this.watching = true;
    try {
      const now = Date.now();
      const since = this.watchCursor ?? now - 15 * 60_000;
      let notices = 0;
      for (const deal of await this.retry(() => this.d.crm.findChangedSince(since))) {
        notices += await this.d.store.withLock(deal.threadKey, () => this.inspectDeal(deal, opts.channel));
      }
      this.watchCursor = now - 5_000; // small overlap: HubSpot's modified timestamps and search index lag
      for (const t of await this.d.store.listThreads(200)) {
        if (!t.draftId || t.mergedInto || t.sentDraftIds.includes(t.draftId) || (opts.channel && t.channel !== opts.channel)) continue;
        notices += await this.d.store.withLock(t.threadKey, () => this.inspectDraft(t.threadKey));
      }
      return notices;
    } finally {
      this.watching = false;
    }
  }

  private async inspectDeal(deal: DealSnapshot & { threadKey: string }, channel?: string): Promise<number> {
    const { store } = this.d;
    const thread = await store.getThread(deal.threadKey);
    if (!thread || thread.dealId !== deal.id || thread.mergedInto || (channel && thread.channel !== channel)) return 0;
    const latest = await store.latestVersion(thread.threadKey);
    // A pending run will reconcile on its own — unless it already gave up retrying, in which case
    // nothing else will ever look at outside changes for this thread.
    const gaveUp = thread.retry?.version === latest?.version && (thread.retry?.attempts ?? 0) >= MAX_RETRY_ATTEMPTS;
    if (!latest?.extraction || ((thread.completedVersion ?? 0) < latest.version && !gaveUp)) return 0;
    const desired = compile(latest.extraction.facts);
    let notices = 0;
    let threadDirty = false;
    for (const f of desired.deal) {
      const base = await store.ledgerBase(thread.threadKey, "deal", f.field);
      const current = deal.fields[f.field];
      if (!base) continue;
      if (current === base.observedToken || current === f.expectedToken) {
        // Back in agreement: retire what the watcher raised for this field, and forget what it
        // announced so the same outside value is reported again if it ever returns.
        for (const c of await store.listConflicts(thread.threadKey)) {
          if (c.status === "open" && c.resource === "deal" && c.field === f.field) await store.saveConflict({ ...c, status: "resolved" });
        }
        const kept = (thread.watchNoticed ?? []).filter((k) => !k.startsWith(`deal.${f.field}=`));
        if (kept.length !== (thread.watchNoticed ?? []).length) {
          thread.watchNoticed = kept;
          threadDirty = true;
        }
        continue;
      }
      const key = `deal.${f.field}=${current}`;
      if (thread.watchNoticed?.includes(key)) continue;
      const changedBy = describeSource(deal, f.field);
      const id = sha(`${thread.threadKey}|deal|${f.field}|${f.cmp}|${current}`);
      if (!(await store.getConflict(id))) {
        await store.saveConflict({ id, threadKey: thread.threadKey, version: latest.version, resource: "deal", field: f.field, base: base.value, human: current, desired: f.value, desiredCmp: f.cmp, changedBy, status: "open" });
      }
      thread.watchNoticed = [...(thread.watchNoticed ?? []), key];
      await store.upsertThread(thread);
      const text = `:pencil2: HubSpot \`${f.field}\` was changed outside Amend: ${base.value ?? "∅"} → *${current ?? "∅"}*${changedBy ? ` _(${changedBy})_` : ""}. The instruction says *${f.value}*.`;
      await this.postBlocks(thread, text, [
        { type: "section", text: { type: "mrkdwn", text } },
        {
          type: "actions",
          elements: [
            { type: "button", action_id: "amend_conflict_keep", text: { type: "plain_text", text: "Keep HubSpot value" }, value: JSON.stringify({ threadKey: thread.threadKey, conflictId: id, choice: "keep_human" }) },
            { type: "button", style: "primary", action_id: "amend_conflict_apply", text: { type: "plain_text", text: "Restore instruction value" }, value: JSON.stringify({ threadKey: thread.threadKey, conflictId: id, choice: "apply_new" }) },
          ],
        },
      ]);
      notices++;
    }
    if (threadDirty) await store.upsertThread(thread);
    return notices;
  }

  private async inspectDraft(threadKey: string): Promise<number> {
    const { store, mail } = this.d;
    const thread = await store.getThread(threadKey);
    if (!thread?.draftId || thread.sentDraftIds.includes(thread.draftId)) return 0;
    const draftId = thread.draftId;
    const baseBody = await store.ledgerBase(threadKey, "draft", "body");
    const snap = await this.retry(() => mail.getDraft(draftId));
    const notice = (key: string) => thread.watchNoticed?.includes(key);
    if (!snap) {
      const baseTo = await store.ledgerBase(threadKey, "draft", "to");
      const baseSubject = await store.ledgerBase(threadKey, "draft", "subject");
      const sent = baseTo?.value && baseSubject?.value ? await this.retry(() => mail.findSent({ to: baseTo.value!, subject: baseSubject.value!, afterMs: thread.draftCreatedAt ?? 0 })) : null;
      if (sent) {
        this.recordSent(thread, draftId, sent, baseTo!.value!, baseSubject!.value!);
        thread.sentDraftIds.push(draftId);
        await store.upsertThread(thread);
        await this.postBlocks(thread, `:outbox_tray: "${baseSubject!.value}" was sent from Gmail. If the instruction changes now, I'll send the correction as a reply in that email thread.`);
        return 1;
      }
      if (notice(`draft.deleted=${draftId}`)) return 0;
      thread.watchNoticed = [...(thread.watchNoticed ?? []), `draft.deleted=${draftId}`];
      await store.upsertThread(thread);
      await this.postBlocks(thread, ":wastebasket: The draft was deleted in Gmail. I'll leave it deleted; if the instruction changes, I'll ask before recreating it.");
      return 1;
    }
    const token = bodyToken(snap.body);
    if (baseBody && token === baseBody.observedToken) {
      const kept = (thread.watchNoticed ?? []).filter((k) => !k.startsWith("draft.body="));
      if (kept.length !== (thread.watchNoticed ?? []).length) await store.upsertThread({ ...thread, watchNoticed: kept });
      return 0;
    }
    if (!baseBody || notice(`draft.body=${token}`)) return 0;
    thread.watchNoticed = [...(thread.watchNoticed ?? []), `draft.body=${token}`];
    await store.upsertThread(thread);
    await this.postBlocks(thread, ":pencil2: The draft was edited in Gmail. I won't overwrite your wording; if the instruction changes, I'll ask first.");
    return 1;
  }

  private async postBlocks(thread: ThreadRecord, text: string, blocks?: unknown[]) {
    if (!this.d.chat) return;
    await this.retry(() => this.d.chat!.postReply(thread.channel, thread.replyTs ?? thread.ts, text, blocks)).catch((e) => this.log("failed to post message", e));
  }

  private inflight = new Set<Promise<unknown>>();

  /** Tracks work so a shutdown can wait for it instead of killing a run mid-write. */
  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p)).catch(() => {});
    return p;
  }

  async drain(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, 250))]);
    }
    return this.inflight.size === 0;
  }

  private recordSent(thread: ThreadRecord, draftId: string, sent: SentMessage, to: string, subject: string) {
    thread.sentEmails ??= [];
    if (!thread.sentEmails.some((e) => e.draftId === draftId)) thread.sentEmails.push({ draftId, ...sent, to, subject });
  }

  /** "Send email" button: re-validates against the latest state, then sends exactly what was previewed. */
  async approveSend(input: SendApproval): Promise<{ ok: boolean; message: string }> {
    const { store, mail } = this.d;
    const result = await store.withLock(input.threadKey, async () => {
      const thread = await store.getThread(input.threadKey);
      const latest = await store.latestVersion(input.threadKey);
      if (!thread || !latest?.extraction) return { ok: false, message: "I can't find this instruction anymore." };
      if (thread.sentDraftIds.includes(input.draftId)) return { ok: false, message: "Already sent — nothing to do." };
      if (thread.draftId !== input.draftId) return { ok: false, message: "This preview is out of date: a newer draft replaced it. Use the latest email card." };
      if ((await store.listConflicts(input.threadKey)).some((c) => c.status === "open")) {
        return { ok: false, message: "Not sent: there's an open conflict. Resolve it first, then send from the new card." };
      }
      const draft = await this.retry(() => mail.getDraft(input.draftId));
      if (!draft) return { ok: false, message: "Not sent: the draft no longer exists in Gmail (already sent or deleted)." };
      if (previewToken(draft) !== input.bodyToken) {
        return { ok: false, message: "Not sent: the draft changed since this preview (recipient, subject, or body edited in Gmail or by a newer instruction). Review the latest version first." };
      }
      const facts = latest.extraction.facts;
      const missing = requiredBodyTokens(facts).filter((t) => !draft.body.includes(t));
      if (missing.length) return { ok: false, message: `Not sent: the email no longer matches the instruction (missing ${missing.join(", ")}).` };
      if (facts.contact_email && draft.to !== facts.contact_email.value && !draft.inReplyTo) {
        return { ok: false, message: `Not sent: the recipient (${draft.to}) differs from the instruction (${facts.contact_email.value}).` };
      }
      const ctx = { thread, version: latest.version, writes: 0 } as unknown as RunCtx;
      if (facts.delivery?.value === "send") thread.honoredSend = facts.delivery.source;
      // Clicking Send is itself what a held request was waiting on — leaving it set would make the
      // next edit look like it still needs to auto-send, even though a human already sent it here.
      thread.pendingSend = undefined;
      try {
        await this.sendOnce(ctx, draft);
      } catch (e) {
        return { ok: false, message: e instanceof Superseded ? "Not sent: the instruction was edited just now. Review the new card." : `Send failed: ${(e as Error).message}` };
      }
      return { ok: true, message: `:outbox_tray: Sent to ${draft.to}${input.userId ? ` by <@${input.userId}>` : ""}. If the instruction changes now, I'll draft a correction instead of rewriting history.` };
    });
    await this.postText(input.threadKey, result.message);
    return result;
  }

  private async postText(threadKey: string, text: string) {
    if (!this.d.chat) return;
    const thread = await this.d.store.getThread(threadKey);
    if (!thread) return;
    await this.retry(() => this.d.chat!.postReply(thread.channel, thread.replyTs ?? thread.ts, text)).catch((e) => this.log("failed to post message", e));
  }

  /** Posts a transient "working on it" reply (Slack has no typing indicator for bots); the returned function removes it. */
  private async showWorking(channel: string, threadTs: string): Promise<() => Promise<void>> {
    const chat = this.d.chat;
    if (!chat?.deleteMessage) return async () => {};
    let ts: string | undefined;
    try {
      ts = (await chat.postReply(channel, threadTs, ":hourglass_flowing_sand: _Amend is working on it…_")).ts;
    } catch (e) {
      this.log("failed to post working indicator", e);
    }
    return async () => {
      if (!ts) return;
      await this.retry(() => chat.deleteMessage!(channel, ts!)).catch((e) => this.log("failed to remove working indicator", e));
    };
  }

  private async postReceipt(report: RunReport) {
    if (!this.d.chat || report.status === "duplicate") return;
    const thread = await this.d.store.getThread(report.threadKey);
    if (!thread) return;
    const { renderReceipt, renderEmailCard } = await import("../slack-app/receipt.js");
    const messages = [renderReceipt(report), ...(report.email ? [renderEmailCard(report.threadKey, report.email)] : [])];
    for (const { text, blocks } of messages) {
      try {
        await this.retry(() => this.d.chat!.postReply(thread.channel, thread.replyTs ?? thread.ts, text, blocks));
      } catch (e) {
        this.log("failed to post message", e);
      }
    }
  }

  /** Persists run-owned thread fields without clobbering parts added by a concurrent reply. */
  private async saveThread(t: ThreadRecord) {
    const fresh = await this.d.store.getThread(t.threadKey);
    await this.d.store.upsertThread({ ...t, parts: fresh?.parts ?? t.parts });
  }

  /** True if this Slack message (root or reply) is already part of a tracked instruction. */
  async isTracked(threadKey: string, partTs: string): Promise<boolean> {
    const t = await this.d.store.getThread(threadKey);
    return !!t?.parts?.some((p) => p.ts === partTs);
  }

  private now() {
    return this.d.now?.() ?? new Date();
  }

  private today() {
    return this.now().toISOString().slice(0, 10);
  }
}

function describeSource(snap: DealSnapshot, field: string): string | undefined {
  const s = snap.lastChangedBy[field as keyof DealSnapshot["lastChangedBy"]];
  if (!s) return undefined;
  return [s.sourceType, s.userId && `user ${s.userId}`, s.at].filter(Boolean).join(" · ");
}
