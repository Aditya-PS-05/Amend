/**
 * A complete fake world for adversarial tests: engine + fault-injectable HubSpot/Gmail/Slack fakes + store.
 *
 *   const w = await createWorld();
 *   w.say(V1)                         // top-level @Amend message (routed like Slack)
 *   await w.instruct(V1)              // direct instruction on the root thread
 *   w.crm.humanEdit(dealId, {...})    // people acting in the apps
 *   w.restart()                       // brand-new engine over the same store/apps
 */
import { FakeChat, FakeCrm, FakeFiles, FakeMail } from "../../src/adapters/fakes.js";
import type { FileRef } from "../../src/adapters/types.js";
import { MemoryStore, type Store } from "../../src/db/store.js";
import { Engine, composeInstruction, type EngineHooks, type RunReport } from "../../src/engine/engine.js";
import { TemplateWriter, type EmailWriter } from "../../src/llm/draft-email.js";
import { HeuristicRouter, type Router } from "../../src/llm/route.js";
import { FixtureExtractor, type FactSpec, type Msg } from "../../evals/harness.js";

export type { FactSpec, Msg };

export const BASE_FACTS: FactSpec = {
  company: "Acme Corp",
  deal_amount: ["42000", "$42k"],
  close_date: ["2026-10-15", "Oct 15"],
  contact_name: "Priya Shah",
  contact_email: "priya@acme.com",
  email_intent: ["send the proposal", "proposal email"],
  next_step: "legal review",
  deal_stage: ["contractsent", "contract sent"],
};

export const V1: Msg = {
  text: "Acme Corp is ready to move forward, contract sent. Deal is $42k, close by Oct 15. Contact is Priya Shah (priya@acme.com). The proposal email is next. Next step: legal review.",
  facts: BASE_FACTS,
};

/** Builds an edit of V1 by text replacement with fact overrides (and optional fact removals). */
export function editOf(replacements: Array<[string, string]>, facts: FactSpec, drop: string[] = []): Msg {
  let text = V1.text;
  for (const [a, b] of replacements) text = text.replace(a, b);
  const merged: FactSpec = { ...BASE_FACTS, ...facts };
  for (const k of drop) delete (merged as Record<string, unknown>)[k];
  return { text, facts: merged };
}

let seq = 0;

export async function createWorld(opts: { store?: Store; hooks?: EngineHooks; writer?: EmailWriter; router?: Router; retry?: { attempts: number; baseMs: number } } = {}) {
  const id = `${Date.now()}_${++seq}`;
  const CHANNEL = `C_T${id}`;
  const ROOT_TS = "1726000000.000100";
  const THREAD = `${CHANNEL}:${ROOT_TS}`;
  const store = opts.store ?? new MemoryStore();
  const crm = new FakeCrm();
  const mail = new FakeMail();
  const chat = new FakeChat();
  const files = new FakeFiles();
  const extractor = new FixtureExtractor();
  let eventSeq = 0;

  const makeEngine = () =>
    new Engine({
      store,
      crm,
      mail,
      chat,
      files,
      extractor,
      writer: opts.writer ?? new TemplateWriter(),
      router: opts.router ?? new HeuristicRouter(),
      retry: opts.retry ?? { attempts: 4, baseMs: 0 },
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
    });

  const w = {
    CHANNEL,
    ROOT_TS,
    THREAD,
    store,
    crm,
    mail,
    chat,
    files,
    extractor,
    engine: makeEngine(),
    /** Direct instruction (or edit) of the root message. */
    async instruct(msg: Msg, eventId?: string, files?: FileRef[]): Promise<RunReport> {
      extractor.add(msg);
      if (files?.length) extractor.add({ ...msg, text: composeInstruction([{ ts: ROOT_TS, text: msg.text, files }]) });
      return w.engine.handleInstruction({ threadKey: THREAD, channel: CHANNEL, ts: ROOT_TS, text: msg.text, eventId: eventId ?? `${id}:ev${++eventSeq}`, ...(files ? { files } : {}) });
    },
    /** A Slack message event as the app would deliver it (routing, replies, edits). */
    async say(msg: Msg, o: { ts?: string; threadTs?: string; mentioned?: boolean; edited?: boolean; userId?: string; eventId?: string; channelMode?: boolean; files?: FileRef[] } = {}) {
      extractor.add(msg);
      // Messages with files are composed with a file line; key the fixture by that text too.
      if (o.files?.length) extractor.add({ ...msg, text: composeInstruction([{ ts: "0", text: msg.text || "Attach these files to the email.", files: o.files }]) });
      return w.engine.handleSlackMessage({
        channel: CHANNEL,
        ts: o.ts ?? ROOT_TS,
        ...(o.threadTs ? { threadTs: o.threadTs } : {}),
        text: msg.text,
        mentioned: o.mentioned ?? true,
        edited: o.edited ?? false,
        ...(o.channelMode ? { channelMode: true } : {}),
        ...(o.userId ? { userId: o.userId } : {}),
        eventId: o.eventId ?? `${id}:ev${++eventSeq}`,
        ...(o.files ? { files: o.files } : {}),
      });
    },
    async thread() {
      return (await store.getThread(THREAD))!;
    },
    async deal() {
      const t = await store.getThread(THREAD);
      return t?.dealId ? crm.deals.get(t.dealId) : undefined;
    },
    async draft() {
      const t = await store.getThread(THREAD);
      return t?.draftId ? mail.drafts.get(t.draftId) : undefined;
    },
    /** Simulated restart: a new engine instance over the same store and apps. */
    restart() {
      w.engine = makeEngine();
      return w.engine;
    },
  };
  return w;
}
