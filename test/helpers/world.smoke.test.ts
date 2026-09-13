import { describe, expect, it } from "vitest";
import { createWorld, V1 } from "./world.js";

describe("test world helper", () => {
  it("creates a deal and draft from an instruction", async () => {
    const w = await createWorld();
    const r = await w.instruct(V1);
    expect(r.status).toBe("completed");
    expect((await w.deal())?.fields.amount).toBe("42000");
    expect((await w.draft())?.subject).toBe("Proposal for Acme Corp");
  });
});
