import { describe, expect, it } from "vitest";
import { diffFacts, normalizeFacts, type FactSet } from "../../src/core/facts.js";
import {
  BODY_DEPS,
  DEAL_FIELD_DEPS,
  bodyToken,
  compile,
  formatDate,
  formatUsd,
  netAmount,
  requiredBodyTokens,
  staleBodyTokens,
  subjectFor,
} from "../../src/core/compile.js";
import { reconcileField, type BaseRecord } from "../../src/core/reconcile.js";
import { cleanSlackText, composeInstruction } from "../../src/engine/engine.js";
import { HeuristicRouter, mentionsCandidate, sameCompany, type RouteCandidate } from "../../src/llm/route.js";

/** Build the raw-fact shape the extractor emits. Source defaults to the value itself. */
const raw = (key: string, value: string, source = value) => ({ key, value, source });

/**
 * normalizeFacts against an instruction that literally contains every quote used below (or an
 * explicit instruction, for tests that specifically exercise the hallucination guard). The guard
 * requires every fact's source to actually appear in the instruction — this default keeps that
 * true for tests that aren't about the guard itself.
 */
function norm(list: Array<{ key: string; value: string; source: string }>, instruction?: string) {
  return normalizeFacts(list, instruction ?? list.map((r) => r.source).join(" "));
}

/** Minimal FactSet builder (values are assumed already normalized). */
function fs(v: Partial<Record<string, string>>): FactSet {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = { key: k, value: val, source: "" };
  return out as FactSet;
}

// ---------------------------------------------------------------- normalizeFacts / normalizers

describe("normalizeFacts — numbers", () => {
  it("accepts a fully formatted dollar amount with comma and cents", () => {
    const { facts } = norm([raw("deal_amount", "$42,000.50", "$42,000.50")], "it is $42,000.50");
    expect(facts.deal_amount?.value).toBe("42000.5");
  });

  it("expands the k suffix", () => {
    expect(norm([raw("deal_amount", "42.5k")]).facts.deal_amount?.value).toBe("42500");
  });

  it("expands a capital M suffix", () => {
    expect(norm([raw("deal_amount", "1.2M")]).facts.deal_amount?.value).toBe("1200000");
  });

  it("accepts space-grouped digits (40 000)", () => {
    expect(norm([raw("deal_amount", "40 000")]).facts.deal_amount?.value).toBe("40000");
  });

  it("drops a non-USD amount rather than silently treating the number as dollars", () => {
    const { facts, dropped } = norm([raw("deal_amount", "€40k")]);
    expect(facts.deal_amount).toBeUndefined();
    expect(dropped[0]).toContain("deal_amount");
  });

  it("drops a negative amount", () => {
    expect(norm([raw("deal_amount", "-5000")]).facts.deal_amount).toBeUndefined();
  });

  it("keeps a zero amount (a $0 deal is a real value, not a missing one)", () => {
    expect(norm([raw("deal_amount", "0")]).facts.deal_amount?.value).toBe("0");
  });

  it("drops garbage that merely contains digits", () => {
    expect(norm([raw("deal_amount", "42k or so")]).facts.deal_amount).toBeUndefined();
  });

  it("drops NaN / Infinity spellings", () => {
    expect(norm([raw("deal_amount", "NaN")]).facts.deal_amount).toBeUndefined();
    expect(norm([raw("deal_amount", "Infinity")]).facts.deal_amount).toBeUndefined();
    expect(norm([raw("deal_amount", "1e3")]).facts.deal_amount).toBeUndefined();
  });

  it("normalizes a trailing-zero discount so the % token is canonical (10.0 -> 10)", () => {
    expect(norm([raw("discount_pct", "10.0%")]).facts.discount_pct?.value).toBe("10");
  });

  it("keeps a zero discount as 0 rather than dropping it", () => {
    expect(norm([raw("discount_pct", "0%")]).facts.discount_pct?.value).toBe("0");
  });

  it("keeps a 100% discount (free deal is expressible)", () => {
    expect(norm([raw("discount_pct", "100%")]).facts.discount_pct?.value).toBe("100");
  });

  // BUG: a discount over 100% is accepted and compiles to a negative HubSpot amount.
  it("rejects a discount above 100%", () => {
    const { facts } = norm([raw("discount_pct", "150%")]);
    expect(facts.discount_pct).toBeUndefined();
  });
});

describe("normalizeFacts — dates", () => {
  it("accepts a well-formed ISO date", () => {
    expect(norm([raw("close_date", "2026-10-15")]).facts.close_date?.value).toBe("2026-10-15");
  });

  it("drops a non-ISO date (Oct 15)", () => {
    expect(norm([raw("close_date", "Oct 15")]).facts.close_date).toBeUndefined();
  });

  it("drops a date with a time component", () => {
    expect(norm([raw("close_date", "2026-10-15T00:00:00Z")]).facts.close_date).toBeUndefined();
  });

  // BUG: month 13 / day 40 pass the shape check and roll over into a different year.
  it("rejects a syntactically valid but nonexistent date (2026-13-40)", () => {
    expect(norm([raw("close_date", "2026-13-40")]).facts.close_date).toBeUndefined();
  });

  // BUG: Feb 29 in a non-leap year is accepted and later renders as March 1.
  it("rejects Feb 29 in a non-leap year", () => {
    expect(norm([raw("close_date", "2026-02-29")]).facts.close_date).toBeUndefined();
  });

  it("accepts Feb 29 in a leap year", () => {
    expect(norm([raw("close_date", "2028-02-29")]).facts.close_date?.value).toBe("2028-02-29");
  });
});

describe("normalizeFacts — email", () => {
  it("lowercases an uppercase address", () => {
    expect(norm([raw("contact_email", "Priya@ACME.com")]).facts.contact_email?.value).toBe("priya@acme.com");
  });

  it("keeps plus-addressing intact", () => {
    expect(norm([raw("contact_email", "priya+deals@acme.com")]).facts.contact_email?.value).toBe("priya+deals@acme.com");
  });

  it("trims surrounding whitespace", () => {
    expect(norm([raw("contact_email", "  priya@acme.com  ")]).facts.contact_email?.value).toBe("priya@acme.com");
  });

  // BUG: sentence punctuation is kept, so Gmail gets an unroutable recipient.
  it("strips or rejects a trailing period from an address quoted mid-sentence", () => {
    const v = norm([raw("contact_email", "priya@acme.com.")]).facts.contact_email?.value;
    expect(v === undefined || v === "priya@acme.com").toBe(true);
  });

  it("drops an address with no dot in the domain", () => {
    expect(norm([raw("contact_email", "priya@acme")]).facts.contact_email).toBeUndefined();
  });

  it("drops an address with two @", () => {
    expect(norm([raw("contact_email", "a@b@c.com")]).facts.contact_email).toBeUndefined();
  });

  it("accepts a unicode local part", () => {
    expect(norm([raw("contact_email", "prïya@acme.com")]).facts.contact_email?.value).toBe("prïya@acme.com");
  });
});

describe("normalizeFacts — enums and text", () => {
  it("accepts a known deal stage", () => {
    expect(norm([raw("deal_stage", "closedwon")]).facts.deal_stage?.value).toBe("closedwon");
  });

  it("drops an unknown deal stage instead of writing it to HubSpot", () => {
    expect(norm([raw("deal_stage", "negotiation")]).facts.deal_stage).toBeUndefined();
  });

  it("drops a mis-cased deal stage (HubSpot ids are exact)", () => {
    expect(norm([raw("deal_stage", "ClosedWon")]).facts.deal_stage).toBeUndefined();
  });

  it("accepts only literal true/false for cancelled", () => {
    expect(norm([raw("cancelled", "true")]).facts.cancelled?.value).toBe("true");
    expect(norm([raw("cancelled", "yes")]).facts.cancelled).toBeUndefined();
  });

  it("accepts only send/draft for delivery", () => {
    expect(norm([raw("delivery", "send")]).facts.delivery?.value).toBe("send");
    expect(norm([raw("delivery", "SEND")]).facts.delivery).toBeUndefined();
  });

  it("drops a whitespace-only company", () => {
    const { facts, dropped } = norm([raw("company", "   ")]);
    expect(facts.company).toBeUndefined();
    expect(dropped).toHaveLength(1);
  });

  it("trims a company name", () => {
    expect(norm([raw("company", "  Acme Corp\n")]).facts.company?.value).toBe("Acme Corp");
  });
});

describe("normalizeFacts — keys and the hallucination guard", () => {
  it("drops an unknown key with a reason", () => {
    const { facts, dropped } = norm([raw("deal_probability", "80")]);
    expect(Object.keys(facts)).toHaveLength(0);
    expect(dropped[0]).toBe("deal_probability: unknown key");
  });

  it("does not let a prototype-polluting key through", () => {
    const { facts } = norm([raw("__proto__", "x"), raw("constructor", "y")]);
    expect(Object.keys(facts)).toHaveLength(0);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("last duplicate wins so a later correction in the same extraction is not shadowed", () => {
    const { facts } = norm([raw("deal_amount", "42000"), raw("deal_amount", "50000")]);
    expect(facts.deal_amount?.value).toBe("50000");
  });

  it("an invalid duplicate does not clobber the valid earlier value", () => {
    const { facts } = norm([raw("deal_amount", "42000"), raw("deal_amount", "lots")]);
    expect(facts.deal_amount?.value).toBe("42000");
  });

  it("drops a fact whose quote is absent from the instruction", () => {
    const { facts, dropped } = norm([raw("deal_amount", "99000", "$99k")], "Acme is ready, $42k");
    expect(facts.deal_amount).toBeUndefined();
    expect(dropped[0]).toContain("not found in instruction");
  });

  it("matches a quote case-insensitively", () => {
    const { facts } = norm([raw("company", "Acme Corp", "ACME CORP")], "acme corp is ready");
    expect(facts.company?.value).toBe("Acme Corp");
  });

  // BUG: an empty source skips the guard entirely, so a fact with no evidence is accepted.
  it("drops a fact that carries no source quote at all", () => {
    const { facts, dropped } = norm([raw("deal_amount", "99000", "")], "Acme is ready");
    expect(facts.deal_amount).toBeUndefined();
    expect(dropped).toHaveLength(1);
  });

  it("drops a quote that only differs by fabricated wording", () => {
    const { facts } = norm([raw("next_step", "ship it", "we will ship it")], "Acme is ready to go");
    expect(facts.next_step).toBeUndefined();
  });

  it("a quote lifted from a different sentence still counts (substring guard is intentional)", () => {
    const { facts } = norm([raw("next_step", "call Priya", "call Priya")], "do not call Priya yet; send the deck");
    expect(facts.next_step?.value).toBe("call Priya");
  });
});

describe("diffFacts", () => {
  it("reports nothing when both sides are empty", () => {
    expect(diffFacts(undefined, {})).toEqual([]);
  });

  it("reports a key added against an undefined previous set", () => {
    expect(diffFacts(undefined, fs({ deal_amount: "42000" }))).toEqual(["deal_amount"]);
  });

  it("reports a key that was removed", () => {
    expect(diffFacts(fs({ next_step: "call" }), {})).toEqual(["next_step"]);
  });

  it("ignores a changed source quote when the value is identical", () => {
    const prev: FactSet = { deal_amount: { key: "deal_amount", value: "42000", source: "$42k" } };
    const next: FactSet = { deal_amount: { key: "deal_amount", value: "42000", source: "42,000 dollars" } };
    expect(diffFacts(prev, next)).toEqual([]);
  });

  it("returns keys in the stable FACT_KEYS order, not insertion order", () => {
    expect(diffFacts(fs({}), fs({ close_date: "2026-10-15", company: "Acme" }))).toEqual(["company", "close_date"]);
  });
});

// ---------------------------------------------------------------- compile

describe("netAmount", () => {
  it("is undefined when there is no gross amount, even with a discount", () => {
    expect(netAmount(fs({ discount_pct: "10" }))).toBeUndefined();
  });

  it("applies a whole-percent discount", () => {
    expect(netAmount(fs({ deal_amount: "42000", discount_pct: "10" }))).toBe("37800");
  });

  it("rounds a repeating-decimal discount to cents", () => {
    expect(netAmount(fs({ deal_amount: "42000", discount_pct: "33.33" }))).toBe("28001.4");
  });

  it("does not leak binary float noise into the value", () => {
    const n = netAmount(fs({ deal_amount: "0.3", discount_pct: "10" }))!;
    expect(n).not.toMatch(/\d{6,}$/);
  });

  it("a 100% discount is $0, not undefined", () => {
    expect(netAmount(fs({ deal_amount: "42000", discount_pct: "100" }))).toBe("0");
  });

  // BUG: netAmount happily produces a negative amount from an over-100% discount.
  it("never produces a negative amount", () => {
    expect(parseFloat(netAmount(fs({ deal_amount: "42000", discount_pct: "150" }))!)).toBeGreaterThanOrEqual(0);
  });

  it("treats a missing discount as zero", () => {
    expect(netAmount(fs({ deal_amount: "42000" }))).toBe("42000");
  });
});

describe("compile", () => {
  it("compiles nothing for an empty fact set", () => {
    const d = compile({});
    expect(d.deal).toEqual([]);
    expect(d.draft.exists).toBe(false);
  });

  it("omits a deal field whose fact is absent (so it is not written as empty)", () => {
    const d = compile(fs({ company: "Acme" }));
    expect(d.deal.map((f) => f.field)).toEqual(["dealname"]);
  });

  it("cancelled forces closedlost over an explicit stage", () => {
    const d = compile(fs({ company: "Acme", deal_stage: "closedwon", cancelled: "true" }));
    expect(d.deal.find((f) => f.field === "dealstage")?.value).toBe("closedlost");
  });

  it("cancelled suppresses the draft even with a contact", () => {
    const d = compile(fs({ company: "Acme", contact_email: "p@acme.com", cancelled: "true" }));
    expect(d.draft.exists).toBe(false);
    expect(d.draft.fields).toEqual([]);
  });

  it("cancelled=false does not suppress the draft", () => {
    const d = compile(fs({ company: "Acme", contact_email: "p@acme.com", cancelled: "false" }));
    expect(d.draft.exists).toBe(true);
  });

  it("no draft without a recipient", () => {
    expect(compile(fs({ company: "Acme" })).draft.exists).toBe(false);
  });

  it("no draft without a company (the subject needs one)", () => {
    expect(compile(fs({ contact_email: "p@acme.com" })).draft.exists).toBe(false);
  });

  it("body cmp changes when any body dep changes", () => {
    const a = compile(fs({ company: "Acme", contact_email: "p@acme.com", deal_amount: "42000" }));
    const b = compile(fs({ company: "Acme", contact_email: "p@acme.com", deal_amount: "50000" }));
    const cmpOf = (d: ReturnType<typeof compile>) => d.draft.fields.find((f) => f.field === "body")!.cmp;
    expect(cmpOf(a)).not.toBe(cmpOf(b));
  });

  it("body cmp is stable when only a non-body fact changes", () => {
    const a = compile(fs({ company: "Acme", contact_email: "p@acme.com", deal_stage: "qualifiedtobuy" }));
    const b = compile(fs({ company: "Acme", contact_email: "p@acme.com", deal_stage: "closedwon" }));
    const cmpOf = (d: ReturnType<typeof compile>) => d.draft.fields.find((f) => f.field === "body")!.cmp;
    expect(cmpOf(a)).toBe(cmpOf(b));
  });

  it("body spec is not ambiguous across facts (a value containing the separator cannot forge another fact)", () => {
    const a = compile(fs({ company: "Acme", contact_email: "p@acme.com", next_step: "x|email_intent=send" }));
    const b = compile(fs({ company: "Acme", contact_email: "p@acme.com", next_step: "x", email_intent: "send" }));
    const cmpOf = (d: ReturnType<typeof compile>) => d.draft.fields.find((f) => f.field === "body")!.cmp;
    expect(cmpOf(a)).not.toBe(cmpOf(b));
  });

  it("every deal field's declared deps match DEAL_FIELD_DEPS (clearing uses that map)", () => {
    const d = compile(fs({ company: "Acme", deal_amount: "1", close_date: "2026-10-15", deal_stage: "closedwon", next_step: "call" }));
    for (const f of d.deal) expect(f.deps).toEqual(DEAL_FIELD_DEPS[f.field]);
  });

  it("the body field declares exactly BODY_DEPS", () => {
    const d = compile(fs({ company: "Acme", contact_email: "p@acme.com" }));
    expect(d.draft.fields.find((f) => f.field === "body")!.deps).toEqual(BODY_DEPS);
  });

  it("the body has no pre-known token (it is generated, so it cannot be compared before writing)", () => {
    const body = compile(fs({ company: "Acme", contact_email: "p@acme.com" })).draft.fields.find((f) => f.field === "body")!;
    expect(body.value).toBeNull();
    expect(body.expectedToken).toBeUndefined();
  });

  it("amount is the net (discount applied), not the gross", () => {
    const d = compile(fs({ company: "Acme", deal_amount: "42000", discount_pct: "10" }));
    expect(d.deal.find((f) => f.field === "amount")?.value).toBe("37800");
  });
});

describe("subjectFor", () => {
  it("falls back to Next steps with no intent", () => {
    expect(subjectFor("Acme Corp", undefined)).toBe("Next steps for Acme Corp");
  });

  it("falls back to Next steps for an empty intent", () => {
    expect(subjectFor("Acme Corp", "")).toBe("Next steps for Acme Corp");
  });

  it("is stable across wordings of the same intent", () => {
    const a = subjectFor("Acme", "send the proposal");
    expect(subjectFor("Acme", "send the updated proposal")).toBe(a);
    expect(subjectFor("Acme", "please send over the revised proposal")).toBe(a);
    expect(subjectFor("Acme", "email her the proposal")).toBe(a);
    expect(a).toBe("Proposal for Acme");
  });

  it("strips trailing sentence punctuation", () => {
    expect(subjectFor("Acme", "send the proposal!!")).toBe("Proposal for Acme");
  });

  // BUG: a bare verb leaves the verb as the subject noun ("Send for Acme").
  it("a bare verb carries no noun and should fall back", () => {
    expect(subjectFor("Acme", "send")).toBe("Next steps for Acme");
  });

  // BUG: pronoun objects other than him/her/them survive ("It now for Acme").
  it("a verb plus a pronoun object should fall back too", () => {
    expect(subjectFor("Acme", "Send it now!")).toBe("Next steps for Acme");
  });

  it("keeps a genuine follow-up intent", () => {
    expect(subjectFor("Acme", "follow up on the pricing")).toBe("Pricing for Acme");
  });

  it("handles a non-ascii intent without crashing", () => {
    expect(subjectFor("Åcme", "envoyer la propuesta")).toContain("for Åcme");
  });

  it("does not produce an unusable multi-line subject", () => {
    expect(subjectFor("Acme", "send the proposal\nand the SOW")).not.toContain("\n");
  });

  it("keeps the subject within RFC-sane length for a rambling intent", () => {
    expect(subjectFor("Acme", "the " + "very ".repeat(300) + "long proposal").length).toBeLessThanOrEqual(998);
  });
});

describe("formatUsd", () => {
  it("groups thousands with no cents for a whole amount", () => {
    expect(formatUsd("42000")).toBe("$42,000");
  });

  it("shows exactly two decimals when there are cents", () => {
    expect(formatUsd("42000.5")).toBe("$42,000.50");
  });

  it("formats zero", () => {
    expect(formatUsd("0")).toBe("$0");
  });

  it("formats millions", () => {
    expect(formatUsd("1200000")).toBe("$1,200,000");
  });

  // BUG: reachable via an over-100% discount; "$-21,000" is not how money is written.
  it("puts the minus sign before the currency symbol", () => {
    expect(formatUsd("-21000")).toBe("-$21,000");
  });
});

describe("formatDate", () => {
  it("formats a date without timezone drift (a UTC date must not slip a day)", () => {
    expect(formatDate("2026-10-15")).toBe("October 15, 2026");
  });

  it("formats Jan 1 correctly", () => {
    expect(formatDate("2026-01-01")).toBe("January 1, 2026");
  });

  it("formats Dec 31 correctly", () => {
    expect(formatDate("2026-12-31")).toBe("December 31, 2026");
  });

  it("formats a real leap day", () => {
    expect(formatDate("2028-02-29")).toBe("February 29, 2028");
  });

  // BUG: formatDate rolls invalid input into a plausible-looking wrong date.
  it("does not invent a date out of an impossible one", () => {
    expect(formatDate("2026-13-40")).not.toBe("February 9, 2027");
  });
});

describe("requiredBodyTokens", () => {
  it("is empty when nothing is known", () => {
    expect(requiredBodyTokens({})).toEqual([]);
  });

  it("uses only the contact's first name", () => {
    expect(requiredBodyTokens(fs({ contact_name: "Priya Patel" }))).toEqual(["Priya"]);
  });

  it("requires the net amount, not the gross", () => {
    expect(requiredBodyTokens(fs({ deal_amount: "42000", discount_pct: "10" }))).toContain("$37,800");
  });

  it("emits a canonical discount token for a normalized 10.0", () => {
    const pct = norm([raw("discount_pct", "10.0")]).facts.discount_pct!.value;
    expect(requiredBodyTokens(fs({ discount_pct: pct }))).toEqual(["10%"]);
  });

  it("does not require a 0% discount to be mentioned", () => {
    expect(requiredBodyTokens(fs({ discount_pct: "0" }))).toEqual([]);
  });

  it("keeps a fractional discount token", () => {
    expect(requiredBodyTokens(fs({ discount_pct: "12.5" }))).toContain("12.5%");
  });

  it("requires a $0 amount to be stated (a free deal is still a number in the email)", () => {
    expect(requiredBodyTokens(fs({ deal_amount: "0" }))).toContain("$0");
  });

  it("handles a single-word contact name", () => {
    expect(requiredBodyTokens(fs({ contact_name: "Priya" }))).toEqual(["Priya"]);
  });
});

describe("staleBodyTokens", () => {
  it("is empty with no previous version", () => {
    expect(staleBodyTokens(undefined, fs({ deal_amount: "42000" }))).toEqual([]);
  });

  it("reports the old amount when it changes", () => {
    expect(staleBodyTokens(fs({ deal_amount: "42000" }), fs({ deal_amount: "50000" }))).toEqual(["$42,000"]);
  });

  it("reports both the old net amount and the removed discount", () => {
    expect(staleBodyTokens(fs({ deal_amount: "42000", discount_pct: "10" }), fs({ deal_amount: "42000" }))).toEqual(["$37,800", "10%"]);
  });

  it("reports nothing when the facts are unchanged", () => {
    const f = fs({ deal_amount: "42000", close_date: "2026-10-15" });
    expect(staleBodyTokens(f, f)).toEqual([]);
  });

  // BUG: "$42,000" is a substring of the new "$142,000", so a correct body is flagged stale.
  it("never reports a stale token that is contained in a still-required token", () => {
    const stale = staleBodyTokens(fs({ deal_amount: "42000" }), fs({ deal_amount: "142000" }));
    const required = requiredBodyTokens(fs({ deal_amount: "142000" }));
    expect(stale.filter((t) => required.some((r) => r.includes(t)))).toEqual([]);
  });

  // BUG: same containment problem for percentages ("5%" inside "15%").
  it("does not report 5% as stale when the new discount is 15%", () => {
    const stale = staleBodyTokens(fs({ discount_pct: "5" }), fs({ discount_pct: "15" }));
    expect(stale.filter((t) => "15%".includes(t))).toEqual([]);
  });

  // BUG: same containment problem for a first name that is a prefix of the new one.
  it("does not report Sam as stale when the new contact is Samantha", () => {
    const stale = staleBodyTokens(fs({ contact_name: "Sam Rivera" }), fs({ contact_name: "Samantha Rivera" }));
    expect(stale.filter((t) => "Samantha".includes(t))).toEqual([]);
  });

  it("reports the old date when the close date moves", () => {
    expect(staleBodyTokens(fs({ close_date: "2026-10-15" }), fs({ close_date: "2026-11-01" }))).toEqual(["October 15, 2026"]);
  });
});

describe("bodyToken", () => {
  it("is insensitive to CRLF vs LF", () => {
    expect(bodyToken("Hi Priya,\r\nHere it is.")).toBe(bodyToken("Hi Priya,\nHere it is."));
  });

  it("collapses runs of whitespace", () => {
    expect(bodyToken("Hi   Priya")).toBe(bodyToken("Hi Priya"));
  });

  it("ignores leading and trailing whitespace", () => {
    expect(bodyToken("\n Hi Priya \n")).toBe(bodyToken("Hi Priya"));
  });

  it("treats a non-breaking space like a space (Slack/Gmail insert them)", () => {
    expect(bodyToken("Hi Priya")).toBe(bodyToken("Hi Priya"));
  });

  it("is sensitive to real content changes", () => {
    expect(bodyToken("$42,000")).not.toBe(bodyToken("$50,000"));
  });

  it("is sensitive to case (a human rewrite is a human rewrite)", () => {
    expect(bodyToken("hi priya")).not.toBe(bodyToken("Hi Priya"));
  });

  it("does not collide word boundaries away (a b != ab)", () => {
    expect(bodyToken("a b")).not.toBe(bodyToken("ab"));
  });

  it("handles an empty body", () => {
    expect(bodyToken("")).toBe(bodyToken("   \n  "));
  });
});

// ---------------------------------------------------------------- reconcileField

const base = (desiredCmp: string, observedToken: string | null): BaseRecord => ({ desiredCmp, observedToken });

describe("reconcileField — no base (first write)", () => {
  it("creates when nothing was ever written", () => {
    expect(reconcileField({ desiredCmp: "42000", desiredToken: "42000", base: null, currentToken: null })).toEqual({ kind: "apply", reason: "create" });
  });

  it("is a noop when the app already holds exactly the desired value", () => {
    expect(reconcileField({ desiredCmp: "42000", desiredToken: "42000", base: null, currentToken: "42000" })).toEqual({ kind: "noop_already" });
  });

  it("creates a generated field (unknowable token) even if something is there", () => {
    expect(reconcileField({ desiredCmp: "spec:abc", base: null, currentToken: "whatever" })).toEqual({ kind: "apply", reason: "create" });
  });

  it("treats an empty desired token and an empty current as already correct", () => {
    expect(reconcileField({ desiredCmp: "∅cleared", desiredToken: null, base: null, currentToken: null })).toEqual({ kind: "noop_already" });
  });

  it("ignores a resolution when there is no base (nothing to conflict with)", () => {
    expect(reconcileField({ desiredCmp: "x", desiredToken: "x", base: null, currentToken: "human", resolution: "keep_human" })).toEqual({ kind: "apply", reason: "create" });
  });
});

describe("reconcileField — untouched by humans", () => {
  it("applies when the spec changed", () => {
    expect(reconcileField({ desiredCmp: "50000", desiredToken: "50000", base: base("42000", "42000"), currentToken: "42000" })).toEqual({ kind: "apply", reason: "spec_changed" });
  });

  it("does nothing when neither side moved", () => {
    expect(reconcileField({ desiredCmp: "42000", desiredToken: "42000", base: base("42000", "42000"), currentToken: "42000" })).toEqual({ kind: "noop_unchanged" });
  });

  it("clears a field whose facts were deleted", () => {
    expect(reconcileField({ desiredCmp: "∅cleared", desiredToken: null, base: base("call Priya", "call Priya"), currentToken: "call Priya" })).toEqual({ kind: "apply", reason: "spec_changed" });
  });

  it("does not re-clear an already cleared field", () => {
    expect(reconcileField({ desiredCmp: "∅cleared", desiredToken: null, base: base("∅cleared", null), currentToken: null })).toEqual({ kind: "noop_unchanged" });
  });

  it("regenerates the body when its spec changed", () => {
    expect(reconcileField({ desiredCmp: "spec:new", base: base("spec:old", "tok-old"), currentToken: "tok-old" })).toEqual({ kind: "apply", reason: "spec_changed" });
  });
});

describe("reconcileField — human touched the field", () => {
  it("keeps a human edit to a field whose spec did not change", () => {
    expect(reconcileField({ desiredCmp: "42000", desiredToken: "42000", base: base("42000", "42000"), currentToken: "44000" })).toEqual({ kind: "preserve_human" });
  });

  it("raises a conflict when both the human and the spec changed the same field", () => {
    expect(reconcileField({ desiredCmp: "50000", desiredToken: "50000", base: base("42000", "42000"), currentToken: "44000" })).toEqual({ kind: "conflict" });
  });

  it("is a noop when the human happened to type the new desired value", () => {
    expect(reconcileField({ desiredCmp: "50000", desiredToken: "50000", base: base("42000", "42000"), currentToken: "50000" })).toEqual({ kind: "noop_already" });
  });

  it("apply_new overrides the human edit", () => {
    expect(reconcileField({ desiredCmp: "50000", desiredToken: "50000", base: base("42000", "42000"), currentToken: "44000", resolution: "apply_new" })).toEqual({ kind: "apply", reason: "resolved_apply_new" });
  });

  it("keep_human accepts the human value as the new base", () => {
    expect(reconcileField({ desiredCmp: "50000", desiredToken: "50000", base: base("42000", "42000"), currentToken: "44000", resolution: "keep_human" })).toEqual({ kind: "accept_human" });
  });

  it("a human deleting the value counts as a human change, not a clear-to-noop", () => {
    expect(reconcileField({ desiredCmp: "42000", desiredToken: "42000", base: base("42000", "42000"), currentToken: null })).toEqual({ kind: "preserve_human" });
  });

  it("conflicts on a human-rewritten body when the spec also changed", () => {
    expect(reconcileField({ desiredCmp: "spec:new", base: base("spec:old", "tok-old"), currentToken: "tok-human" })).toEqual({ kind: "conflict" });
  });

  it("preserves a human-rewritten body when the spec did not change", () => {
    expect(reconcileField({ desiredCmp: "spec:old", base: base("spec:old", "tok-old"), currentToken: "tok-human" })).toEqual({ kind: "preserve_human" });
  });

  it("a resolution does not resurrect a conflict once the values already agree", () => {
    expect(reconcileField({ desiredCmp: "50000", desiredToken: "50000", base: base("42000", "42000"), currentToken: "50000", resolution: "keep_human" })).toEqual({ kind: "noop_already" });
  });

  it("null and undefined desiredToken are not conflated (undefined = unknowable, null = empty)", () => {
    const withNull = reconcileField({ desiredCmp: "c", desiredToken: null, base: base("b", "x"), currentToken: null });
    const withUndef = reconcileField({ desiredCmp: "c", base: base("b", "x"), currentToken: null });
    expect(withNull).toEqual({ kind: "noop_already" });
    expect(withUndef).toEqual({ kind: "conflict" });
  });

  it("a base that was never observed (null) plus a value now present is a human change", () => {
    expect(reconcileField({ desiredCmp: "∅cleared", desiredToken: null, base: base("∅cleared", null), currentToken: "typed by a rep" })).toEqual({ kind: "preserve_human" });
  });
});

// ---------------------------------------------------------------- cleanSlackText

describe("cleanSlackText", () => {
  it("unwraps a labelled mailto link", () => {
    expect(cleanSlackText("contact <mailto:priya@acme.com|priya@acme.com>")).toBe("contact priya@acme.com");
  });

  it("unwraps a bare mailto link", () => {
    expect(cleanSlackText("<mailto:priya@acme.com>")).toBe("priya@acme.com");
  });

  it("keeps the label of a linked url", () => {
    expect(cleanSlackText("see <https://acme.com/x|the deck>")).toBe("see the deck");
  });

  it("unwraps a bare url", () => {
    expect(cleanSlackText("<https://acme.com/x>")).toBe("https://acme.com/x");
  });

  it("renders a channel link as #name", () => {
    expect(cleanSlackText("ask in <#C123ABC|sales>")).toBe("ask in #sales");
  });

  it("decodes entities in the right order so &amp;lt; stays literal &lt;", () => {
    expect(cleanSlackText("&amp;lt;")).toBe("&lt;");
  });

  it("decodes an ampersand in a company name", () => {
    expect(cleanSlackText("Ben &amp; Jerry is ready")).toBe("Ben & Jerry is ready");
  });

  it("decodes angle brackets", () => {
    expect(cleanSlackText("a &lt;b&gt; c")).toBe("a <b> c");
  });

  it("trims surrounding whitespace", () => {
    expect(cleanSlackText("  Acme is ready  ")).toBe("Acme is ready");
  });

  it("leaves plain text untouched", () => {
    expect(cleanSlackText("Acme Corp is ready, $42k")).toBe("Acme Corp is ready, $42k");
  });

  it("does not mangle a lone < in prose", () => {
    expect(cleanSlackText("amount < 50k")).toBe("amount < 50k");
  });

  it("handles an unterminated link markup without throwing", () => {
    expect(() => cleanSlackText("<https://acme.com/x")).not.toThrow();
  });

  it("keeps a pipe that is part of a link label", () => {
    expect(cleanSlackText("<https://a.com|a|b>")).toBe("a|b");
  });

  // BUG: raw user mentions survive into the instruction text (and into source quotes).
  it("removes a user mention that is not at the start of the message", () => {
    expect(cleanSlackText("ping <@U012ABC> about Acme")).toBe("ping about Acme");
  });

  // BUG: a channel link with no label is left as raw markup.
  it("renders an unlabelled channel link readably", () => {
    expect(cleanSlackText("see <#C123ABC>")).not.toContain("<#");
  });

  // BUG: broadcast markup is left as raw markup.
  it("renders <!here> readably", () => {
    expect(cleanSlackText("<!here> Acme is ready")).not.toContain("<!");
  });
});

// ---------------------------------------------------------------- composeInstruction

describe("composeInstruction", () => {
  it("returns a single part unchanged, with no Update prefix", () => {
    expect(composeInstruction([{ ts: "100.1", text: "Acme is ready" }])).toBe("Acme is ready");
  });

  it("orders numerically, not lexicographically (999.1 before 1000.0)", () => {
    expect(composeInstruction([
      { ts: "1000.000100", text: "second" },
      { ts: "999.100000", text: "first" },
    ])).toBe("first\nUpdate: second");
  });

  it("orders microsecond-adjacent Slack timestamps correctly", () => {
    expect(composeInstruction([
      { ts: "1700000000.000200", text: "b" },
      { ts: "1700000000.000100", text: "a" },
    ])).toBe("a\nUpdate: b");
  });

  it("keeps insertion order for identical timestamps (stable sort)", () => {
    expect(composeInstruction([
      { ts: "100.000100", text: "a" },
      { ts: "100.000100", text: "b" },
    ])).toBe("a\nUpdate: b");
  });

  it("does not mutate the caller's array", () => {
    const parts = [{ ts: "2.0", text: "b" }, { ts: "1.0", text: "a" }];
    composeInstruction(parts);
    expect(parts.map((p) => p.text)).toEqual(["b", "a"]);
  });

  it("prefixes every later part, not just the last", () => {
    expect(composeInstruction([
      { ts: "1.0", text: "a" },
      { ts: "2.0", text: "b" },
      { ts: "3.0", text: "c" },
    ])).toBe("a\nUpdate: b\nUpdate: c");
  });

  it("returns an empty string for no parts", () => {
    expect(composeInstruction([])).toBe("");
  });

  it("is deterministic: the same parts in any input order give the same instruction", () => {
    const a = composeInstruction([{ ts: "1.0", text: "a" }, { ts: "2.0", text: "b" }]);
    const b = composeInstruction([{ ts: "2.0", text: "b" }, { ts: "1.0", text: "a" }]);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------- routing helpers

const cand = (company: string, contact?: string): Pick<RouteCandidate, "company" | "contact"> =>
  contact === undefined ? { company } : { company, contact };

describe("mentionsCandidate", () => {
  it("matches the company name", () => {
    expect(mentionsCandidate("sorry, Acme is $50k not $42k", cand("Acme Corp"))).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(mentionsCandidate("ACME needs a new date", cand("Acme Corp"))).toBe(true);
  });

  it("does not match a word that merely contains the company name", () => {
    expect(mentionsCandidate("acmeology is a new prospect", cand("Acme Corp"))).toBe(false);
  });

  it("does not match on a corporate stopword alone", () => {
    expect(mentionsCandidate("the corp is ready", cand("Acme Corp"))).toBe(false);
  });

  it("matches a contact's first name as a whole word", () => {
    expect(mentionsCandidate("Priya asked for a discount", cand("Acme Corp", "Priya Patel"))).toBe(true);
  });

  it("matches the contact email", () => {
    expect(mentionsCandidate("send it to priya@acme.com", cand("Globex", "priya@acme.com"))).toBe(true);
  });

  it("does not match an unrelated message", () => {
    expect(mentionsCandidate("Initech is ready, $10k", cand("Acme Corp", "Priya Patel"))).toBe(false);
  });

  // BUG: words() keeps a trailing "." in the token, so a sentence-final company name never matches.
  it("matches a company name at the end of a sentence", () => {
    expect(mentionsCandidate("sorry, it's $50k for Acme.", cand("Acme Corp"))).toBe(true);
  });

  it("matches a company name followed by a comma", () => {
    expect(mentionsCandidate("for Acme, change the date", cand("Acme Corp"))).toBe(true);
  });

  // BUG: tokens shorter than 3 chars are discarded, so short brands never match.
  it("matches a two-letter company name", () => {
    expect(mentionsCandidate("HP is ready, $50k", cand("HP"))).toBe(true);
  });

  // BUG: an all-stopword company yields no tokens at all.
  it("matches a company made only of generic words", () => {
    expect(mentionsCandidate("The Group is ready", cand("The Group Inc"))).toBe(true);
  });

  // BUG: the contact check is a raw substring test, so "Sam" matches inside "same".
  it("does not match a short contact name inside another word", () => {
    expect(mentionsCandidate("same terms as last time", cand("Globex", "Sam"))).toBe(false);
  });

  it("does not match when the candidate has no contact and no company token hit", () => {
    expect(mentionsCandidate("nothing relevant here", cand("Acme Corp"))).toBe(false);
  });
});

describe("sameCompany", () => {
  it("matches a short form against the full name", () => {
    expect(sameCompany("Acme", "Acme Corp")).toBe(true);
  });

  it("matches regardless of order and case", () => {
    expect(sameCompany("acme corp", "ACME")).toBe(true);
  });

  it("does not match two different companies", () => {
    expect(sameCompany("Acme Corp", "Globex Inc")).toBe(false);
  });

  it("does not match on a shared corporate suffix", () => {
    expect(sameCompany("Acme Inc", "Globex Inc")).toBe(false);
  });

  it("does not match on the shared word 'Tech'", () => {
    expect(sameCompany("Acme Tech", "Globex Tech")).toBe(false);
  });

  // BUG: not reflexive for short names — sameCompany("HP","HP") is false.
  it("a company always matches itself (short name)", () => {
    expect(sameCompany("HP", "HP")).toBe(true);
  });

  // BUG: not reflexive for all-stopword names.
  it("a company always matches itself (generic words only)", () => {
    expect(sameCompany("The Group Inc", "The Group Inc")).toBe(true);
  });

  it("matches a name with punctuation attached", () => {
    expect(sameCompany("Acme.", "Acme Corp")).toBe(true);
  });
});

describe("HeuristicRouter", () => {
  const router = new HeuristicRouter();
  const c = (threadKey: string, company: string): RouteCandidate => ({ threadKey, company, instruction: `${company} is ready` });

  it("routes to the single matching deal", async () => {
    expect(await router.route("Acme is now $50k", [c("t1", "Acme Corp")])).toMatchObject({ kind: "existing", threadKey: "t1" });
  });

  it("honours an explicit request for a new deal", async () => {
    expect(await router.route("new deal for Acme, $10k", [c("t1", "Acme Corp")])).toMatchObject({ kind: "new" });
  });

  it("honours 'separate opportunity'", async () => {
    expect(await router.route("this is a separate opportunity", [c("t1", "Acme Corp")])).toMatchObject({ kind: "new" });
  });

  it("asks when two deals match", async () => {
    expect(await router.route("bump it to $50k", [c("t1", "Acme Corp"), c("t2", "Acme Labs")])).toMatchObject({ kind: "unclear" });
  });

  // BUG: with no candidates it claims "more than one matching deal" and refuses to create anything.
  it("with no candidates the message must start a new deal", async () => {
    expect(await router.route("Acme is ready, $42k", [])).toMatchObject({ kind: "new" });
  });

  // BUG: a single candidate is returned as "existing" even when the message is about another company.
  it("does not fold an unrelated company into the only existing deal", async () => {
    const d = await router.route("Initech is ready, $10k, contact sam@initech.com", [c("t1", "Acme Corp")]);
    expect(d.kind).not.toBe("existing");
  });
});
