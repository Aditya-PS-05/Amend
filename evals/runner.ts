import { mkdirSync, writeFileSync } from "node:fs";
import { closeStores, runScenario, type ScenarioResult } from "./harness.js";
import { SCENARIOS } from "./scenarios.js";

const filter = process.argv[2];
const selected = filter ? SCENARIOS.filter((s) => s.name.includes(filter)) : SCENARIOS;

const results: ScenarioResult[] = [];
for (const s of selected) results.push(await runScenario(s));
await closeStores();

const sum = (f: (r: ScenarioResult) => number) => results.reduce((n, r) => n + f(r), 0);
const passed = results.filter((r) => r.passed).length;
const totals = {
  scenarios: results.length,
  passed,
  duplicateDeals: sum((r) => r.metrics.duplicateDeals),
  humanEditsOverwritten: sum((r) => r.metrics.humanEditsOverwritten),
  staleFactsLeft: sum((r) => r.metrics.staleFactsLeft),
  verificationPassed: sum((r) => r.metrics.verificationPassed),
  verificationChecks: sum((r) => r.metrics.verificationChecks),
  writes: sum((r) => r.metrics.writes),
};

const md: string[] = [
  "# Amend scenario scoreboard",
  "",
  `Generated ${new Date().toISOString()} · fake Slack/HubSpot/Gmail with fault injection · ledger: ${process.env.EVAL_DATABASE_URL ? "Postgres" : "in-memory"}`,
  "",
  "| Metric | Result |",
  "|---|---|",
  `| Scenarios passed | **${passed}/${results.length}** |`,
  `| Duplicate deals created | ${totals.duplicateDeals} |`,
  `| Human edits overwritten | ${totals.humanEditsOverwritten} |`,
  `| Stale facts left in emails | ${totals.staleFactsLeft} |`,
  `| Agent self-verification checks passed | ${totals.verificationPassed}/${totals.verificationChecks} |`,
  "",
  "| | Scenario | Category | What it tests | Writes |",
  "|---|---|---|---|---|",
  ...results.map((r) => `| ${r.passed ? "✅" : "❌"} | \`${r.name}\` | ${r.category} | ${r.description} | ${r.metrics.writes} |`),
  "",
];
const failures = results.filter((r) => !r.passed);
if (failures.length) {
  md.push("## Failures", "");
  for (const r of failures) {
    md.push(`### ${r.name}`, "");
    if (r.error) md.push("```", r.error, "```");
    for (const a of r.assertions.filter((x) => !x.ok)) md.push(`- ❌ ${a.name}${a.detail ? ` — got: ${a.detail}` : ""}`);
    md.push("");
  }
}

mkdirSync("evals/out", { recursive: true });
writeFileSync("evals/out/scoreboard.md", md.join("\n"));
writeFileSync("evals/out/results.json", JSON.stringify({ totals, results }, null, 2));

for (const r of results) {
  console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
  if (!r.passed) {
    if (r.error) console.log("   ", r.error.split("\n").slice(0, 4).join("\n    "));
    for (const a of r.assertions.filter((x) => !x.ok)) console.log(`      ✗ ${a.name}${a.detail ? ` — got: ${a.detail}` : ""}`);
  }
}
console.log(`\n${passed}/${results.length} scenarios passed · duplicates ${totals.duplicateDeals} · human edits overwritten ${totals.humanEditsOverwritten} · stale facts ${totals.staleFactsLeft} · self-checks ${totals.verificationPassed}/${totals.verificationChecks}`);
console.log("Scoreboard: evals/out/scoreboard.md");
process.exit(passed === results.length ? 0 : 1);
