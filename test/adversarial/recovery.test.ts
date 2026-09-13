/**
 * Adversarial tests for the recovery / retry / concurrency surface of the engine:
 * recover(), retry bookkeeping, version fencing, the watcher, drain(), and the
 * interleaving of handleSlackMessage / resolveConflict / approveSend / recover / watchOnce.
 *
 * Tests marked `// BUG:` document real defects and are expected to fail until fixed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimulatedCrash } from "../../src/adapters/fakes.js";
import { MAX_RETRY_ATTEMPTS } from "../../src/engine/engine.js";
import { BASE_FACTS, V1, createWorld, editOf, type Msg } from "../helpers/world.js";

type World = Awaited<ReturnType<typeof createWorld>>;

const AMOUNT_50K = editOf([["$42k", "$50k"]], { deal_amount: ["50000", "$50k"] });
const DATE_NOV_3 = editOf([["Oct 15", "Nov 3"]], { close_date: ["2026-11-03", "Nov 3"] });
const CANCELLED: Msg = {
  text: `${V1.text} UPDATE: deal is cancelled.`,
  facts: { ...BASE_FACTS, cancelled: ["true", "deal is cancelled"] },
};
const SEND_NOW: Msg = {
  text: `${V1.text} Go ahead and email it to her now.`,
  facts: { ...BASE_FACTS, delivery: ["send", "Go ahead and email it to her now"] },
};

/** Runs an engine call that may die with a simulated process crash. */
async function crashy<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof SimulatedCrash) return undefined;
    throw e;
  }
}

async function recover(w: World) {
  return w.engine.recover({ channel: w.CHANNEL, ignoreBackoff: true });
}

/** Everything Amend said in Slack, text and blocks. */
function chatText(w: World) {
  return w.chat.posts.map((p) => `${p.text} ${JSON.stringify(p.blocks ?? [])}`).join("\n");
}

/** Everything an outside observer can see about the final state of a world. */
async function snapshot(w: World) {
  const t = await w.thread();
  const deal = await w.deal();
  const draft = await w.draft();
  return {
    dealFields: deal?.fields,
    dealsTotal: w.crm.deals.size,
    draft: draft ? { to: draft.to, subject: draft.subject, body: draft.body } : undefined,
    draftsCreatedTotal: w.mail.createdTotal,
    liveDrafts: w.mail.drafts.size,
    sent: w.mail.sent.map((s) => ({ to: s.to, subject: s.subject, body: s.body })),
    completedVersion: t.completedVersion,
    sentDraftIds: t.sentDraftIds.length,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Makes every HubSpot update fail transiently for the rest of the world's life. */
function breakCrmUpdate(w: World, times = 200) {
  w.crm.faults.inject("crm.update", ...(Array(times).fill("transient") as "transient"[]));
}

// ------------------------------------------------------------------ crash at every write op

describe("crash at a write op, restart, recover", () => {
  const cases: Array<{ op: string; adapter: "crm" | "mail"; steps: Msg[] }> = [
    { op: "crm.create", adapter: "crm", steps: [V1] },
    { op: "crm.update", adapter: "crm", steps: [V1, AMOUNT_50K] },
    { op: "mail.create", adapter: "mail", steps: [V1] },
    { op: "mail.update", adapter: "mail", steps: [V1, AMOUNT_50K] },
    { op: "mail.delete", adapter: "mail", steps: [V1, CANCELLED] },
    { op: "mail.send", adapter: "mail", steps: [SEND_NOW] },
  ];

  for (const c of cases) {
    it(`${c.op}: final state equals the clean run, with no duplicates`, async () => {
      const clean = await createWorld();
      for (const m of c.steps) await clean.instruct(m);
      const expected = await snapshot(clean);

      const w = await createWorld();
      for (const m of c.steps.slice(0, -1)) await w.instruct(m);
      w[c.adapter].faults.inject(c.op, "crash_after_commit");
      await crashy(w.instruct(c.steps[c.steps.length - 1]));
      // The crash really did interrupt the run: the latest version is not marked complete.
      expect((await w.thread()).completedVersion).not.toBe(expected.completedVersion);
      w.restart();
      // A crash can leave several steps unfinished; recover until it converges.
      for (let i = 0; i < 3; i++) await recover(w);

      const actual = await snapshot(w);
      expect(actual.dealFields).toEqual(expected.dealFields);
      expect(actual.dealsTotal).toBe(expected.dealsTotal);
      expect(actual.draftsCreatedTotal).toBe(expected.draftsCreatedTotal);
      expect(actual.liveDrafts).toBe(expected.liveDrafts);
      expect(actual.draft?.body).toBe(expected.draft?.body);
      expect(actual.draft?.to).toBe(expected.draft?.to);
      expect(actual.sent).toEqual(expected.sent);
      expect(actual.completedVersion).toBe(expected.completedVersion);
      // The thread hears about the run that recovered.
      expect(w.chat.posts.length).toBeGreaterThan(0);
    });
  }
});

// ------------------------------------------------------------------ recover() selection rules

describe("recover() selection", () => {
  it("re-extracts a version whose extraction never got saved", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const real = w.extractor.extract.bind(w.extractor);
    let boom = true;
    w.extractor.extract = async (text: string) => {
      if (boom) {
        boom = false;
        throw new Error("extractor died mid-call");
      }
      return real(text);
    };
    w.extractor.add(AMOUNT_50K);
    await expect(w.instruct(AMOUNT_50K)).rejects.toThrow("extractor died");

    const v2 = await w.store.latestVersion(w.THREAD);
    expect(v2!.version).toBe(2);
    expect(v2!.extraction).toBeUndefined();

    w.restart();
    const reports = await recover(w);
    expect(reports.map((r) => r.status)).toEqual(["completed"]);
    expect((await w.deal())!.fields.amount).toBe("50000");
    expect((await w.store.latestVersion(w.THREAD))!.extraction).toBeDefined();
  });

  it("skips threads older than maxAgeMs and still picks them up with a wider window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const w = await createWorld();
    w.mail.faults.inject("mail.create", "crash_after_commit");
    await crashy(w.instruct(V1));
    w.restart();
    vi.advanceTimersByTime(10 * 60_000);

    expect(await w.engine.recover({ channel: w.CHANNEL, ignoreBackoff: true, maxAgeMs: 60_000 })).toEqual([]);
    expect((await w.thread()).completedVersion).toBeUndefined();

    const done = await w.engine.recover({ channel: w.CHANNEL, ignoreBackoff: true, maxAgeMs: 3600_000 });
    expect(done).toHaveLength(1);
    expect((await w.thread()).completedVersion).toBe(1);
  });

  it("only recovers threads in the requested channel", async () => {
    const w = await createWorld();
    w.mail.faults.inject("mail.create", "crash_after_commit");
    await crashy(w.instruct(V1));
    w.restart();

    expect(await w.engine.recover({ channel: "C_somewhere_else", ignoreBackoff: true })).toEqual([]);
    expect((await w.thread()).completedVersion).toBeUndefined();
    expect(await recover(w)).toHaveLength(1);
  });

  it("does nothing for a thread whose latest version already completed", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const before = w.crm.calls.length + w.mail.calls.length;
    w.restart();
    expect(await recover(w)).toEqual([]);
    expect(w.crm.calls.length + w.mail.calls.length).toBe(before);
  });
});

// ------------------------------------------------------------------ retry bookkeeping

describe("retry accounting", () => {
  it("counts one attempt per run and stops at the cap", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    breakCrmUpdate(w);
    const r = await w.instruct(AMOUNT_50K);
    expect(r.status).toBe("needs_attention");
    expect((await w.thread()).retry).toMatchObject({ version: 2, attempts: 1 });

    const postsBeforeRetries = w.chat.posts.length;
    for (let i = 2; i <= MAX_RETRY_ATTEMPTS; i++) {
      const reports = await recover(w);
      expect(reports).toHaveLength(1);
      expect((await w.thread()).retry!.attempts).toBe(i);
      // Quiet while it is still going to try again; it only speaks up on the last attempt.
      if (i < MAX_RETRY_ATTEMPTS) expect(w.chat.posts.length).toBe(postsBeforeRetries);
    }
    // Cap reached: the sweep leaves it alone.
    expect(await recover(w)).toEqual([]);
    expect((await w.thread()).retry!.attempts).toBe(MAX_RETRY_ATTEMPTS);
    expect(chatText(w)).toContain(`Gave up after ${MAX_RETRY_ATTEMPTS} attempts`);
  });

  it("a new Slack edit after the cap starts a fresh run and can succeed", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    breakCrmUpdate(w, 4 * MAX_RETRY_ATTEMPTS);
    await w.instruct(AMOUNT_50K);
    for (let i = 2; i <= MAX_RETRY_ATTEMPTS; i++) await recover(w);
    expect(await recover(w)).toEqual([]);

    // HubSpot is healthy again and the lead edits the message.
    const r = await w.instruct(DATE_NOV_3);
    expect(r.status).toBe("completed");
    const t = await w.thread();
    expect(t.retry).toBeUndefined();
    expect(t.completedVersion).toBe(3);
    expect((await w.deal())!.fields.closedate).toBe("2026-11-03");
    // The sweep has nothing left to do.
    expect(await recover(w)).toEqual([]);
  });

  it("honors the backoff window before retrying, and retries once it elapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const w = await createWorld();
    await w.instruct(V1);
    breakCrmUpdate(w);
    await w.instruct(AMOUNT_50K);
    const retryState = (await w.thread()).retry!;
    expect(retryState.attempts).toBe(1);

    // attempt 1 → 20s backoff.
    vi.advanceTimersByTime(19_000);
    expect(await w.engine.recover({ channel: w.CHANNEL })).toEqual([]);
    expect((await w.thread()).retry!.attempts).toBe(1);

    vi.advanceTimersByTime(2_000);
    expect(await w.engine.recover({ channel: w.CHANNEL })).toHaveLength(1);
    expect((await w.thread()).retry!.attempts).toBe(2);

    // attempt 2 → 40s backoff.
    vi.advanceTimersByTime(30_000);
    expect(await w.engine.recover({ channel: w.CHANNEL })).toEqual([]);
    vi.advanceTimersByTime(15_000);
    expect(await w.engine.recover({ channel: w.CHANNEL })).toHaveLength(1);
    expect((await w.thread()).retry!.attempts).toBe(3);
  });

  it("does not retry a permanent (non-transient) failure inside one run", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const updates0 = w.crm.calls.filter((c) => c === "crm.update").length;
    const real = w.crm.updateDeal.bind(w.crm);
    let first = true;
    w.crm.updateDeal = async (id, fields) => {
      w.crm.calls.push("crm.update");
      if (first) {
        first = false;
        throw new Error("400 invalid property value");
      }
      return real(id, fields);
    };
    const r = await w.instruct(AMOUNT_50K);
    expect(r.status).toBe("needs_attention");
    // Exactly one call: a permanent error must not be retried inside the run.
    expect(w.crm.calls.filter((c) => c === "crm.update").length - updates0).toBe(1);
    expect((await w.thread()).retry).toMatchObject({ version: 2, attempts: 1 });
    // ...but the sweep still retries the run as a whole, and it succeeds.
    expect(await recover(w)).toHaveLength(1);
    expect((await w.deal())!.fields.amount).toBe("50000");
    expect((await w.thread()).retry).toBeUndefined();
  });
});

// ------------------------------------------------------------------ version fencing

describe("version fencing", () => {
  it("stops the in-flight run at its next write and leaves no pending ledger entries", async () => {
    let raced = false;
    const w = await createWorld({
      hooks: {
        async beforeWrite({ op }) {
          if (op !== "create" || raced) return;
          raced = true;
          const before = (await w.store.latestVersion(w.THREAD))!.version;
          void w.instruct(AMOUNT_50K).catch(() => {});
          for (let i = 0; i < 400 && (await w.store.latestVersion(w.THREAD))!.version === before; i++) {
            await new Promise((r) => setTimeout(r, 1));
          }
        },
      },
    });
    const r = await w.instruct(V1);
    expect(r.status).toBe("superseded");
    // Give the racing v2 run time to finish behind the lock.
    for (let i = 0; i < 200 && (await w.thread()).completedVersion !== 2; i++) await new Promise((r) => setTimeout(r, 1));

    const ledger = await w.store.listLedger(w.THREAD);
    expect(ledger.filter((e) => e.status === "pending")).toEqual([]);
    expect((await w.deal())!.fields.amount).toBe("50000");
    expect(w.crm.deals.size).toBe(1);
    expect(w.mail.createdTotal).toBe(1);
  });
});

// ------------------------------------------------------------------ drain / track

describe("track() and drain()", () => {
  it("drains tracked work and reports success", async () => {
    const w = await createWorld();
    const p = w.engine.track(w.instruct(V1));
    const drained = w.engine.drain(5_000);
    await p;
    expect(await drained).toBe(true);
  });

  it("reports failure when work is still in flight at the deadline", async () => {
    const w = await createWorld();
    let release!: () => void;
    w.engine.track(new Promise<void>((r) => (release = r)));
    expect(await w.engine.drain(0)).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(await w.engine.drain(0)).toBe(true);
  });

  it("does not reject when tracked work fails", async () => {
    const w = await createWorld();
    w.engine.track(Promise.reject(new Error("boom"))).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(await w.engine.drain(0)).toBe(true);
  });
});

// ------------------------------------------------------------------ concurrent recover / live runs

const tick = () => new Promise((r) => setTimeout(r, 1));

/** A world whose next matching write pauses so a concurrent edit can land first. */
async function worldWithRace() {
  let armed: { op: string; run: () => Promise<void> } | null = null;
  let w!: World;
  const pending: Promise<unknown>[] = [];
  w = await createWorld({
    hooks: {
      async beforeWrite({ op, resource }) {
        if (!armed || (armed.op !== op && armed.op !== `${resource}:${op}`)) return;
        const a = armed;
        armed = null;
        await a.run();
      },
    },
  });
  return {
    w,
    /** At the next write matching `op`, deliver `msg` as an edit and wait until its version is registered. */
    armEdit(op: string, msg: Msg) {
      armed = {
        op,
        run: async () => {
          const before = (await w.store.latestVersion(w.THREAD))?.version ?? 0;
          pending.push(w.instruct(msg).catch(() => {}));
          for (let i = 0; i < 500 && ((await w.store.latestVersion(w.THREAD))?.version ?? 0) === before; i++) await tick();
        },
      };
    },
    /** At the next write matching `op`, run `fn` and wait for it to finish. */
    armRun(op: string, fn: () => Promise<void>) {
      armed = { op, run: fn };
    },
    settle: () => Promise.all(pending),
  };
}

describe("concurrent recovery", () => {
  it("a second recover() on the same engine is a no-op while one is running", async () => {
    const w = await createWorld();
    w.mail.faults.inject("mail.create", "crash_after_commit");
    await crashy(w.instruct(V1));
    w.restart();
    const [a, b] = await Promise.all([recover(w), recover(w)]);
    expect(a.length + b.length).toBe(1);
  });

  it("two engines over the same store do not both resume the same run", async () => {
    const w = await createWorld();
    w.mail.faults.inject("mail.create", "crash_after_commit");
    await crashy(w.instruct(V1));
    const e1 = w.engine;
    const e2 = w.restart();
    const [a, b] = await Promise.all([
      e1.recover({ channel: w.CHANNEL, ignoreBackoff: true }),
      e2.recover({ channel: w.CHANNEL, ignoreBackoff: true }),
    ]);
    // No duplicates either way, but the thread must not be resumed (and reported) twice.
    expect(w.mail.createdTotal).toBe(1);
    expect(w.crm.deals.size).toBe(1);
    // BUG: the `recovering` guard is per Engine instance, so every process/instance resumes the same
    // run and posts its own "Resumed a run that was interrupted by a restart" receipt.
    expect(a.length + b.length).toBe(1);
  });

  it("does not resume a run that is still in flight behind the lock", async () => {
    const r = await worldWithRace();
    const { w } = r;
    // The sweep is started while the live run holds the thread lock. It must not be awaited here:
    // recover() would wait for the very lock this hook is blocking.
    let sweep: ReturnType<typeof recover> | undefined;
    r.armRun("draft:create", async () => {
      sweep = w.engine.recover({ channel: w.CHANNEL, ignoreBackoff: true });
      for (let i = 0; i < 30; i++) await tick();
    });
    const report = await w.instruct(V1);
    const resumed = await sweep!;
    await r.settle();

    expect(report.status).toBe("completed");
    expect(w.mail.createdTotal).toBe(1);
    expect(w.crm.deals.size).toBe(1);
    // BUG: recover() only looks at completedVersion, which a live run has not written yet, so it
    // queues a duplicate run behind the lock and tells the thread a restart interrupted something.
    expect(resumed).toEqual([]);
    expect(chatText(w)).not.toContain("Resumed a run that was interrupted by a restart");
  });

  it("one thread whose extraction keeps failing must not starve the rest of the sweep", async () => {
    const w = await createWorld();
    // Thread B: a normal run interrupted by a crash.
    w.mail.faults.inject("mail.create", "crash_after_commit");
    await crashy(w.instruct(V1));

    // Thread A (newer, so the sweep reaches it first): its version was appended but extraction failed.
    const poisonedKey = `${w.CHANNEL}:1726000900.000500`;
    await expect(
      w.engine.handleInstruction({ threadKey: poisonedKey, channel: w.CHANNEL, ts: "1726000900.000500", text: "Globex is ready, $10k" }),
    ).rejects.toThrow();
    expect((await w.store.latestVersion(poisonedKey))!.extraction).toBeUndefined();

    w.restart();
    await recover(w).catch(() => {});
    // BUG: recoverOnce() has no per-thread error boundary, so one thread that always throws
    // (extraction, or any run error) blocks recovery of every thread behind it, forever.
    expect((await w.thread()).completedVersion).toBe(1);
    expect(await w.draft()).toBeDefined();
  });
});

// ------------------------------------------------------------------ races between entrypoints

describe("races between Slack, the send button and conflicts", () => {
  it("an edit landing during a send stops it and the new version sends exactly once", async () => {
    const r = await worldWithRace();
    const { w } = r;
    const send50k: Msg = {
      text: `${V1.text.replace("$42k", "$50k")} Go ahead and email it to her now.`,
      facts: { ...BASE_FACTS, deal_amount: ["50000", "$50k"], delivery: ["send", "Go ahead and email it to her now"] },
    };
    r.armEdit("send", send50k);
    const first = await w.instruct(SEND_NOW);
    await r.settle();

    expect(first.notes.join(" ")).toContain("Send skipped");
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0].body).toContain("$50,000");
    expect(w.mail.sent[0].body).not.toContain("$42,000");
    expect((await w.deal())!.fields.amount).toBe("50000");
  });

  it("the Send button refuses when the instruction is edited while it holds the lock", async () => {
    const r = await worldWithRace();
    const { w } = r;
    const card = (await w.instruct(V1)).email!;
    r.armEdit("send", AMOUNT_50K);
    const res = await w.engine.approveSend({ threadKey: w.THREAD, draftId: card.draftId, bodyToken: card.bodyToken, userId: "u_lead" });
    await r.settle();

    expect(res.ok).toBe(false);
    expect(res.message).toContain("edited just now");
    expect(w.mail.sent).toHaveLength(0);
    expect((await w.thread()).sentDraftIds).toEqual([]);
    // The newer instruction still converges.
    expect((await w.deal())!.fields.amount).toBe("50000");
    expect((await w.draft())!.body).toContain("$50,000");
  });

  it("a conflict resolution superseded by a new edit still converges", async () => {
    const r = await worldWithRace();
    const { w } = r;
    await w.instruct(V1);
    const dealId = (await w.thread()).dealId!;
    w.crm.humanEdit(dealId, { amount: "39000" });
    const conflicted = await w.instruct(AMOUNT_50K);
    const conflictId = conflicted.outcomes.find((o) => o.kind === "conflict")!.conflictId!;

    const nov3And50k = editOf([["$42k", "$50k"], ["Oct 15", "Nov 3"]], { deal_amount: ["50000", "$50k"], close_date: ["2026-11-03", "Nov 3"] });
    r.armEdit("update", nov3And50k);
    await w.engine.resolveConflict({ threadKey: w.THREAD, conflictId, choice: "apply_new", userId: "u_lead" });
    await r.settle();

    const deal = (await w.deal())!;
    expect(deal.fields.amount).toBe("50000");
    expect(deal.fields.closedate).toBe("2026-11-03");
    expect((await w.store.listConflicts(w.THREAD)).filter((c) => c.status === "open")).toEqual([]);
    expect(w.crm.deals.size).toBe(1);
    expect((await w.store.listLedger(w.THREAD)).filter((e) => e.status === "pending")).toEqual([]);
  });

  it("two thread replies delivered at the same time both stay part of the instruction", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const amountReply: Msg = {
      text: "make it $50k",
      facts: { deal_amount: ["50000", "$50k"] },
      composedFacts: { ...BASE_FACTS, deal_amount: ["50000", "$50k"], next_step: "security review" },
    };
    const stepReply: Msg = {
      text: "next step is security review",
      facts: { next_step: "security review" },
      composedFacts: { ...BASE_FACTS, deal_amount: ["50000", "$50k"], next_step: "security review" },
    };
    w.extractor.add(amountReply);
    w.extractor.add(stepReply);

    await Promise.all([
      w.engine.handleInstruction({ threadKey: w.THREAD, channel: w.CHANNEL, ts: w.ROOT_TS, partTs: "1726000100.000200", text: amountReply.text, eventId: "evA" }),
      w.engine.handleInstruction({ threadKey: w.THREAD, channel: w.CHANNEL, ts: w.ROOT_TS, partTs: "1726000200.000300", text: stepReply.text, eventId: "evB" }),
    ]);

    // BUG: handleInstruction reads the thread, appends its part and upserts *outside* withLock, so two
    // messages arriving together clobber each other and one instruction is silently dropped.
    const latest = (await w.store.latestVersion(w.THREAD))!;
    expect(latest.text).toContain("make it $50k");
    expect(latest.text).toContain("next step is security review");
    expect((await w.thread()).parts).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ watcher

describe("watcher", () => {
  async function openConflicts(w: World) {
    return (await w.store.listConflicts(w.THREAD)).filter((c) => c.status === "open");
  }

  it("says nothing when a field is changed and changed back before the pass", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const dealId = (await w.thread()).dealId!;
    w.crm.humanEdit(dealId, { amount: "39000" });
    w.crm.humanEdit(dealId, { amount: "42000" });

    expect(await w.engine.watchOnce({ channel: w.CHANNEL })).toBe(0);
    expect(await openConflicts(w)).toEqual([]);
    expect(chatText(w)).not.toContain("was changed outside Amend");
  });

  it("reports a change the human made while a pass was already running", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const dealId = (await w.thread()).dealId!;
    const realFind = w.crm.findChangedSince.bind(w.crm);
    let once = true;
    w.crm.findChangedSince = async (since: number) => {
      const r = await realFind(since);
      if (once) {
        once = false;
        w.crm.humanEdit(dealId, { amount: "39000" });
      }
      return r;
    };
    expect(await w.engine.watchOnce({ channel: w.CHANNEL })).toBe(0);
    // The cursor is rewound 5s exactly so a change that landed during the pass is not lost.
    expect(await w.engine.watchOnce({ channel: w.CHANNEL })).toBe(1);
    expect(await openConflicts(w)).toHaveLength(1);
  });

  it("a second watchOnce() while one is running does nothing", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "39000" });
    const [a, b] = await Promise.all([w.engine.watchOnce({ channel: w.CHANNEL }), w.engine.watchOnce({ channel: w.CHANNEL })]);
    expect(a + b).toBe(1);
    expect(await openConflicts(w)).toHaveLength(1);
  });

  it("closes the conflict once the out-of-band change is reverted, so the send is not held forever", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const dealId = (await w.thread()).dealId!;
    w.crm.humanEdit(dealId, { amount: "39000" });
    expect(await w.engine.watchOnce({ channel: w.CHANNEL })).toBe(1);
    expect(await openConflicts(w)).toHaveLength(1);

    // The rep puts it back themselves; there is nothing left to disagree about.
    w.crm.humanEdit(dealId, { amount: "42000" });
    await w.engine.watchOnce({ channel: w.CHANNEL });

    // BUG: the conflict raised by the watcher is never re-evaluated, so it stays open even though
    // HubSpot now matches the instruction...
    expect(await openConflicts(w)).toEqual([]);
    // ...which blocks every later "send it" indefinitely.
    const r = await w.instruct(SEND_NOW);
    expect(r.email!.decision).toBe("auto_sent");
  });

  it("reports a Gmail draft edit again when the same wording comes back", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const draftId = (await w.thread()).draftId!;
    const amendBody = (await w.draft())!.body;

    w.mail.humanEdit(draftId, { body: "Sam's own wording" });
    expect(await w.engine.watchOnce({ channel: w.CHANNEL })).toBe(1);

    w.mail.humanEdit(draftId, { body: amendBody });
    expect(await w.engine.watchOnce({ channel: w.CHANNEL })).toBe(0);

    // The rep re-applies their wording: that is a new out-of-band change and must be reported.
    w.mail.humanEdit(draftId, { body: "Sam's own wording" });
    // BUG: watchNoticed is an append-only list of value tokens, so a value that was noticed once is
    // never announced again, even after the draft went back to Amend's text in between.
    expect(await w.engine.watchOnce({ channel: w.CHANNEL })).toBe(1);
  });

  it("still reports HubSpot changes after the engine gave up retrying a run", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    const dealId = (await w.thread()).dealId!;
    breakCrmUpdate(w);
    await w.instruct(AMOUNT_50K);
    for (let i = 2; i <= MAX_RETRY_ATTEMPTS; i++) await recover(w);
    expect(await recover(w)).toEqual([]); // gave up
    expect((await w.thread()).completedVersion).toBe(1);

    w.crm.humanEdit(dealId, { hs_next_step: "sam took this over" });
    // BUG: inspectDeal skips any thread whose latest version has not completed ("a run is pending;
    // it will reconcile"), but a given-up run never will — outside changes go unreported forever.
    expect(await w.engine.watchOnce({ channel: w.CHANNEL })).toBe(1);
  });

  it("keeps a thread reply that arrives while a watcher pass is writing to the same thread", async () => {
    const w = await createWorld();
    await w.instruct(V1);
    w.crm.humanEdit((await w.thread()).dealId!, { amount: "39000" });

    const reply: Msg = {
      text: "next step is security review",
      facts: { next_step: "security review" },
      composedFacts: { ...BASE_FACTS, next_step: "security review" },
    };
    w.extractor.add(reply);
    await Promise.all([
      w.engine.watchOnce({ channel: w.CHANNEL }),
      w.engine.handleInstruction({ threadKey: w.THREAD, channel: w.CHANNEL, ts: w.ROOT_TS, partTs: "1726000100.000200", text: reply.text, eventId: "ev_reply" }),
    ]);

    // inspectDeal upserts a ThreadRecord it read at the start of the pass; the reply must survive it.
    expect((await w.thread()).parts).toHaveLength(2);
    expect((await w.store.latestVersion(w.THREAD))!.text).toContain("security review");
  });
});

// ------------------------------------------------------------------ draft-create recovery

describe("draft create recovery", () => {
  it("recovers a correction draft whose thread link was lost to a crash", async () => {
    let crashes = 0;
    let armed = false;
    const w = await createWorld({
      hooks: {
        async checkpoint(name) {
          if (name === "draft.create.recorded" && armed) {
            armed = false;
            crashes++;
            throw new SimulatedCrash(name);
          }
        },
      },
    });
    await w.instruct(V1);
    w.mail.humanSend((await w.thread()).draftId!);
    armed = true;
    await crashy(w.instruct(AMOUNT_50K));
    expect(crashes).toBe(1);
    // Gmail already holds the correction; only the thread link is missing.
    expect(w.mail.createdTotal).toBe(2);

    w.restart();
    for (let i = 0; i < 3; i++) await recover(w);

    // BUG: the "restore the draft id from the ledger" path only fires for the exact create key of the
    // current mode. After the crash the run re-enters as mode "new", finds the *original* (already sent)
    // create entry applied, and gives up — the correction draft is orphaned in Gmail and the run never
    // completes (it retries to the cap and gives up).
    const t = await w.thread();
    expect(t.draftId).toBeDefined();
    expect(w.mail.createdTotal).toBe(2);
    expect((await w.draft())!.body).toContain("$50,000");
    expect(t.completedVersion).toBe(2);
  });

  it("never adopts a person's draft after a crash, even with the same recipient and subject", async () => {
    const w = await createWorld();
    const humanId = w.mail.humanCreateDraft({ to: "priya@acme.com", subject: "Proposal for Acme Corp", body: "Sam's personal note" });
    w.mail.faults.inject("mail.create", "crash_after_commit");
    await crashy(w.instruct(V1));
    w.restart();
    for (let i = 0; i < 2; i++) await recover(w);

    expect(w.mail.drafts.get(humanId)!.body).toBe("Sam's personal note");
    expect(w.mail.createdTotal).toBe(1);
    const t = await w.thread();
    expect(t.draftId).toBeDefined();
    expect(t.draftId).not.toBe(humanId);
    expect((await w.draft())!.body).toContain("$42,000");
    expect(t.completedVersion).toBe(1);
  });

  it("a redelivered identical edit does nothing, and the sweep still finishes the interrupted run", async () => {
    const w = await createWorld();
    w.mail.faults.inject("mail.create", "crash_after_commit");
    await crashy(w.instruct(V1));
    w.restart();

    // Slack re-delivers the same text under a new event id before the sweep runs.
    const again = await w.instruct(V1);
    expect(again.status).toBe("duplicate");
    expect(again.writes).toBe(0);
    expect(w.mail.createdTotal).toBe(1);

    expect(await recover(w)).toHaveLength(1);
    expect(w.mail.createdTotal).toBe(1);
    expect((await w.thread()).completedVersion).toBe(1);
  });

  it("two Send button clicks at the same time send exactly once", async () => {
    const w = await createWorld();
    const card = (await w.instruct(V1)).email!;
    const clicks = await Promise.all([
      w.engine.approveSend({ threadKey: w.THREAD, draftId: card.draftId, bodyToken: card.bodyToken, userId: "u_lead" }),
      w.engine.approveSend({ threadKey: w.THREAD, draftId: card.draftId, bodyToken: card.bodyToken, userId: "u_lead" }),
    ]);
    expect(clicks.filter((c) => c.ok)).toHaveLength(1);
    expect(w.mail.sent).toHaveLength(1);
    expect((await w.thread()).sentDraftIds).toEqual([card.draftId]);
  });
});
