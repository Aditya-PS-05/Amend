import { FakeChat, FakeCrm, FakeMail, SimulatedCrash, type Fault } from "../src/adapters/fakes.js";
import type { DealField, DraftContent } from "../src/adapters/types.js";
import { normalizeFacts, type Extraction, type FactKey } from "../src/core/facts.js";
import type { Resolution } from "../src/core/reconcile.js";
import { MemoryStore, type Store } from "../src/db/store.js";
import { PgStore } from "../src/db/pg-store.js";
import { Engine, type RunReport } from "../src/engine/engine.js";
import type { Extractor } from "../src/llm/extract.js";
import { TemplateWriter } from "../src/llm/draft-email.js";

/** Fact spec: value, or [value, source quote]. Source defaults to the value. */
export type FactSpec = Partial<Record<FactKey, string | [string, string]>>;

export interface Msg {
  text: string;
  /** Facts extracted from this message on its own. */
  facts: FactSpec;
  /** Facts extracted once this message is combined with the rest of its instruction (defaults to `facts`). */
  composedFacts?: FactSpec;
  rejected?: string[];
  clarifications?: string[];
}

export type Step =
  | { instruct: Msg; eventId?: string }
  | { edit: Msg; eventId?: string }
  /** A threaded @Amend reply (or an edit of one, when the same ts is reused). */
  | { reply: Msg; ts: string }
  | { replayEvent: string }
  | { humanDeal: Partial<Record<DealField, string>> }
  | { humanDraft: Partial<DraftContent> }
  | { humanSendDraft: true }
  | { humanDeleteDraft: true }
  | { fault: { op: string; faults: Fault[] } }
  /** Simulates the app restarting: a fresh engine resumes interrupted or failed runs. */
  | { recover: true }
  /** One pass of the HubSpot/Gmail change watcher. */
  | { watch: true }
  /** Simulated process crash at a named persistence checkpoint in the next run. */
  | { crashAt: string }
  /** A person creates their own Gmail draft. */
  | { humanCreateDraft: DraftContent }
  | { editDuringWrite: { op: string; msg: Msg } }
  | { resolve: { resource: "deal" | "draft"; field: string; choice: Resolution } }
  /** A new top-level @Amend message (routed by the engine), or an edit of one when the same ts is reused. */
  | { post: Msg & { ts: string; threadTs?: string; mentioned?: boolean; edited?: boolean } }
  /** Click "Send email" on the first or latest email card posted so far. */
  | { clickSend: "first" | "latest" };

export interface Expect {
  status?: RunReport["status"];
  deal?: Partial<Record<DealField, string>>;
  draft?: { exists?: boolean; to?: string; subject?: string; bodyIncludes?: string[]; bodyExcludes?: string[] };
  /** Number of external writes in the final run. */
  lastRunWrites?: number;
  dealsTotal?: number;
  draftsCreatedTotal?: number;
  correctionDrafts?: number;
  openConflicts?: number;
  rejectedCount?: number;
  /** Every correction (draft or sent) is a reply in the original email's conversation. */
  correctionsThreaded?: boolean;
  /** Text that must (or must not) appear in messages Amend posted to Slack. */
  chatIncludes?: string[];
  chatExcludes?: string[];
  /** Deal fields that must be empty. */
  dealCleared?: DealField[];
  /** Drafts people created must still exist with exactly this body. */
  humanDraftsIntact?: string[];
  /** Strings the most recently sent email must contain. */
  lastSentIncludes?: string[];
  /** Emails actually sent (by Amend or a human). */
  sentTotal?: number;
  /** Delivery decision on the last email card posted. */
  lastDecision?: "ask" | "auto_sent" | "blocked" | "draft_only";
  /** Outcome of each Send button click, in order. */
  sendResults?: boolean[];
  /** Values set by humans that must survive. */
  humanValuesKept?: Partial<Record<DealField, string>>;
}

export interface Scenario {
  name: string;
  category: "happy" | "edit" | "human" | "sent" | "fault" | "race" | "delivery" | "routing" | "watch" | "safety";
  description: string;
  steps: Step[];
  expect: Expect;
}

export class FixtureExtractor implements Extractor {
  private byText = new Map<string, Msg>();
  add(m: Msg) {
    this.byText.set(m.text.trim(), m);
  }
  async extract(text: string): Promise<Extraction> {
    // Thread replies are composed as "Update: <reply>" lines; fixtures are keyed by the latest reply text.
    const exact = this.byText.get(text.trim());
    const m = exact ?? this.byText.get(text.split("\nUpdate: ").pop()!.trim());
    if (!m) throw new Error(`no fixture for: ${text}`);
    const spec = exact ? m.facts : (m.composedFacts ?? m.facts);
    const raw = Object.entries(spec).map(([key, spec]) => {
      const [value, source] = Array.isArray(spec) ? spec : [spec!, spec!];
      return { key, value, source };
    });
    const { facts, dropped } = normalizeFacts(raw, text);
    return { facts, rejected: m.rejected ?? [], clarifications: [...(m.clarifications ?? []), ...dropped] };
  }
}

export interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ScenarioResult {
  name: string;
  category: Scenario["category"];
  description: string;
  passed: boolean;
  assertions: Assertion[];
  reports: RunReport[];
  metrics: {
    writes: number;
    duplicateDeals: number;
    humanEditsOverwritten: number;
    staleFactsLeft: number;
    verificationChecks: number;
    verificationPassed: number;
  };
  error?: string;
}


let pg: PgStore | undefined;
/** Uses Postgres when EVAL_DATABASE_URL is set, otherwise the in-memory store. */
async function makeStore(): Promise<Store> {
  if (!process.env.EVAL_DATABASE_URL) return new MemoryStore();
  if (!pg) {
    pg = new PgStore(process.env.EVAL_DATABASE_URL);
    await pg.migrate();
  }
  return pg;
}
export async function closeStores() {
  await pg?.close();
}

export async function runScenario(s: Scenario, opts?: { store?: Store }): Promise<ScenarioResult> {
  const runId = `${s.name}:${Date.now()}`;
  // Channel is unique per run so routing never sees other scenarios' deals (matters on the shared Postgres ledger).
  const CHANNEL = `C_${s.name.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`;
  const ROOT_TS = "1726000000.000100";
  const THREAD = `${CHANNEL}:${ROOT_TS}`;
  const store = opts?.store ?? (await makeStore());
  const crm = new FakeCrm();
  const mail = new FakeMail();
  const chat = new FakeChat();
  const extractor = new FixtureExtractor();
  const reports: RunReport[] = [];
  const background: Promise<RunReport>[] = [];
  let raceTrigger: { op: string; msg: Msg } | null = null;
  let eventSeq = 0;
  let lastEventId = "";

  let crashAt: string | null = null;
  const makeEngine = (): Engine => new Engine({
    store,
    crm,
    mail,
    chat,
    extractor,
    writer: new TemplateWriter(),
    retry: { attempts: 4, baseMs: 0 },
    hooks: {
      beforeWrite: async ({ op, resource }) => {
        if (raceTrigger && (raceTrigger.op === op || raceTrigger.op === `${resource}:${op}`)) {
          const msg = raceTrigger.msg;
          raceTrigger = null;
          const before = (await store.latestVersion(THREAD))?.version ?? 0;
          extractor.add(msg);
          background.push(engine.handleInstruction({ threadKey: THREAD, channel: CHANNEL, ts: ROOT_TS, text: msg.text, eventId: `${runId}:ev_${++eventSeq}` }));
          // Wait until the concurrent edit has registered its version (the edit lands mid-write).
          for (let i = 0; i < 400 && ((await store.latestVersion(THREAD))?.version ?? 0) === before; i++) {
            await new Promise((r) => setTimeout(r, 5));
          }
        }
      },
      checkpoint: async (name) => {
        if (crashAt === name) {
          crashAt = null;
          throw new SimulatedCrash(name);
        }
      },
    },
  });
  let engine = makeEngine();

  const send = async (msg: Msg, eventId?: string) => {
    extractor.add(msg);
    lastEventId = `${runId}:${eventId ?? `ev_${++eventSeq}`}`;
    reports.push(await engine.handleInstruction({ threadKey: THREAD, channel: CHANNEL, ts: ROOT_TS, text: msg.text, eventId: lastEventId }));
  };
  const thread = async () => (await store.getThread(THREAD))!;

  const humanKept: Partial<Record<DealField, string>> = {};
  const sendResults: boolean[] = [];
  const humanDraftIds: string[] = [];
  try {
    for (const step of s.steps) {
      if ("recover" in step) {
        // A restart: a brand-new engine over the same store and apps.
        engine = makeEngine();
        reports.push(...(await engine.recover({ channel: CHANNEL, ignoreBackoff: true })));
      } else if ("watch" in step) await engine.watchOnce({ channel: CHANNEL });
      else if ("crashAt" in step) crashAt = step.crashAt;
      else if ("humanCreateDraft" in step) humanDraftIds.push(mail.humanCreateDraft(step.humanCreateDraft));
      else if ("instruct" in step || "edit" in step) {
        try {
          await send("instruct" in step ? step.instruct : step.edit, step.eventId);
        } catch (e) {
          if (!(e instanceof SimulatedCrash)) throw e;
        }
      }
      else if ("reply" in step) {
        extractor.add(step.reply);
        reports.push(
          await engine.handleInstruction({ threadKey: THREAD, channel: CHANNEL, ts: ROOT_TS, partTs: step.ts, text: step.reply.text, eventId: `${runId}:ev_${++eventSeq}` }),
        );
      }
      else if ("replayEvent" in step) {
        const t = await store.latestVersion(THREAD);
        reports.push(await engine.handleInstruction({ threadKey: THREAD, channel: CHANNEL, ts: ROOT_TS, text: t!.text, eventId: `${runId}:${step.replayEvent}` }));
      } else if ("humanDeal" in step) {
        crm.humanEdit((await thread()).dealId!, step.humanDeal);
        Object.assign(humanKept, step.humanDeal);
      } else if ("humanDraft" in step) mail.humanEdit((await thread()).draftId!, step.humanDraft);
      else if ("humanSendDraft" in step) mail.humanSend((await thread()).draftId!);
      else if ("humanDeleteDraft" in step) mail.humanDelete((await thread()).draftId!);
      else if ("fault" in step) {
        const target = step.fault.op.startsWith("crm.") ? crm.faults : mail.faults;
        target.inject(step.fault.op, ...step.fault.faults);
      } else if ("editDuringWrite" in step) raceTrigger = step.editDuringWrite;
      else if ("resolve" in step) {
        const c = (await store.listConflicts(THREAD)).find((x) => x.status === "open" && x.resource === step.resolve.resource && x.field === step.resolve.field);
        if (!c) throw new Error(`no open conflict for ${step.resolve.resource}.${step.resolve.field}`);
        reports.push(await engine.resolveConflict({ threadKey: THREAD, conflictId: c.id, choice: step.resolve.choice, userId: "u_lead" }));
      }
      else if ("post" in step) {
        extractor.add(step.post);
        const r = await engine.handleSlackMessage({
          channel: CHANNEL,
          ts: step.post.ts,
          ...(step.post.threadTs ? { threadTs: step.post.threadTs } : {}),
          text: step.post.text,
          mentioned: step.post.mentioned ?? true,
          edited: step.post.edited ?? false,
          eventId: `${runId}:ev_${++eventSeq}`,
        });
        if (r) reports.push(r);
      } else if ("clickSend" in step) {
        const cards = reports.flatMap((r) => (r.email && r.email.decision !== "auto_sent" ? [r.email] : []));
        const card = step.clickSend === "first" ? cards[0] : cards[cards.length - 1];
        if (!card) throw new Error("no email card to click");
        sendResults.push((await engine.approveSend({ threadKey: THREAD, draftId: card.draftId, bodyToken: card.bodyToken, userId: "u_lead" })).ok);
      }
      reports.push(...(await Promise.all(background.splice(0))));
    }
  } catch (e) {
    return {
      name: s.name,
      category: s.category,
      description: s.description,
      passed: false,
      assertions: [],
      reports,
      metrics: { writes: 0, duplicateDeals: 0, humanEditsOverwritten: 0, staleFactsLeft: 0, verificationChecks: 0, verificationPassed: 0 },
      error: (e as Error).stack,
    };
  }

  // ---------------------------------------------------------------- assertions
  const a: Assertion[] = [];
  const x = s.expect;
  const t = await store.getThread(THREAD);
  const last = [...reports].reverse().find((r) => r.status !== "duplicate") ?? reports[reports.length - 1];
  const deals = [...crm.deals.values()];
  const deal = deals.find((d) => d.id === t?.dealId) ?? deals[0];
  const draft = t?.draftId ? mail.drafts.get(t.draftId) : undefined;

  if (x.status) a.push({ name: `final status ${x.status}`, ok: last?.status === x.status, detail: last?.status });
  for (const [k, v] of Object.entries(x.deal ?? {})) {
    a.push({ name: `deal.${k} = ${v}`, ok: deal?.fields[k as DealField] === v, detail: String(deal?.fields[k as DealField]) });
  }
  const chatText = chat.posts.map((p) => `${p.text} ${JSON.stringify(p.blocks ?? [])}`).join("\n");
  for (const inc of x.chatIncludes ?? []) a.push({ name: `Slack says "${inc}"`, ok: chatText.includes(inc) });
  for (const exc of x.chatExcludes ?? []) a.push({ name: `Slack never says "${exc}"`, ok: !chatText.includes(exc) });
  for (const k of x.dealCleared ?? []) a.push({ name: `deal.${k} cleared`, ok: deal?.fields[k] === null, detail: String(deal?.fields[k]) });
  let humanEditsOverwritten = 0;
  for (const [k, v] of Object.entries(x.humanValuesKept ?? {})) {
    const ok = deal?.fields[k as DealField] === v;
    if (!ok) humanEditsOverwritten++;
    a.push({ name: `human value deal.${k} = ${v} kept`, ok, detail: String(deal?.fields[k as DealField]) });
  }
  let staleFactsLeft = 0;
  if (x.draft) {
    if (x.draft.exists !== undefined) a.push({ name: `draft exists = ${x.draft.exists}`, ok: !!draft === x.draft.exists });
    if (x.draft.to) a.push({ name: `draft.to = ${x.draft.to}`, ok: draft?.to === x.draft.to, detail: draft?.to });
    if (x.draft.subject) a.push({ name: `draft.subject = ${x.draft.subject}`, ok: draft?.subject === x.draft.subject, detail: draft?.subject });
    for (const inc of x.draft.bodyIncludes ?? []) a.push({ name: `body includes "${inc}"`, ok: !!draft?.body.includes(inc) });
    for (const exc of x.draft.bodyExcludes ?? []) {
      const ok = !draft?.body.includes(exc);
      if (!ok) staleFactsLeft++;
      a.push({ name: `body excludes stale "${exc}"`, ok });
    }
  }
  if (x.lastRunWrites !== undefined) a.push({ name: `last run writes = ${x.lastRunWrites}`, ok: last?.writes === x.lastRunWrites, detail: String(last?.writes) });
  if (x.dealsTotal !== undefined) a.push({ name: `deals in HubSpot = ${x.dealsTotal}`, ok: deals.length === x.dealsTotal, detail: String(deals.length) });
  if (x.draftsCreatedTotal !== undefined) a.push({ name: `drafts created = ${x.draftsCreatedTotal}`, ok: mail.createdTotal === x.draftsCreatedTotal, detail: String(mail.createdTotal) });
  if (x.correctionDrafts !== undefined) {
    const n = [...mail.drafts.values(), ...mail.sent].filter((d) => d.inReplyTo).length;
    a.push({ name: `correction drafts = ${x.correctionDrafts}`, ok: n === x.correctionDrafts, detail: String(n) });
  }
  if (x.openConflicts !== undefined) {
    const n = (await store.listConflicts(THREAD)).filter((c) => c.status === "open").length;
    a.push({ name: `open conflicts = ${x.openConflicts}`, ok: n === x.openConflicts, detail: String(n) });
  }
  for (const [i, body] of (x.humanDraftsIntact ?? []).entries()) {
    const hd = mail.drafts.get(humanDraftIds[i]);
    a.push({ name: `human draft ${i + 1} untouched`, ok: hd?.body === body, detail: hd ? hd.body.slice(0, 60) : "deleted" });
  }
  if (x.correctionsThreaded) {
    const firstSent = mail.sent.find((m) => !m.inReplyTo);
    const corrections = [...mail.drafts.values(), ...mail.sent].filter((d) => d.inReplyTo);
    const ok = !!firstSent && corrections.length > 0 && corrections.every((c) => c.threadId === firstSent.threadId && !!c.inReplyTo?.rfcMessageId && c.subject === `Re: ${firstSent.subject}`);
    a.push({ name: "corrections reply in the original email thread", ok, detail: corrections.map((c) => `${c.subject} [${c.threadId}]`).join("; ") + ` vs original [${firstSent?.threadId}]` });
  }
  for (const inc of x.lastSentIncludes ?? []) {
    const lastSent = mail.sent[mail.sent.length - 1];
    a.push({ name: `last sent email includes "${inc}"`, ok: !!lastSent?.body.includes(inc), detail: lastSent?.subject });
  }
  if (x.sentTotal !== undefined) a.push({ name: `emails sent = ${x.sentTotal}`, ok: mail.sent.length === x.sentTotal, detail: String(mail.sent.length) });
  if (x.lastDecision) {
    const lastCard = [...reports].reverse().find((r) => r.email)?.email;
    a.push({ name: `last delivery decision = ${x.lastDecision}`, ok: lastCard?.decision === x.lastDecision, detail: lastCard ? `${lastCard.decision}: ${lastCard.reason}` : "no email card" });
  }
  if (x.sendResults) a.push({ name: `send clicks = ${JSON.stringify(x.sendResults)}`, ok: JSON.stringify(sendResults) === JSON.stringify(x.sendResults), detail: JSON.stringify(sendResults) });
  if (x.rejectedCount !== undefined) a.push({ name: `rejected instructions = ${x.rejectedCount}`, ok: last?.rejected.length === x.rejectedCount });
  const checks = last?.checks ?? [];
  a.push({ name: "agent self-verification all passed", ok: checks.every((c) => c.ok), detail: checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; ") });

  return {
    name: s.name,
    category: s.category,
    description: s.description,
    passed: a.every((y) => y.ok),
    assertions: a,
    reports,
    metrics: {
      writes: reports.reduce((n, r) => n + r.writes, 0),
      duplicateDeals: deals.length - new Set(deals.map((d) => d.threadKey)).size,
      humanEditsOverwritten,
      staleFactsLeft,
      verificationChecks: checks.length,
      verificationPassed: checks.filter((c) => c.ok).length,
    },
  };
}
