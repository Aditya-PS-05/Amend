import { describe, expect, it } from "vitest";
import { runScenario } from "../evals/harness.js";
import { SCENARIOS } from "../evals/scenarios.js";
import { reconcileField } from "../src/core/reconcile.js";
import { compile } from "../src/core/compile.js";
import { normalizeFacts } from "../src/core/facts.js";
import { composeInstruction } from "../src/engine/engine.js";

describe("reconcileField", () => {
  const base = { desiredCmp: "42000", observedToken: "42000" };
  it("applies when the spec changed and no human touched the field", () => {
    expect(reconcileField({ desiredCmp: "50000", desiredToken: "50000", base, currentToken: "42000" }).kind).toBe("apply");
  });
  it("preserves a human edit when the instruction did not change the field", () => {
    expect(reconcileField({ desiredCmp: "42000", desiredToken: "42000", base, currentToken: "45000" }).kind).toBe("preserve_human");
  });
  it("raises a conflict when both changed", () => {
    expect(reconcileField({ desiredCmp: "50000", desiredToken: "50000", base, currentToken: "45000" }).kind).toBe("conflict");
  });
  it("is a no-op when a human already made the requested change", () => {
    expect(reconcileField({ desiredCmp: "50000", desiredToken: "50000", base, currentToken: "50000" }).kind).toBe("noop_already");
  });
});

describe("compile", () => {
  it("tracks derived dependencies", () => {
    const { facts } = normalizeFacts(
      [
        { key: "company", value: "Acme", source: "Acme" },
        { key: "deal_amount", value: "42k", source: "42k" },
        { key: "discount_pct", value: "10", source: "10%" },
      ],
      "Acme 42k 10%",
    );
    const amount = compile(facts).deal.find((f) => f.field === "amount")!;
    expect(amount.value).toBe("37800");
    expect(amount.deps).toEqual(["deal_amount", "discount_pct"]);
  });
  it("drops facts whose source quote is not in the instruction", () => {
    const { facts, dropped } = normalizeFacts([{ key: "deal_amount", value: "99000", source: "$99k" }], "Deal is $42k");
    expect(facts.deal_amount).toBeUndefined();
    expect(dropped).toHaveLength(1);
  });
});

describe("composeInstruction", () => {
  it("orders thread parts by ts and marks replies as updates", () => {
    expect(
      composeInstruction([
        { ts: "1726000100.000200", text: "make it $50k" },
        { ts: "1726000000.000100", text: "Acme $42k" },
      ]),
    ).toBe("Acme $42k\nUpdate: make it $50k");
  });
});

describe("scenarios", () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const r = await runScenario(s);
      expect(r.error).toBeUndefined();
      expect(r.assertions.filter((a) => !a.ok)).toEqual([]);
    });
  }
});
