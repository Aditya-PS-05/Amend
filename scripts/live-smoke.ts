/**
 * End-to-end check against the REAL HubSpot + Gmail (+ Claude, + Postgres if set), no Slack needed.
 * Creates a uniquely named test deal and draft, edits the instruction, simulates a conflicting
 * CRM change, resolves it, and prints each receipt. Cleans up afterwards unless --keep.
 *
 *   pnpm smoke             # uses Claude for extraction + email
 *   pnpm smoke --no-llm    # fixed facts + template email (tests adapters only)
 *   pnpm smoke --keep      # leave the deal and draft in place to inspect
 */
import "dotenv/config";
import { Client as HubSpot } from "@hubspot/api-client";
import { GmailMail } from "../src/adapters/gmail/real.js";
import { HubSpotCrm } from "../src/adapters/hubspot/real.js";
import type { ChatAdapter } from "../src/adapters/types.js";
import { normalizeFacts, type Extraction } from "../src/core/facts.js";
import { PgStore } from "../src/db/pg-store.js";
import { MemoryStore, type Store } from "../src/db/store.js";
import { Engine, type RunReport } from "../src/engine/engine.js";
import { ClaudeWriter, TemplateWriter } from "../src/llm/draft-email.js";
import { ClaudeExtractor, type Extractor } from "../src/llm/extract.js";

const noLlm = process.argv.includes("--no-llm");
const keep = process.argv.includes("--keep");
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}`);
  return v;
};

const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
const company = `Smoke Test ${stamp}`;
const contact = process.env.SMOKE_CONTACT_EMAIL ?? "priya@example.com";
const v1 = `amend: ${company} is ready to move forward, contract sent. Deal is $42k, close by Oct 15. Contact is Priya Shah (${contact}). Send the proposal. Next step: legal review.`;
const v2 = v1.replace("$42k", "$50k with a 10% discount");

/** Offline extractor for --no-llm: regexes good enough for the two smoke messages. */
class SmokeExtractor implements Extractor {
  async extract(text: string): Promise<Extraction> {
    const raw = [
      { key: "company", value: company, source: company },
      { key: "contact_name", value: "Priya Shah", source: "Priya Shah" },
      { key: "contact_email", value: contact, source: contact },
      { key: "close_date", value: "2026-10-15", source: "Oct 15" },
      { key: "deal_stage", value: "contractsent", source: "contract sent" },
      { key: "email_intent", value: "send the proposal", source: "Send the proposal" },
      { key: "next_step", value: "legal review", source: "legal review" },
      ...[...text.matchAll(/\$(\d+)k/g)].slice(-1).map((m) => ({ key: "deal_amount", value: String(Number(m[1]) * 1000), source: m[0] })),
      ...(text.includes("10%") ? [{ key: "discount_pct", value: "10", source: "10%" }] : []),
    ];
    const { facts, dropped } = normalizeFacts(raw, text);
    return { facts, rejected: [], clarifications: dropped };
  }
}

const consoleChat: ChatAdapter = {
  async postReply(_c, _t, text, blocks) {
    console.log(`\n  ┌─ Slack receipt: ${text}`);
    for (const b of (blocks ?? []) as Array<{ text?: { text: string }; elements?: Array<{ text?: string | { text: string } }> }>) {
      const s = b.text?.text ?? b.elements?.map((e) => (typeof e.text === "string" ? e.text : e.text?.text)).join(" | ");
      if (s) console.log(`  │ ${s.replace(/\n/g, "\n  │ ")}`);
    }
    console.log("  └─");
    return { ts: "0" };
  },
};

let store: Store = new MemoryStore();
let pg: PgStore | undefined;
if (process.env.DATABASE_URL) {
  pg = new PgStore(process.env.DATABASE_URL);
  await pg.migrate();
  store = pg;
}

const crm = new HubSpotCrm({ accessToken: env("HUBSPOT_TOKEN") });
const mail = new GmailMail({
  clientId: env("GOOGLE_CLIENT_ID"),
  clientSecret: env("GOOGLE_CLIENT_SECRET"),
  refreshToken: env("GOOGLE_REFRESH_TOKEN"),
  from: process.env.GMAIL_FROM || undefined,
});
const engine = new Engine({
  store,
  crm,
  mail,
  chat: consoleChat,
  extractor: noLlm ? new SmokeExtractor() : new ClaudeExtractor(),
  writer: noLlm ? new TemplateWriter() : new ClaudeWriter(),
  log: (m, d) => console.log(`  [engine] ${m}`, d ?? ""),
});

const threadKey = `SMOKE:${stamp}`;
const input = (text: string, n: number) => ({ threadKey, channel: "SMOKE", ts: stamp, text, eventId: `smoke-${stamp}-${n}` });
const failures: string[] = [];
const expectStatus = (label: string, r: RunReport, want: RunReport["status"]) => {
  const bad = r.checks.filter((c) => !c.ok);
  const ok = r.status === want && bad.length === 0;
  console.log(`${ok ? "✅" : "❌"} ${label}: status ${r.status}, ${r.writes} writes, checks ${r.checks.length - bad.length}/${r.checks.length}`);
  for (const c of bad) console.log(`     ✗ ${c.name} (${c.detail})`);
  if (!ok) failures.push(label);
};

try {
  console.log(`\n▶ v1: create (${company})`);
  const r1 = await engine.handleInstruction(input(v1, 1));
  expectStatus("v1 create", r1, "completed");

  console.log("\n▶ v2: edit amount + discount");
  const r2 = await engine.handleInstruction(input(v2, 2));
  expectStatus("v2 edit", r2, "completed");
  const amount = r2.outcomes.find((o) => o.resource === "deal" && o.field === "amount");
  if (amount?.after !== "45000") failures.push(`deal.amount expected 45000, got ${amount?.after}`);

  console.log("\n▶ duplicate delivery of v2");
  const r2b = await engine.handleInstruction(input(v2, 2));
  console.log(`${r2b.status === "duplicate" ? "✅" : "❌"} duplicate ignored (${r2b.status})`);
  if (r2b.status !== "duplicate") failures.push("duplicate not ignored");

  console.log("\n▶ someone changes the amount in HubSpot, then Slack says $60k");
  const thread = (await store.getThread(threadKey))!;
  await crm.updateDeal(thread.dealId!, { amount: "47000" });
  const r3 = await engine.handleInstruction(input(v2.replace("$50k", "$60k"), 3));
  expectStatus("v3 conflict detected", r3, "needs_attention");
  const conflict = r3.outcomes.find((o) => o.kind === "conflict");
  if (!conflict?.conflictId) failures.push("no conflict raised");
  else {
    console.log("\n▶ lead clicks 'Apply new instruction'");
    const r4 = await engine.resolveConflict({ threadKey, conflictId: conflict.conflictId, choice: "apply_new", userId: "smoke" });
    expectStatus("conflict resolved", r4, "completed");
  }
} catch (e) {
  failures.push((e as Error).message);
  console.error(e);
} finally {
  const t = await store.getThread(threadKey);
  if (keep) {
    console.log(`\nKept: HubSpot deal ${t?.dealId}, Gmail draft ${t?.draftId}`);
  } else if (t) {
    if (t.draftId) await mail.deleteDraft(t.draftId).catch(() => {});
    if (t.dealId) await new HubSpot({ accessToken: env("HUBSPOT_TOKEN") }).crm.deals.basicApi.archive(t.dealId).catch(() => {});
    console.log("\nCleaned up test deal and draft (use --keep to inspect them).");
  }
  await pg?.close({ timeout: 2 });
}

console.log(failures.length ? `\n❌ ${failures.length} problem(s): ${failures.join("; ")}` : "\n✅ Live smoke test passed.");
process.exit(failures.length ? 1 : 0);
