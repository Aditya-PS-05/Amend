/**
 * Seeds an in-memory ledger by running a few eval scenarios on the fake apps,
 * then serves the ledger viewer. No credentials needed: `pnpm viewer:demo`.
 */
import { runScenario } from "../evals/harness.js";
import { SCENARIOS } from "../evals/scenarios.js";
import { MemoryStore } from "../src/db/store.js";
import { startViewer } from "../src/web/viewer.js";

const NAMES = ["edit-arrives-between-apps", "sent-then-edit-correction", "human-edit-same-field-conflict-apply"];

const store = new MemoryStore();
for (const name of NAMES) {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario ${name}`);
  const r = await runScenario(s, { store });
  console.log(`[viewer-demo] ${r.passed ? "PASS" : "FAIL"} ${name}${r.error ? `\n${r.error}` : ""}`);
}

const port = Number(process.env.VIEWER_PORT ?? 4000);
startViewer({ store, port, log: (m) => console.log(`[viewer-demo] ${m}`) });
