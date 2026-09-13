import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { ConflictRecord, LedgerEntry, Store, ThreadRecord } from "../../src/db/store.js";
import { MemoryStore } from "../../src/db/store.js";
import { PgStore, connectionOptions } from "../../src/db/pg-store.js";
import type { Extraction } from "../../src/core/facts.js";

/**
 * One contract suite, two implementations. Postgres comes from TEST_DATABASE_URL
 * (default: the local docker container) and is skipped only when unreachable.
 */
const PG_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:amend@127.0.0.1:55432/amend";

let pg: PgStore | null = null;
let pgWhy = "";
try {
  const candidate = new PgStore(PG_URL);
  await candidate.migrate();
  await candidate.sql`select 1`;
  pg = candidate;
} catch (err) {
  pgWhy = (err as Error).message;
  // eslint-disable-next-line no-console
  console.warn(`[store.contract] Postgres unreachable at ${PG_URL}: ${pgWhy} — Pg variant skipped`);
}

const impls: Array<{ name: string; store: Store }> = [{ name: "MemoryStore", store: new MemoryStore() }];
if (pg) impls.push({ name: "PgStore", store: pg });

afterAll(async () => {
  if (pg) await pg.close({ timeout: 5 });
});

let n = 0;
const key = (label: string) => `adv-${label}-${process.pid}-${Date.now()}-${n++}`;

function entry(threadKey: string, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: randomUUID(),
    threadKey,
    version: 1,
    resource: "deal",
    field: "amount",
    action: "update",
    idempotencyKey: `${threadKey}:deal:amount:1`,
    status: "pending",
    desiredCmp: "42000",
    observedToken: null,
    value: "42000",
    at: 1_700_000_000_000,
    ...over,
  };
}

function conflict(threadKey: string, over: Partial<ConflictRecord> = {}): ConflictRecord {
  return {
    id: `${threadKey}:deal:amount:1`,
    threadKey,
    version: 1,
    resource: "deal",
    field: "amount",
    base: "42000",
    human: "45000",
    desired: "50000",
    desiredCmp: "50000",
    status: "open",
    ...over,
  };
}

function thread(threadKey: string, over: Partial<ThreadRecord> = {}): ThreadRecord {
  return { threadKey, channel: "C1", ts: "1700000000.000100", sentDraftIds: [], ...over };
}

describe.each(impls)("Store contract: $name", ({ name, store }) => {
  const isPg = name === "PgStore";

  // ---------------------------------------------------------------- events

  it("seenEvent is false the first time and true afterwards, per id", async () => {
    const a = key("ev-a");
    const b = key("ev-b");
    expect(await store.seenEvent(a)).toBe(false);
    expect(await store.seenEvent(a)).toBe(true);
    expect(await store.seenEvent(a)).toBe(true);
    expect(await store.seenEvent(b)).toBe(false);
  });

  it("seenEvent under concurrency admits exactly one caller", async () => {
    const id = key("ev-race");
    const results = await Promise.all(Array.from({ length: 8 }, () => store.seenEvent(id)));
    expect(results.filter((r) => r === false)).toHaveLength(1);
  });

  // --------------------------------------------------------------- versions

  it("addVersion appends, dedupes against the LATEST version only", async () => {
    const k = key("ver");
    const v1 = await store.addVersion(k, "first", "h1");
    expect(v1).toMatchObject({ duplicate: false });
    expect(v1.version.version).toBe(1);
    expect(v1.version.threadKey).toBe(k);
    expect(v1.version.text).toBe("first");

    const dup = await store.addVersion(k, "first", "h1");
    expect(dup.duplicate).toBe(true);
    expect(dup.version.version).toBe(1);

    const v2 = await store.addVersion(k, "second", "h2");
    expect(v2).toMatchObject({ duplicate: false });
    expect(v2.version.version).toBe(2);

    // h1 is no longer the latest hash: reverting the text must create a NEW version.
    const v3 = await store.addVersion(k, "first", "h1");
    expect(v3.duplicate).toBe(false);
    expect(v3.version.version).toBe(3);
  });

  it("addVersion keeps the stored text of the latest version when deduping", async () => {
    const k = key("ver-dupe-text");
    await store.addVersion(k, "original", "same");
    const dup = await store.addVersion(k, "DIFFERENT TEXT, SAME HASH", "same");
    expect(dup.duplicate).toBe(true);
    expect(dup.version.text).toBe("original");
    expect((await store.latestVersion(k))!.text).toBe("original");
  });

  it("10 parallel addVersion calls produce unique consecutive versions", async () => {
    const k = key("ver-race");
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.addVersion(k, `t${i}`, `hash-${i}`)));
    const nums = results.map((r) => r.version.version).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(results.every((r) => r.duplicate === false)).toBe(true);
    const listed = await store.listVersions(k);
    expect(listed.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(listed.map((v) => v.text)).size).toBe(10);
  });

  it("latestVersion / getVersion handle missing threads and out-of-range versions", async () => {
    const k = key("ver-missing");
    expect(await store.latestVersion(k)).toBeNull();
    expect(await store.getVersion(k, 1)).toBeNull();
    await store.addVersion(k, "only", "h");
    expect((await store.getVersion(k, 1))!.text).toBe("only");
    expect(await store.getVersion(k, 0)).toBeNull();
    expect(await store.getVersion(k, -1)).toBeNull();
    expect(await store.getVersion(k, 2)).toBeNull();
    expect(await store.getVersion(k, 999)).toBeNull();
  });

  it("listVersions returns [] for an unknown thread and is ordered by version", async () => {
    expect(await store.listVersions(key("ver-none"))).toEqual([]);
    const k = key("ver-order");
    for (let i = 1; i <= 4; i++) await store.addVersion(k, `t${i}`, `h${i}`);
    expect((await store.listVersions(k)).map((v) => v.version)).toEqual([1, 2, 3, 4]);
  });

  it("addVersion round-trips unicode, emoji, newlines and quotes", async () => {
    const k = key("ver-unicode");
    const text = 'Acme "Corp" ☃ 日本語 🎉\nline two\r\nline three\t<tab>';
    const { version } = await store.addVersion(k, text, "h-unicode");
    expect(version.text).toBe(text);
    expect((await store.latestVersion(k))!.text).toBe(text);
  });

  // ------------------------------------------------------------- extraction

  it("saveExtraction round-trips and is a no-op for an unknown version", async () => {
    const k = key("extract");
    await store.addVersion(k, "hi", "h");
    const extraction: Extraction = {
      facts: { company: { key: "company", value: "Acme", source: "Acme" } },
      rejected: ["delete everything"],
      clarifications: [],
    };
    await store.saveExtraction(k, 1, extraction);
    expect((await store.getVersion(k, 1))!.extraction).toEqual(extraction);
    expect((await store.listVersions(k))[0].extraction).toEqual(extraction);

    await expect(store.saveExtraction(k, 99, extraction)).resolves.toBeUndefined();
    await expect(store.saveExtraction(key("extract-none"), 1, extraction)).resolves.toBeUndefined();

    const second: Extraction = { facts: {}, rejected: [], clarifications: ["which amount?"] };
    await store.saveExtraction(k, 1, second);
    expect((await store.getVersion(k, 1))!.extraction).toEqual(second);
  });

  // ----------------------------------------------------------------- ledger

  it("ledgerBase ignores pending/failed/superseded and takes the latest applied/accepted_human", async () => {
    const k = key("base");
    expect(await store.ledgerBase(k, "deal", "amount")).toBeNull();

    await store.appendLedger(entry(k, { status: "pending", value: "1" }));
    expect(await store.ledgerBase(k, "deal", "amount")).toBeNull();

    await store.appendLedger(entry(k, { status: "failed", value: "2" }));
    expect(await store.ledgerBase(k, "deal", "amount")).toBeNull();

    await store.appendLedger(entry(k, { status: "superseded", value: "3" }));
    expect(await store.ledgerBase(k, "deal", "amount")).toBeNull();

    await store.appendLedger(entry(k, { status: "applied", value: "4" }));
    expect((await store.ledgerBase(k, "deal", "amount"))!.value).toBe("4");

    await store.appendLedger(entry(k, { status: "pending", value: "5" }));
    await store.appendLedger(entry(k, { status: "failed", value: "6" }));
    expect((await store.ledgerBase(k, "deal", "amount"))!.value).toBe("4");

    await store.appendLedger(entry(k, { status: "accepted_human", value: "7" }));
    expect((await store.ledgerBase(k, "deal", "amount"))!.value).toBe("7");

    await store.appendLedger(entry(k, { status: "applied", value: "8" }));
    expect((await store.ledgerBase(k, "deal", "amount"))!.value).toBe("8");
  });

  it("ledgerBase is scoped by thread, resource and field", async () => {
    const k = key("base-scope");
    const other = key("base-other");
    await store.appendLedger(entry(k, { status: "applied", resource: "deal", field: "amount", value: "A" }));
    await store.appendLedger(entry(k, { status: "applied", resource: "deal", field: "dealname", value: "B" }));
    await store.appendLedger(entry(k, { status: "applied", resource: "draft", field: "amount", value: "C" }));
    await store.appendLedger(entry(other, { status: "applied", resource: "deal", field: "amount", value: "D" }));

    expect((await store.ledgerBase(k, "deal", "amount"))!.value).toBe("A");
    expect((await store.ledgerBase(k, "deal", "dealname"))!.value).toBe("B");
    expect((await store.ledgerBase(k, "draft", "amount"))!.value).toBe("C");
    expect((await store.ledgerBase(other, "deal", "amount"))!.value).toBe("D");
    expect(await store.ledgerBase(k, "deal", "*")).toBeNull();
  });

  it("updateLedger promotes an entry to base without reordering it", async () => {
    const k = key("update");
    const first = entry(k, { status: "pending", value: "first" });
    await store.appendLedger(first);
    await store.appendLedger(entry(k, { status: "applied", value: "second" }));
    expect((await store.ledgerBase(k, "deal", "amount"))!.value).toBe("second");

    // The older row becomes applied later; ordering is by append position, not update time.
    await store.updateLedger(first.id, { status: "applied" });
    expect((await store.ledgerBase(k, "deal", "amount"))!.value).toBe("second");
    expect((await store.listLedger(k)).map((e) => e.status)).toEqual(["applied", "applied"]);
  });

  it("updateLedger writes status, observedToken, value and error and clears error", async () => {
    const k = key("update-fields");
    const e = entry(k, { status: "pending", observedToken: null, error: "boom" });
    await store.appendLedger(e);
    expect((await store.listLedger(k))[0].error).toBe("boom");

    await store.updateLedger(e.id, { status: "applied", observedToken: "tok-1", value: "99", error: undefined });
    const [after] = await store.listLedger(k);
    expect(after.status).toBe("applied");
    expect(after.observedToken).toBe("tok-1");
    expect(after.value).toBe("99");
    expect(after.error).toBeUndefined();

    await store.updateLedger(e.id, { value: null, observedToken: null });
    const [after2] = await store.listLedger(k);
    expect(after2.value).toBeNull();
    expect(after2.observedToken).toBeNull();
  });

  it("updateLedger with an empty patch or an unknown id is a silent no-op", async () => {
    const k = key("update-noop");
    const e = entry(k, { status: "applied" });
    await store.appendLedger(e);
    await expect(store.updateLedger(e.id, {})).resolves.toBeUndefined();
    await expect(store.updateLedger(randomUUID(), { status: "failed" })).resolves.toBeUndefined();
    expect((await store.listLedger(k))[0].status).toBe("applied");
  });

  it("findLedgerByKey returns the LATEST entry with that idempotency key", async () => {
    const k = key("idem");
    const idem = `${k}:deal:amount:v1`;
    expect(await store.findLedgerByKey(idem)).toBeNull();
    await store.appendLedger(entry(k, { idempotencyKey: idem, status: "failed", value: "old" }));
    await store.appendLedger(entry(k, { idempotencyKey: idem, status: "applied", value: "new" }));
    await store.appendLedger(entry(k, { idempotencyKey: `${idem}-other`, value: "unrelated" }));
    const hit = await store.findLedgerByKey(idem);
    expect(hit!.value).toBe("new");
    expect(hit!.status).toBe("applied");
  });

  it("listLedger is append-ordered, thread-scoped, and round-trips every field", async () => {
    const k = key("list-ledger");
    const other = key("list-ledger-other");
    await store.appendLedger(entry(other, { value: "not mine" }));
    const rows: LedgerEntry[] = [
      entry(k, { version: 1, action: "create", field: "*", value: "a", at: 1_700_000_000_001 }),
      entry(k, { version: 2, action: "update", value: "b", at: 1_700_000_000_002, observedToken: "t", error: "e" }),
      entry(k, { version: 3, action: "send", value: null, at: 1_700_000_000_003 }),
    ];
    for (const r of rows) await store.appendLedger(r);
    const listed = await store.listLedger(k);
    expect(listed).toHaveLength(3);
    expect(listed.map((e) => e.value)).toEqual(["a", "b", null]);
    expect(listed[0]).toEqual(rows[0]);
    expect(listed[1]).toEqual(rows[1]);
    expect(listed[2]).toEqual(rows[2]);
    expect(await store.listLedger(key("list-ledger-empty"))).toEqual([]);
  });

  it("appendLedger preserves the caller's `at` timestamp to the millisecond", async () => {
    const k = key("ledger-at");
    const at = 1_699_999_123_456;
    await store.appendLedger(entry(k, { at }));
    expect((await store.listLedger(k))[0].at).toBe(at);
  });

  // -------------------------------------------------------------- conflicts

  it("saveConflict upserts by id; getConflict/listConflicts round-trip", async () => {
    const k = key("conflict");
    expect(await store.getConflict(`${k}:nope`)).toBeNull();
    expect(await store.listConflicts(k)).toEqual([]);

    const c = conflict(k);
    await store.saveConflict(c);
    expect(await store.getConflict(c.id)).toEqual(c);
    expect(await store.listConflicts(k)).toEqual([c]);

    const resolved: ConflictRecord = { ...c, status: "resolved", choice: "keep_human", resolvedBy: "U1" };
    await store.saveConflict(resolved);
    expect(await store.getConflict(c.id)).toEqual(resolved);
    expect(await store.listConflicts(k)).toHaveLength(1);
  });

  it("conflicts round-trip null base/human/desired and omitted optional fields", async () => {
    const k = key("conflict-null");
    const c = conflict(k, { id: `${k}:draft:body:2`, resource: "draft", field: "body", base: null, human: null, desired: null });
    await store.saveConflict(c);
    const back = (await store.getConflict(c.id))!;
    expect(back.base).toBeNull();
    expect(back.human).toBeNull();
    expect(back.desired).toBeNull();
    expect(back.changedBy).toBeUndefined();
    expect(back.choice).toBeUndefined();
    expect(back.resolvedBy).toBeUndefined();
  });

  it("listConflicts is scoped to one thread", async () => {
    const a = key("conf-a");
    const b = key("conf-b");
    await store.saveConflict(conflict(a, { id: `${a}:1` }));
    await store.saveConflict(conflict(a, { id: `${a}:2`, field: "closedate" }));
    await store.saveConflict(conflict(b, { id: `${b}:1` }));
    expect(await store.listConflicts(a)).toHaveLength(2);
    expect(await store.listConflicts(b)).toHaveLength(1);
    expect(new Set((await store.listConflicts(a)).map((c) => c.id))).toEqual(new Set([`${a}:1`, `${a}:2`]));
  });

  // ------------------------------------------------------------------ links

  it("linkMessage/resolveLink map a message key and overwrite on re-link", async () => {
    const msg = key("msg");
    const t1 = key("link-t1");
    const t2 = key("link-t2");
    expect(await store.resolveLink(msg)).toBeNull();
    await store.linkMessage(msg, t1);
    expect(await store.resolveLink(msg)).toBe(t1);
    await store.linkMessage(msg, t2);
    expect(await store.resolveLink(msg)).toBe(t2);
    expect(await store.resolveLink(key("msg-unknown"))).toBeNull();
  });

  // ---------------------------------------------------------------- threads

  it("upsertThread round-trips nested fields and treats absent optionals as undefined", async () => {
    const k = key("thread-json");
    const t: ThreadRecord = thread(k, {
      dealId: "D1",
      draftId: undefined,
      draftCreatedAt: 1_700_000_000_000,
      sentDraftIds: ["r1", "r2"],
      parts: [
        { ts: "1.1", text: "root" },
        { ts: "1.2", text: 'reply with "quotes" and \\backslash\\ and ☃' },
      ],
      sentEmails: [{ draftId: "r1", id: "m1", threadId: "g1", to: "a@b.com", subject: "Proposal" }],
      requestedBy: "U123",
      completedVersion: 2,
      retry: { version: 3, attempts: 2, lastAt: 1_700_000_000_500, reason: "HTTP 429" },
      watchNoticed: ["deal.amount:50000"],
      honoredSend: "send the proposal",
      replyTs: "1.1",
      pendingSend: { version: 3, source: "send it" },
    });
    await store.upsertThread(t);
    const back = (await store.getThread(k))!;
    expect(back).toEqual(t);
    expect(back.draftId).toBeUndefined();
    expect(back.mergedInto).toBeUndefined();
    expect(back.parts).toEqual(t.parts);
    expect(back.sentEmails![0].rfcMessageId).toBeUndefined();
    expect(back.retry).toEqual(t.retry);
    expect(back.pendingSend).toEqual(t.pendingSend);
  });

  it("upsertThread replaces the whole record (fields removed on a later write disappear)", async () => {
    const k = key("thread-replace");
    await store.upsertThread(thread(k, { dealId: "D1", draftId: "R1" }));
    await store.upsertThread(thread(k, { dealId: "D2" }));
    const back = (await store.getThread(k))!;
    expect(back.dealId).toBe("D2");
    expect(back.draftId).toBeUndefined();
  });

  it("getThread returns null for an unknown key", async () => {
    expect(await store.getThread(key("thread-none"))).toBeNull();
  });

  it("listThreads respects the limit and contains the written threads", async () => {
    const keys = [key("lt-1"), key("lt-2"), key("lt-3")];
    for (const k of keys) await store.upsertThread(thread(k));
    const all = await store.listThreads(1000);
    for (const k of keys) expect(all.some((t) => t.threadKey === k)).toBe(true);
    expect(await store.listThreads(2)).toHaveLength(2);
    expect(await store.listThreads(0)).toHaveLength(0);
  });

  it("listThreads puts the most recently updated thread first", async () => {
    const a = key("lt-order-a");
    const b = key("lt-order-b");
    await store.upsertThread(thread(a));
    await store.upsertThread(thread(b));
    await store.upsertThread(thread(a, { dealId: "D-newest" }));
    const top = (await store.listThreads(1000)).slice(0, 2).map((t) => t.threadKey);
    // BUG: MemoryStore.listThreads reverses Map insertion order, so re-upserting an
    // existing thread does not move it to the front; PgStore orders by updated_at desc.
    // With more threads than `limit`, the in-memory viewer therefore shows a stale page.
    expect(top[0]).toBe(a);
  });

  // ------------------------------------------------------------------- lock

  it("withLock serializes concurrent work on the same key", async () => {
    const k = key("lock-mutex");
    const trace: string[] = [];
    let inside = 0;
    let maxInside = 0;
    const body = (tag: string) => async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      trace.push(`${tag}:enter`);
      await new Promise((r) => setTimeout(r, 20));
      trace.push(`${tag}:exit`);
      inside--;
    };
    await Promise.all([store.withLock(k, body("A")), store.withLock(k, body("B")), store.withLock(k, body("C"))]);
    expect(maxInside).toBe(1);
    expect(trace).toHaveLength(6);
    for (let i = 0; i < trace.length; i += 2) {
      expect(trace[i].split(":")[0]).toBe(trace[i + 1].split(":")[0]);
    }
  });

  it("withLock on different keys does not block", async () => {
    const a = key("lock-a");
    const b = key("lock-b");
    let releaseA!: () => void;
    const blockA = new Promise<void>((r) => (releaseA = r));
    let bDone = false;

    const runA = store.withLock(a, async () => {
      await blockA;
      return "a";
    });
    const runB = store.withLock(b, async () => {
      bDone = true;
      return "b";
    });
    expect(await runB).toBe("b");
    expect(bDone).toBe(true);
    releaseA();
    expect(await runA).toBe("a");
  });

  it("withLock releases the lock when fn throws, and propagates the error", async () => {
    const k = key("lock-throw");
    const boom = new Error("boom");
    await expect(store.withLock(k, async () => Promise.reject(boom))).rejects.toBe(boom);
    await expect(store.withLock(k, async () => Promise.reject(new Error("second"))))
      .rejects.toThrow("second");
    // The lock must still be usable and still serialize.
    let ran = false;
    const value = await store.withLock(k, async () => {
      ran = true;
      return 7;
    });
    expect(ran).toBe(true);
    expect(value).toBe(7);
  });

  it("withLock returns the callback's value and supports nesting on different keys", async () => {
    const outer = key("lock-outer");
    const inner = key("lock-inner");
    const result = await store.withLock(outer, async () => store.withLock(inner, async () => "nested"));
    expect(result).toBe("nested");
  });

  // -------------------------------------------------------------- isolation

  it("mutating returned records does not change stored state", async () => {
    const k = key("isolate");
    const t = thread(k, { dealId: "D1", sentDraftIds: ["r1"], parts: [{ ts: "1", text: "root" }] });
    await store.upsertThread(t);

    // Mutating the object handed to upsertThread must not reach back into the store.
    t.dealId = "MUTATED";
    t.sentDraftIds.push("r2");
    t.parts![0].text = "MUTATED";
    expect(await store.getThread(k)).toMatchObject({ dealId: "D1", sentDraftIds: ["r1"] });
    expect((await store.getThread(k))!.parts![0].text).toBe("root");

    // Mutating what getThread returned must not reach the store either.
    const read = (await store.getThread(k))!;
    read.dealId = "MUTATED";
    read.sentDraftIds.push("r9");
    read.parts![0].text = "MUTATED";
    expect((await store.getThread(k))!.dealId).toBe("D1");
    expect((await store.getThread(k))!.sentDraftIds).toEqual(["r1"]);
    expect((await store.getThread(k))!.parts![0].text).toBe("root");
  });

  it("mutating ledger, conflict, version and extraction reads does not change stored state", async () => {
    const k = key("isolate-2");
    const e = entry(k, { status: "applied" });
    await store.appendLedger(e);
    e.status = "failed";
    e.value = "MUTATED";
    expect((await store.listLedger(k))[0]).toMatchObject({ status: "applied", value: "42000" });

    const listed = await store.listLedger(k);
    listed[0].status = "failed";
    listed[0].value = "MUTATED";
    expect((await store.listLedger(k))[0]).toMatchObject({ status: "applied", value: "42000" });
    const base = (await store.ledgerBase(k, "deal", "amount"))!;
    base.value = "MUTATED";
    expect((await store.ledgerBase(k, "deal", "amount"))!.value).toBe("42000");

    const c = conflict(k);
    await store.saveConflict(c);
    c.status = "resolved";
    c.human = "MUTATED";
    expect(await store.getConflict(c.id)).toMatchObject({ status: "open", human: "45000" });
    const got = (await store.getConflict(c.id))!;
    got.status = "resolved";
    expect((await store.getConflict(c.id))!.status).toBe("open");
    const conflictList = await store.listConflicts(k);
    conflictList[0].human = "MUTATED";
    expect((await store.listConflicts(k))[0].human).toBe("45000");

    const added = await store.addVersion(k, "text", "hh");
    added.version.text = "MUTATED";
    expect((await store.latestVersion(k))!.text).toBe("text");
    const latest = (await store.latestVersion(k))!;
    latest.text = "MUTATED";
    expect((await store.latestVersion(k))!.text).toBe("text");

    const extraction: Extraction = { facts: { company: { key: "company", value: "Acme", source: "Acme" } }, rejected: [], clarifications: [] };
    await store.saveExtraction(k, 1, extraction);
    extraction.facts.company!.value = "MUTATED";
    extraction.rejected.push("MUTATED");
    expect((await store.getVersion(k, 1))!.extraction).toEqual({
      facts: { company: { key: "company", value: "Acme", source: "Acme" } },
      rejected: [],
      clarifications: [],
    });
    const readVersion = (await store.getVersion(k, 1))!;
    readVersion.extraction!.facts.company!.value = "MUTATED";
    expect((await store.getVersion(k, 1))!.extraction!.facts.company!.value).toBe("Acme");

    const threads = await store.listThreads(1000);
    if (threads.length) threads[0].channel = "MUTATED";
    expect((await store.listThreads(1000)).every((t) => t.channel !== "MUTATED")).toBe(true);
    void isPg;
  });
});

// ------------------------------------------------------- Postgres specifics

describe.runIf(pg)("PgStore specifics", () => {
  it("rejects NUL bytes that MemoryStore accepts (text and jsonb parity gap)", async () => {
    const NUL = String.fromCharCode(0);
    const mem = new MemoryStore();
    const k = key("nul");
    await expect(mem.addVersion(k, `a${NUL}b`, "h")).resolves.toMatchObject({ duplicate: false });
    // BUG: parity gap — the same Slack text that MemoryStore stores makes PgStore throw,
    // so a run that succeeds in-memory fails (unretryably) against Postgres.
    await expect(pg!.addVersion(key("nul-pg"), `a${NUL}b`, "h")).resolves.toBeDefined();
  });

  it("does not deadlock when the pool size worth of threads hold locks at once", async () => {
    // PgStore.withLock reserves a pooled connection for the whole callback while the
    // callback itself needs a pooled connection to do any work.
    const store = new PgStore(PG_URL);
    const N = 10; // == the hardcoded pool max
    let completed = 0;
    const work = Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.withLock(key(`deadlock-${i}`), async () => {
          await store.getThread("does-not-exist");
          completed++;
        }),
      ),
    ).then(() => "done" as const);
    work.catch(() => undefined);
    const outcome = await Promise.race([work, new Promise((r) => setTimeout(() => r("TIMEOUT"), 4000))]);
    await store.close({ timeout: 0 }).catch(() => undefined);
    // BUG: with max:10 connections, 10 concurrent withLock callbacks that touch the
    // database deadlock forever (9 is fine, 10 hangs). Every Slack thread takes a lock,
    // so 10 concurrent instructions wedge the whole process until restart.
    expect({ outcome, completed }).toEqual({ outcome: "done", completed: N });
  }, 20_000);
});

// ------------------------------------------------------- connectionOptions

describe("connectionOptions", () => {
  it("rewrites a Neon pooler host to the direct endpoint and requires TLS", () => {
    const o = connectionOptions("postgres://u:p@ep-cool-frost-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require");
    expect(new URL(o.url).hostname).toBe("ep-cool-frost-123456.us-east-2.aws.neon.tech");
    expect(o.rewrotePooler).toBe(true);
    expect(o.ssl).toBe("require");
    expect(o.url).not.toContain("channel_binding");
    expect(o.url).not.toContain("sslmode");
  });

  it("leaves a non-pooler Neon host alone but still requires TLS", () => {
    const o = connectionOptions("postgres://u:p@ep-cool-frost-123456.us-east-2.aws.neon.tech/neondb");
    expect(new URL(o.url).hostname).toBe("ep-cool-frost-123456.us-east-2.aws.neon.tech");
    expect(o.rewrotePooler).toBe(false);
    expect(o.ssl).toBe("require");
  });

  it("does not rewrite '-pooler.' outside the hostname", () => {
    const o = connectionOptions("postgres://user-pooler.x:pw-pooler.y@db.example.com/app-pooler.db");
    expect(new URL(o.url).hostname).toBe("db.example.com");
    expect(o.rewrotePooler).toBe(false);
    expect(new URL(o.url).pathname).toBe("/app-pooler.db");
    expect(decodeURIComponent(new URL(o.url).username)).toBe("user-pooler.x");
    expect(decodeURIComponent(new URL(o.url).password)).toBe("pw-pooler.y");
  });

  it("does not rewrite a '-pooler' host that is not Neon", () => {
    const o = connectionOptions("postgres://u:p@shard-pooler.example.com/db");
    expect(new URL(o.url).hostname).toBe("shard-pooler.example.com");
    expect(o.rewrotePooler).toBe(false);
    expect(o.ssl).toBeUndefined();
  });

  it("does not treat a look-alike neon.tech suffix as Neon", () => {
    expect(connectionOptions("postgres://u:p@db.notneon.tech/x").ssl).toBeUndefined();
    expect(connectionOptions("postgres://u:p@neon.tech.attacker.example/x").ssl).toBeUndefined();
    expect(connectionOptions("postgres://u:p@evil-neon.tech/x").ssl).toBeUndefined();
  });

  it("maps sslmode variants", () => {
    expect(connectionOptions("postgres://u:p@h.example.com/db").ssl).toBeUndefined();
    expect(connectionOptions("postgres://u:p@h.example.com/db?sslmode=disable").ssl).toBeUndefined();
    expect(connectionOptions("postgres://u:p@h.example.com/db?sslmode=require").ssl).toBe("require");
    expect(connectionOptions("postgres://u:p@h.example.com/db?sslmode=prefer").ssl).toBe("require");
    expect(connectionOptions("postgres://u:p@h.example.com/db?sslmode=allow").ssl).toBe("require");
  });

  it("strips channel_binding and sslmode but keeps every other query parameter", () => {
    const o = connectionOptions("postgres://u:p@h.example.com/db?application_name=amend&sslmode=require&options=-c%20statement_timeout%3D5s&channel_binding=require");
    const q = new URL(o.url).searchParams;
    expect(q.get("channel_binding")).toBeNull();
    expect(q.get("sslmode")).toBeNull();
    expect(q.get("application_name")).toBe("amend");
    expect(q.get("options")).toBe("-c statement_timeout=5s");
  });

  it("leaves a URL without query parameters unchanged", () => {
    const o = connectionOptions("postgres://postgres:amend@127.0.0.1:55432/amend");
    expect(o.url).toBe("postgres://postgres:amend@127.0.0.1:55432/amend");
    expect(o.ssl).toBeUndefined();
    expect(o.rewrotePooler).toBe(false);
  });

  it("preserves passwords with special characters (after percent-decoding)", () => {
    const raw = 'p@ss/w:rd?#&=+ %"\'';
    const url = `postgres://user:${encodeURIComponent(raw)}@db.example.com:5432/app`;
    const o = connectionOptions(url);
    const back = new URL(o.url);
    expect(decodeURIComponent(back.password)).toBe(raw);
    expect(back.hostname).toBe("db.example.com");
    expect(back.port).toBe("5432");
    expect(back.pathname).toBe("/app");
  });

  it("preserves a percent-encoded '@' and '/' in the password without splitting the host", () => {
    const o = connectionOptions("postgres://u:a%40b%2Fc@db.example.com/app");
    const back = new URL(o.url);
    expect(back.hostname).toBe("db.example.com");
    expect(decodeURIComponent(back.password)).toBe("a@b/c");
  });

  it("keeps verifying the server certificate when sslmode demands it", () => {
    const full = connectionOptions("postgres://u:p@db.example.com/app?sslmode=verify-full");
    const ca = connectionOptions("postgres://u:p@db.example.com/app?sslmode=verify-ca");
    // BUG (security): postgres.js turns ssl:"require" into { rejectUnauthorized: false },
    // so sslmode=verify-full / verify-ca are silently downgraded to an unverified TLS
    // connection — a MITM with any certificate is accepted.
    expect(full.ssl).not.toBe("require");
    expect(ca.ssl).not.toBe("require");
  });
});
