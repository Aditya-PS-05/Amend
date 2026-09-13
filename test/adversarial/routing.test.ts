/**
 * Adversarial tests for "which instruction does this Slack message belong to?":
 * Engine.handleSlackMessage / routeNewMessage / mergeThread / isTracked / handleInstruction,
 * the store's message links, composeInstruction / cleanSlackText / tombstones,
 * the routing heuristics in src/llm/route.ts, and the Slack event filtering in src/slack-app/app.ts.
 *
 * Tests marked "BUG:" assert the behavior Amend should have and currently fail.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/db/store.js";
import { cleanSlackText, composeInstruction, type EngineHooks } from "../../src/engine/engine.js";
import { HeuristicRouter, mentionsCandidate, sameCompany, type RouteCandidate, type RouteDecision, type Router } from "../../src/llm/route.js";
import { isThreadReply, selectMessage, stripMention, type RawMessage } from "../../src/slack-app/app.js";
import { BASE_FACTS, createWorld, V1, type Msg } from "../helpers/world.js";

type World = Awaited<ReturnType<typeof createWorld>>;

const TS = {
  root: "1726000000.000100",
  second: "1726000200.000200",
  f1: "1726000500.000300",
  f2: "1726000600.000400",
  r1: "1726000700.000500",
  r2: "1726000800.000600",
};

const GLOBEX: Msg = {
  text: "Globex wants a $20k pilot, contact Hank Scorpio hank@globex.io",
  facts: { company: "Globex", deal_amount: ["20000", "$20k"], contact_name: "Hank Scorpio", contact_email: "hank@globex.io" },
};

/** A follow-up message: `facts` = the message alone, `composedFacts` = the whole instruction after it lands. */
function followUp(text: string, amount: string, pretty: string, extra: Msg["facts"] = {}): Msg {
  return {
    text,
    facts: { company: "Acme Corp", deal_amount: [amount, pretty], ...extra },
    composedFacts: { ...BASE_FACTS, deal_amount: [amount, pretty], ...extra },
  };
}

const chatText = (w: World) => w.chat.posts.map((p) => `${p.text} ${JSON.stringify(p.blocks ?? [])}`).join("\n");
const dealsOf = (w: World) => [...w.crm.deals.values()];
/** The deal belonging to one Slack thread (the fakes tag every deal with its thread key). */
const dealFor = (w: World, threadKey: string) => dealsOf(w).find((d) => d.threadKey === threadKey);

/** A router that answers from a script, so "unclear"/"new"/"existing" can be forced deterministically. */
class ScriptedRouter implements Router {
  seen: Array<{ message: string; candidates: RouteCandidate[] }> = [];
  constructor(private answer: (message: string, candidates: RouteCandidate[]) => RouteDecision) {}
  async route(message: string, candidates: RouteCandidate[]): Promise<RouteDecision> {
    this.seen.push({ message, candidates });
    return this.answer(message, candidates);
  }
}

// ------------------------------------------------------------------ cleanSlackText / tombstones

describe("cleanSlackText", () => {
  it("unwraps Slack markup and decodes entities without losing content", () => {
    expect(cleanSlackText("mail <mailto:priya@acme.com|priya@acme.com> now")).toBe("mail priya@acme.com now");
    expect(cleanSlackText("mail <mailto:priya@acme.com> now")).toBe("mail priya@acme.com now");
    expect(cleanSlackText("see <https://acme.com/q3|the quote>")).toBe("see the quote");
    expect(cleanSlackText("see <https://acme.com/q3>")).toBe("see https://acme.com/q3");
    expect(cleanSlackText("post in <#C123ABC|sales>")).toBe("post in #sales");
    expect(cleanSlackText("  Acme &amp; Sons: 5 &lt; 6 &gt; 4  ")).toBe("Acme & Sons: 5 < 6 > 4");
  });

  it("decodes &amp;lt; to the literal text &lt; (entity decoding order)", () => {
    expect(cleanSlackText("&amp;lt;tag&amp;gt;")).toBe("&lt;tag&gt;");
  });
});

describe("tombstones", () => {
  it("ignores Slack's deletion tombstone in any casing or without the period", async () => {
    const w = await createWorld();
    for (const text of ["This message was deleted.", "this message was deleted", "  This message was deleted.  "]) {
      expect(await w.say({ text, facts: {} }, { ts: TS.root, mentioned: false, edited: true })).toBeNull();
    }
    expect(dealsOf(w)).toHaveLength(0);
  });

  it("does not drop a real instruction that merely contains the tombstone sentence", async () => {
    const w = await createWorld();
    const msg: Msg = {
      text: "Acme Corp asked about the old note (This message was deleted.) - the deal is $50k, contact Priya Shah (priya@acme.com)",
      facts: { company: "Acme Corp", deal_amount: ["50000", "$50k"], contact_name: "Priya Shah", contact_email: "priya@acme.com" },
    };
    const r = await w.say(msg, { ts: TS.root });
    expect(r?.status).toBe("completed");
    expect(dealsOf(w)).toHaveLength(1);
    expect(dealsOf(w)[0].fields.amount).toBe("50000");
  });

  it("ignores empty, whitespace-only and mention-only messages", async () => {
    const w = await createWorld();
    for (const text of ["", "   ", "\n\t "]) {
      expect(await w.say({ text, facts: {} }, { ts: TS.root })).toBeNull();
    }
    expect(dealsOf(w)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ composeInstruction

describe("composeInstruction", () => {
  it("keeps the root first and orders corrections by Slack ts, whatever order they arrive in", () => {
    const parts = [
      { ts: "1726000600.000400", text: "third" },
      { ts: "1726000000.000100", text: "root" },
      { ts: "1726000500.000300", text: "second" },
    ];
    expect(composeInstruction(parts)).toBe("root\nUpdate: second\nUpdate: third");
    // Same-second messages differ only in the microsecond suffix; ordering must still hold.
    expect(
      composeInstruction([
        { ts: "1726000000.000102", text: "b" },
        { ts: "1726000000.000101", text: "a" },
      ]),
    ).toBe("a\nUpdate: b");
  });

  it("does not mutate the caller's array", () => {
    const parts = [
      { ts: "2", text: "b" },
      { ts: "1", text: "a" },
    ];
    composeInstruction(parts);
    expect(parts[0].text).toBe("b");
  });
});

// ------------------------------------------------------------------ Slack event filtering (src/slack-app/app.ts)

describe("Slack event filtering", () => {
  const base: RawMessage = { type: "message", channel: "C1", user: "U1", ts: "1.1", text: "hi" };

  it("accepts plain messages and thread broadcasts, and marks replies", () => {
    expect(selectMessage(base)).toEqual({ msg: base, edited: false });
    const bc: RawMessage = { ...base, subtype: "thread_broadcast", thread_ts: "1.0" };
    expect(selectMessage(bc)?.edited).toBe(false);
    expect(isThreadReply(bc)).toBe(true);
    expect(isThreadReply({ ...base, thread_ts: base.ts })).toBe(false);
  });

  it("ignores bots, tombstones, joins, deletions and empty text", () => {
    expect(selectMessage({ ...base, bot_id: "B1" })).toBeNull();
    expect(selectMessage({ ...base, subtype: "bot_message" })).toBeNull();
    expect(selectMessage({ ...base, subtype: "channel_join" })).toBeNull();
    expect(selectMessage({ ...base, subtype: "message_deleted" })).toBeNull();
    expect(selectMessage({ ...base, text: "   " })).toBeNull();
    expect(selectMessage({ ...base, ts: undefined })).toBeNull();
    expect(selectMessage({ type: "message", subtype: "message_changed", channel: "C1", message: { ...base, subtype: "tombstone" } })).toBeNull();
  });

  it("treats message_changed as an edit only when the text actually changed", () => {
    const changed = (text: string, prev?: string): RawMessage => ({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      message: { ...base, text },
      ...(prev === undefined ? {} : { previous_message: { ...base, text: prev } }),
    });
    expect(selectMessage(changed("new", "old"))).toMatchObject({ edited: true });
    expect(selectMessage(changed("same", "same"))).toBeNull();
    // Slack omits previous_message for some edits; treat it as an edit rather than dropping it.
    expect(selectMessage(changed("new"))).toMatchObject({ edited: true });
    // An edit of a bot's own message (e.g. Amend's receipt) is never an instruction.
    expect(selectMessage({ type: "message", subtype: "message_changed", channel: "C1", message: { ...base, bot_id: "B1", text: "new" } })).toBeNull();
  });

  it("detects the mention anywhere in the message and strips every copy of it", () => {
    expect(stripMention("<@B1> for Acme it's $50k", "B1")).toEqual({ mentioned: true, text: "for Acme it's $50k" });
    expect(stripMention("for Acme it's $50k <@B1>", "B1").mentioned).toBe(true);
    expect(stripMention("for Acme it's $50k <@B1>", "B1").text).toBe("for Acme it's $50k");
    // Mid-message mention: still detected, and the instruction text survives.
    const mid = stripMention("for Acme <@B1> it's $50k", "B1");
    expect(mid.mentioned).toBe(true);
    expect(mid.text.replace(/\s+/g, " ")).toBe("for Acme it's $50k");
    expect(stripMention("no mention here", "B1")).toEqual({ mentioned: false, text: "no mention here" });
    expect(stripMention("<@B1>", "B1").text).toBe("");
    // A different user's id must not count as a mention of Amend.
    expect(stripMention("<@U999> please look", "B1").mentioned).toBe(false);
  });

  // BUG: MENTION_PREFIX exists to eat the separators after a leading mention ("[\s:,]*"), but the bot's own
  // mention is deleted first, so the prefix no longer matches and the punctuation is left in the instruction.
  it("does not leave punctuation behind when the mention is followed by a colon", () => {
    expect(stripMention("<@B1>: for Acme it's $50k", "B1").text).toBe("for Acme it's $50k");
    expect(stripMention("<@B1|amend>, for Acme it's $50k", "B1").text).toBe("for Acme it's $50k");
  });
});

// ------------------------------------------------------------------ tracked messages, edits, replies

describe("what counts as an instruction", () => {
  it("ignores a top-level message without a mention, and its later edits that still have none", async () => {
    const w = await createWorld();
    expect(await w.say(V1, { ts: TS.root, mentioned: false })).toBeNull();
    expect(await w.say({ ...V1, text: V1.text.replace("$42k", "$50k") }, { ts: TS.root, mentioned: false, edited: true })).toBeNull();
    expect(dealsOf(w)).toHaveLength(0);
    expect(w.chat.posts).toHaveLength(0);
  });

  it("picks up an untracked message whose edit adds the mention", async () => {
    const w = await createWorld();
    expect(await w.say(V1, { ts: TS.root, mentioned: false })).toBeNull();
    const r = await w.say(V1, { ts: TS.root, mentioned: true, edited: true });
    expect(r?.status).toBe("completed");
    expect(dealsOf(w)[0].fields.amount).toBe("42000");
  });

  it("keeps following a tracked message after an edit drops the mention", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    const edited: Msg = { text: V1.text.replace("$42k", "$50k"), facts: { ...BASE_FACTS, deal_amount: ["50000", "$50k"] } };
    const r = await w.say(edited, { ts: TS.root, mentioned: false, edited: true });
    expect(r?.status).toBe("completed");
    expect(dealsOf(w)[0].fields.amount).toBe("50000");
  });

  it("ignores an unmentioned reply in a tracked thread, then honors it once an edit adds the mention", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    const correction = followUp("actually make it $50k", "50000", "$50k");
    expect(await w.say(correction, { ts: TS.r1, threadTs: TS.root, mentioned: false })).toBeNull();
    expect(dealsOf(w)[0].fields.amount).toBe("42000");

    const r = await w.say(correction, { ts: TS.r1, threadTs: TS.root, mentioned: true, edited: true });
    expect(r?.status).toBe("completed");
    expect(dealsOf(w)[0].fields.amount).toBe("50000");
    expect((await w.thread()).parts?.map((p) => p.ts)).toEqual([TS.root, TS.r1]);
  });

  it("keeps a tracked thread alive after its root message is deleted", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    expect(await w.say({ text: "This message was deleted.", facts: {} }, { ts: TS.root, mentioned: false, edited: true })).toBeNull();
    const r = await w.say(followUp("actually make it $50k", "50000", "$50k"), { ts: TS.r1, threadTs: TS.root });
    expect(r?.status).toBe("completed");
    expect(dealsOf(w)[0].fields.amount).toBe("50000");
  });

  it("records the editor as the requester", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root, userId: "U_ALICE" });
    expect((await w.thread()).requestedBy).toBe("U_ALICE");
    await w.say({ text: V1.text.replace("$42k", "$50k"), facts: { ...BASE_FACTS, deal_amount: ["50000", "$50k"] } }, { ts: TS.root, edited: true, userId: "U_BOB" });
    expect((await w.thread()).requestedBy).toBe("U_BOB");
  });

  it("handles a very long instruction", async () => {
    const w = await createWorld();
    const long: Msg = { text: `${V1.text} ${"Context: ".repeat(2000)}`, facts: BASE_FACTS };
    const r = await w.say(long, { ts: TS.root });
    expect(r?.status).toBe("completed");
    expect(dealsOf(w)[0].fields.amount).toBe("42000");
  });

  // BUG: a thread first tracked from a reply records the *reply's* ts as the thread root
  // (handleSlackMessage: `const rootTs = thread?.ts ?? m.ts`). A later edit of the real root message then
  // reuses that ts as its part id and silently overwrites the reply that carried the instruction.
  it("does not lose the reply's instruction when the untracked root message is edited", async () => {
    const w = await createWorld();
    const chatter: Msg = { text: "team, anything on the Acme renewal?", facts: {} };
    expect(await w.say(chatter, { ts: TS.root, mentioned: false })).toBeNull();
    // The instruction arrives as a mentioned reply under that untracked message.
    await w.say(V1, { ts: TS.r1, threadTs: TS.root, mentioned: true });
    expect(dealsOf(w)[0].fields.amount).toBe("42000");

    // Someone fixes a typo in the (still unmentioned) root message.
    await w.say({ text: "team, anything on the Acme renewal today?", facts: {} }, { ts: TS.root, mentioned: false, edited: true });

    const latest = await w.store.latestVersion(`${w.CHANNEL}:${TS.root}`);
    expect(latest?.text).toContain("Deal is $42k");
    expect(dealsOf(w)[0].fields.amount).toBe("42000");
  });
});

// ------------------------------------------------------------------ dedupe

describe("dedupe", () => {
  it("ignores a redelivered event for a routed follow-up: one link notice, one version", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    const f = followUp("for Acme Corp, sorry the deal is $50k not $42k", "50000", "$50k");
    const first = await w.say(f, { ts: TS.f1, eventId: "EV_DUP" });
    const again = await w.say(f, { ts: TS.f1, eventId: "EV_DUP" });

    expect(first?.status).toBe("completed");
    expect(again?.status).toBe("duplicate");
    expect(chatText(w).match(/Treating this as an update/g)).toHaveLength(1);
    expect(await w.store.listVersions(w.THREAD)).toHaveLength(2);
    expect(dealsOf(w)).toHaveLength(1);
  });

  it("ignores an edit that leaves the composed instruction unchanged", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    const r = await w.say(V1, { ts: TS.root, edited: true });
    expect(r?.status).toBe("duplicate");
    expect(await w.store.listVersions(w.THREAD)).toHaveLength(1);
  });

  it("hashes instruction text per thread, so the same words in another thread still run", async () => {
    const store = new MemoryStore();
    const a = await createWorld({ store });
    const b = await createWorld({ store });
    const ra = await a.say(V1, { ts: TS.root });
    const rb = await b.say(V1, { ts: TS.root });
    expect(ra?.status).toBe("completed");
    expect(rb?.status).toBe("completed");
    expect(dealsOf(a)).toHaveLength(1);
    expect(dealsOf(b)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ routing follow-ups

describe("routing follow-up messages", () => {
  it("routes a lower-cased company name to the existing deal", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    const r = await w.say(followUp("for acme corp, make it $50k", "50000", "$50k"), { ts: TS.f1 });
    expect(r?.status).toBe("completed");
    expect(dealsOf(w)).toHaveLength(1);
    expect(dealsOf(w)[0].fields.amount).toBe("50000");
  });

  it("posts the link notice and the receipt in the follow-up's own thread", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    w.chat.posts.length = 0;
    await w.say(followUp("for Acme Corp, make it $50k", "50000", "$50k"), { ts: TS.f1 });
    expect(w.chat.posts.length).toBeGreaterThan(0);
    expect(w.chat.posts.map((p) => p.threadTs)).toEqual(w.chat.posts.map(() => TS.f1));
    expect(w.chat.posts[0].text).toContain("Treating this as an update");
  });

  it("applies a mentioned reply to a routed follow-up to the deal it was routed into", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    await w.say(followUp("for Acme Corp, make it $50k", "50000", "$50k"), { ts: TS.f1 });
    w.chat.posts.length = 0;

    const r = await w.say(followUp("scratch that, $60k", "60000", "$60k"), { ts: TS.r1, threadTs: TS.f1 });
    expect(r?.threadKey).toBe(w.THREAD);
    expect(dealsOf(w)).toHaveLength(1);
    expect(dealsOf(w)[0].fields.amount).toBe("60000");
    expect(w.chat.posts.map((p) => p.threadTs)).toEqual(w.chat.posts.map(() => TS.f1));
  });

  it("keeps corrections in ts order when an earlier follow-up is edited later", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    await w.say(followUp("for Acme Corp, make it $50k", "50000", "$50k"), { ts: TS.f1 });
    await w.say(followUp("for Acme Corp, actually $60k", "60000", "$60k"), { ts: TS.f2 });
    expect(dealsOf(w)[0].fields.amount).toBe("60000");

    // Editing the older follow-up must not make its value win again.
    await w.say(followUp("for Acme Corp, make it $55k", "55000", "$55k"), { ts: TS.f1, mentioned: false, edited: true });
    const latest = await w.store.latestVersion(w.THREAD);
    expect(latest!.text).toBe(`${V1.text}\nUpdate: for Acme Corp, make it $55k\nUpdate: for Acme Corp, actually $60k`);
    expect(dealsOf(w)).toHaveLength(1);
    expect(dealsOf(w)[0].fields.amount).toBe("60000");
  });

  it("follows a routed follow-up's link after a restart", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    await w.say(followUp("for Acme Corp, make it $50k", "50000", "$50k"), { ts: TS.f1 });
    w.restart();
    await w.say(followUp("for Acme Corp, make it $55k", "55000", "$55k"), { ts: TS.f1, mentioned: false, edited: true });
    expect(dealsOf(w)).toHaveLength(1);
    expect(dealsOf(w)[0].fields.amount).toBe("55000");
  });

  it("never offers deals from another channel as routing candidates", async () => {
    const store = new MemoryStore();
    const a = await createWorld({ store });
    const b = await createWorld({ store });
    await a.say(V1, { ts: TS.root });

    const r = await b.say(followUp("for Acme Corp, make it $50k", "50000", "$50k"), { ts: TS.f1 });
    expect(chatText(b)).not.toContain("Treating this as an update");
    expect(r?.threadKey).toBe(`${b.CHANNEL}:${TS.f1}`);
    expect(dealsOf(a)[0].fields.amount).toBe("42000");
  });

  it("asks instead of guessing when a follow-up names two tracked companies", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    await w.say(GLOBEX, { ts: TS.second });

    const both: Msg = { text: "for Acme Corp and Globex, bump it to $50k", facts: { company: "Acme Corp", deal_amount: ["50000", "$50k"] } };
    expect(await w.say(both, { ts: TS.f1 })).toBeNull();
    expect(chatText(w)).toContain("Which deal is this about?");
    expect(dealsOf(w)).toHaveLength(2);
    expect(dealsOf(w).map((d) => d.fields.amount).sort()).toEqual(["20000", "42000"]);
  });

  it("does not create a second deal for a company whose name has diacritics", async () => {
    const w = await createWorld();
    const first: Msg = {
      text: "Zoë Labs is ready, deal is $42k, contact Ana Ruiz (ana@zoe.example)",
      facts: { company: "Zoë Labs", deal_amount: ["42000", "$42k"], contact_name: "Ana Ruiz", contact_email: "ana@zoe.example" },
    };
    await w.say(first, { ts: TS.root });
    expect(dealsOf(w)).toHaveLength(1);

    const correction: Msg = {
      text: "for Zoë Labs, make it $50k not $42k",
      facts: { company: "Zoë Labs", deal_amount: ["50000", "$50k"] },
      composedFacts: { company: "Zoë Labs", deal_amount: ["50000", "$50k"], contact_name: "Ana Ruiz", contact_email: "ana@zoe.example" },
    };
    await w.say(correction, { ts: TS.f1 });
    // BUG: sameCompany() tokenizes on [a-z0-9@.] only, so "zoë" becomes the 2-char token "zo" and is
    // discarded; the company never matches itself and Amend opens a duplicate deal.
    expect(dealsOf(w)).toHaveLength(1);
    expect(dealsOf(w)[0].fields.amount).toBe("50000");
  });

  // BUG: routeNewMessage only offers threads that already have a dealId, so a correction that lands
  // while the first run is still creating the deal is treated as a brand-new deal.
  it("does not duplicate the deal when a correction arrives mid-create", async () => {
    let w!: World;
    let fired: Promise<unknown> | null = null;
    const hooks: EngineHooks = {
      beforeWrite: async ({ resource, op }) => {
        if (resource === "deal" && op === "create" && !fired) {
          // Fire the correction mid-create without awaiting it here: once routing correctly joins the
          // in-flight deal, the correction queues behind this run's per-thread lock, so awaiting it
          // inside this hook would deadlock the test itself. Let it register its version, then return.
          fired = w.say(followUp("for Acme Corp, make it $50k not $42k", "50000", "$50k"), { ts: TS.f1 });
          await new Promise((r) => setTimeout(r, 20));
        }
      },
    };
    w = await createWorld({ hooks });
    await w.say(V1, { ts: TS.root });
    await fired;
    expect(dealsOf(w)).toHaveLength(1);
  });

  it("converges on the later value when a correction is routed in mid-run", async () => {
    let w!: World;
    let fired: Promise<unknown> | null = null;
    const hooks: EngineHooks = {
      beforeWrite: async ({ resource, op }) => {
        if (resource === "deal" && op === "update" && !fired) {
          fired = w.say(followUp("for Acme Corp, make it $70k", "70000", "$70k"), { ts: TS.f2 });
          // Let the correction register its version before this write proceeds.
          for (let i = 0; i < 200 && ((await w.store.latestVersion(w.THREAD))?.version ?? 0) < 3; i++) {
            await new Promise((r) => setTimeout(r, 5));
          }
        }
      },
    };
    w = await createWorld({ hooks });
    await w.say(V1, { ts: TS.root });
    await w.say(followUp("for Acme Corp, make it $50k", "50000", "$50k"), { ts: TS.f1 });
    await fired;
    expect(dealsOf(w)).toHaveLength(1);
    expect(dealsOf(w)[0].fields.amount).toBe("70000");
  });
});

// ------------------------------------------------------------------ clarification, merge

describe("unclear routing and merging", () => {
  const AMBIGUOUS: Msg = { text: "sorry, it's $50k not $42k", facts: { deal_amount: ["50000", "$50k"] } };

  async function twoDealsThenAmbiguous() {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    await w.say(GLOBEX, { ts: TS.second });
    const r = await w.say(AMBIGUOUS, { ts: TS.f1 });
    expect(r).toBeNull();
    expect(chatText(w)).toContain("Which deal is this about?");
    return w;
  }

  it("folds the conversation into the deal named by a mentioned answer", async () => {
    const w = await twoDealsThenAmbiguous();
    const answer: Msg = { text: "it's Acme Corp", facts: { company: "Acme Corp" }, composedFacts: { ...BASE_FACTS, deal_amount: ["50000", "$50k"] } };
    const r = await w.say(answer, { ts: TS.r1, threadTs: TS.f1, mentioned: true });
    expect(r?.threadKey).toBe(w.THREAD);
    expect(dealsOf(w)).toHaveLength(2);
    expect(dealFor(w, w.THREAD)?.fields.amount).toBe("50000");
    expect((await w.store.getThread(`${w.CHANNEL}:${TS.f1}`))?.mergedInto).toBe(w.THREAD);
  });

  // BUG: Amend asks "Reply here with the company", but an unmentioned reply in the thread it just
  // created is dropped by the isTracked() gate, so the answer to its own question is ignored.
  it("honors the answer to its own question even without a mention", async () => {
    const w = await twoDealsThenAmbiguous();
    const answer: Msg = { text: "it's Acme Corp", facts: { company: "Acme Corp" }, composedFacts: { ...BASE_FACTS, deal_amount: ["50000", "$50k"] } };
    const r = await w.say(answer, { ts: TS.r1, threadTs: TS.f1, mentioned: false });
    expect(r).not.toBeNull();
    expect(dealFor(w, w.THREAD)?.fields.amount).toBe("50000");
  });

  it("starts a new deal when the answer names a company nobody is tracking", async () => {
    const w = await twoDealsThenAmbiguous();
    const answer: Msg = {
      text: "it's for Initech, $30k, contact Bill Lumbergh (bill@initech.example)",
      facts: { company: "Initech", deal_amount: ["30000", "$30k"], contact_name: "Bill Lumbergh", contact_email: "bill@initech.example" },
      composedFacts: { company: "Initech", deal_amount: ["30000", "$30k"], contact_name: "Bill Lumbergh", contact_email: "bill@initech.example" },
    };
    const r = await w.say(answer, { ts: TS.r1, threadTs: TS.f1, mentioned: true });
    expect(r?.status).toBe("completed");
    expect(dealsOf(w)).toHaveLength(3);
    expect(dealFor(w, w.THREAD)?.fields.amount).toBe("42000");
    expect((await w.store.getThread(`${w.CHANNEL}:${TS.f1}`))?.mergedInto).toBeUndefined();
  });

  it("keeps following the conversation after a merge instead of merging twice", async () => {
    const w = await twoDealsThenAmbiguous();
    const answer: Msg = { text: "it's Acme Corp", facts: { company: "Acme Corp" }, composedFacts: { ...BASE_FACTS, deal_amount: ["50000", "$50k"] } };
    await w.say(answer, { ts: TS.r1, threadTs: TS.f1, mentioned: true });

    const more = followUp("make it $60k", "60000", "$60k");
    const r = await w.say(more, { ts: TS.r2, threadTs: TS.f1, mentioned: true });
    expect(r?.threadKey).toBe(w.THREAD);
    expect(dealsOf(w)).toHaveLength(2);
    expect(dealFor(w, w.THREAD)?.fields.amount).toBe("60000");
    const parts = (await w.thread()).parts!;
    expect(parts.map((p) => p.ts)).toEqual([TS.root, TS.f1, TS.r1, TS.r2]);
  });

  it("routes a later message to the merge target, never to the merged-away conversation", async () => {
    const w = await twoDealsThenAmbiguous();
    const answer: Msg = { text: "it's Acme Corp", facts: { company: "Acme Corp" }, composedFacts: { ...BASE_FACTS, deal_amount: ["50000", "$50k"] } };
    await w.say(answer, { ts: TS.r1, threadTs: TS.f1, mentioned: true });

    const later = await w.say(followUp("for Acme Corp, make it $70k", "70000", "$70k"), { ts: TS.r2 });
    expect(later?.threadKey).toBe(w.THREAD);
    expect(dealsOf(w)).toHaveLength(2);
    expect(dealFor(w, w.THREAD)?.fields.amount).toBe("70000");
  });

  it("never merges a conversation that already has its own deal", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    await w.say(GLOBEX, { ts: TS.second });
    // A reply inside Globex's own thread that names Acme must not move the Globex deal into Acme.
    const confusing: Msg = {
      text: "this is really for Acme Corp",
      facts: { company: "Acme Corp" },
      composedFacts: { company: "Acme Corp", deal_amount: ["20000", "$20k"], contact_name: "Hank Scorpio", contact_email: "hank@globex.io" },
    };
    await w.say(confusing, { ts: TS.r1, threadTs: TS.second, mentioned: true });
    expect(dealsOf(w)).toHaveLength(2);
    expect((await w.store.getThread(`${w.CHANNEL}:${TS.second}`))?.mergedInto).toBeUndefined();
    expect(dealFor(w, w.THREAD)?.fields.amount).toBe("42000");
  });

  // BUG: the "which deal?" branch returns before handleInstruction, so the event id is never recorded.
  // A Slack redelivery of the same event then takes a different path and posts a second, contradictory
  // question ("Which company is this for?") for the one message.
  it("asks only once when the same ambiguous message is redelivered", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root });
    await w.say(GLOBEX, { ts: TS.second });
    await w.say(AMBIGUOUS, { ts: TS.f1, eventId: "EV_ASK" });
    const asked = w.chat.posts.length;

    await w.say(AMBIGUOUS, { ts: TS.f1, eventId: "EV_ASK" });
    expect(w.chat.posts.length).toBe(asked);
    expect(dealsOf(w)).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ dedicated-channel mode

describe("dedicated channel mode", () => {
  it("treats a top-level message without a mention as an instruction", async () => {
    const w = await createWorld();
    const r = await w.say(V1, { ts: TS.root, mentioned: false, channelMode: true });
    expect(r?.status).toBe("completed");
    expect(dealsOf(w)).toHaveLength(1);
  });

  it("still requires a mention on thread replies (documented: only top-level messages are free)", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root, mentioned: false, channelMode: true });
    const correction = followUp("actually make it $50k", "50000", "$50k");
    expect(await w.say(correction, { ts: TS.r1, threadTs: TS.root, mentioned: false, channelMode: true })).toBeNull();
    expect(dealsOf(w)[0].fields.amount).toBe("42000");
    expect(await w.say(correction, { ts: TS.r1, threadTs: TS.root, mentioned: true, channelMode: true })).not.toBeNull();
    expect(dealsOf(w)[0].fields.amount).toBe("50000");
  });
});

// ------------------------------------------------------------------ route.ts heuristics

describe("route heuristics", () => {
  it("matches company names across case, suffixes and possessives", () => {
    expect(sameCompany("Acme", "Acme Corp")).toBe(true);
    expect(sameCompany("ACME CORP", "acme")).toBe(true);
    expect(sameCompany("Amicoo Inc", "amicoo")).toBe(true);
    expect(sameCompany("Acme Corp", "Globex")).toBe(false);
    // Two different companies that share only a stop word must not match.
    expect(sameCompany("Northwind Group", "Southwind Group")).toBe(false);
    expect(mentionsCandidate("bump Acme's deal to $50k", { company: "Acme Corp" })).toBe(true);
    expect(mentionsCandidate("bump the deal to $50k", { company: "Acme Corp" })).toBe(false);
  });

  // BUG: words() splits on anything outside [a-z0-9@.] and then drops tokens shorter than 3 chars,
  // so companies with accents or short names never match themselves and get duplicate deals.
  it("matches a company against itself whatever its name looks like", () => {
    for (const name of ["Zoë Labs", "3M", "Nestlé", "Škoda Auto"]) {
      expect([name, sameCompany(name, name)]).toEqual([name, true]);
      expect([name, mentionsCandidate(`bump ${name} to $50k`, { company: name })]).toEqual([name, true]);
    }
  });

  it("HeuristicRouter prefers an explicit new-deal phrase over a single candidate", async () => {
    const c: RouteCandidate = { threadKey: "T1", company: "Acme Corp", instruction: "..." };
    const r = new HeuristicRouter();
    expect(await r.route("Acme Corp wants a separate deal for $10k", [c])).toMatchObject({ kind: "new" });
    expect(await r.route("for Acme, make it $50k", [c])).toMatchObject({ kind: "existing", threadKey: "T1" });
    expect(await r.route("for Acme, make it $50k", [c, { ...c, threadKey: "T2" }])).toMatchObject({ kind: "unclear" });
    // Resolved product decision (see the matching note in llm.test.ts): with zero candidates there
    // is nothing to fold into by definition, so "new" is the only sensible answer — "unclear" would
    // ask a question about which of no deals is meant.
    expect(await r.route("anything", [])).toMatchObject({ kind: "new" });
  });

  it("survives a router that throws without writing anything", async () => {
    const boom: Router = {
      async route() {
        throw new Error("router exploded");
      },
    };
    const w = await createWorld({ router: boom });
    await w.say(V1, { ts: TS.root });
    await expect(w.say(followUp("for Acme Corp, make it $50k", "50000", "$50k"), { ts: TS.f1 })).rejects.toThrow("router exploded");
    expect(dealsOf(w)).toHaveLength(1);
    expect(dealsOf(w)[0].fields.amount).toBe("42000");
  });

  // BUG: handleSlackMessage dereferences the routed thread with `target!.ts` and links the message before
  // checking that the thread exists, so a router that names an unknown thread throws (the Bolt handler
  // swallows it, dropping the message) after the message has already been linked to the missing thread.
  it("ignores a router that points at a thread it was never offered", async () => {
    const bogus = new ScriptedRouter(() => ({ kind: "existing", threadKey: "C_NOPE:1.1", reason: "made up" }));
    const w = await createWorld({ router: bogus });
    await w.say(V1, { ts: TS.root });
    const msgKey = `${w.CHANNEL}:${TS.f1}`;
    await expect(w.say(followUp("for Acme Corp, make it $50k", "50000", "$50k"), { ts: TS.f1 })).resolves.not.toThrow();
    expect(await w.store.resolveLink(msgKey)).not.toBe("C_NOPE:1.1");
  });
});

describe("working indicator", () => {
  it("shows a working message while the instruction runs and removes it once the receipt is posted", async () => {
    let seenDuring: string[] = [];
    let w!: World;
    w = await createWorld({ hooks: { afterExtract: async () => void (seenDuring = w.chat.posts.map((p) => p.text)) } });
    await w.say(V1, { ts: TS.root });
    expect(seenDuring.some((t) => /working on it/.test(t))).toBe(true);
    expect(w.chat.posts.some((p) => /working on it/.test(p.text))).toBe(false);
    expect(w.chat.history.filter((p) => p.deleted && /working on it/.test(p.text))).toHaveLength(1);
    expect(w.chat.posts.length).toBeGreaterThan(0);
  });

  it("removes the working message even when the run throws", async () => {
    const w = await createWorld();
    await expect(w.engine.handleInstruction({ threadKey: w.THREAD, channel: w.CHANNEL, ts: w.ROOT_TS, text: "no fixture for this" })).rejects.toThrow();
    expect(w.chat.posts.some((p) => /working on it/.test(p.text))).toBe(false);
  });

  it("does not flash a working message for a duplicate event", async () => {
    const w = await createWorld();
    await w.say(V1, { ts: TS.root, eventId: "same" });
    const before = w.chat.history.length;
    await w.say(V1, { ts: TS.root, eventId: "same" });
    expect(w.chat.history.length).toBe(before);
  });
});
