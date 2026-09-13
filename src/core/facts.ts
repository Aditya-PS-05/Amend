import { z } from "zod";

/**
 * The typed facts Amend extracts from a Slack instruction. The LLM only ever
 * produces these; everything downstream is deterministic code.
 */
export const FACT_KEYS = [
  "company",
  "contact_name",
  "contact_email",
  "deal_amount",
  "discount_pct",
  "close_date",
  "deal_stage",
  "next_step",
  "email_intent",
  "cancelled",
  /** How the user wants the email handled: "send" (explicitly asked to send now) or "draft" (explicitly review first). */
  "delivery",
] as const;

export type FactKey = (typeof FACT_KEYS)[number];

export const DEAL_STAGES = [
  "appointmentscheduled",
  "qualifiedtobuy",
  "presentationscheduled",
  "decisionmakerboughtin",
  "contractsent",
  "closedwon",
  "closedlost",
] as const;

export interface Fact {
  key: FactKey;
  /** Normalized value: numbers as plain decimals, dates as YYYY-MM-DD, booleans "true"/"false". */
  value: string;
  /** Exact substring of the instruction that justifies this fact. */
  source: string;
}

export type FactSet = Partial<Record<FactKey, Fact>>;

export interface Extraction {
  facts: FactSet;
  /** Instructions that try to act outside the sales-handoff scope (e.g. prompt injection). */
  rejected: string[];
  /** Questions to ask back when the instruction is ambiguous. */
  clarifications: string[];
}

const NORMALIZERS: Record<FactKey, (v: string) => string | null> = {
  company: (v) => v.trim() || null,
  contact_name: (v) => v.trim() || null,
  // A trailing sentence-punctuation character quoted along with the address ("...priya@acme.com.")
  // is not part of the address; strip one before validating, rather than rejecting the whole fact.
  contact_email: (v) => {
    const t = v.trim().replace(/[.,;:!?)>\]]+$/, "");
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t.toLowerCase() : null;
  },
  deal_amount: (v) => normalizeNumber(v),
  // A discount over 100% isn't a real discount (it would make the deal negative) and 100% exactly
  // (free) is legitimate and expressible elsewhere as "cancelled" if that's actually meant.
  discount_pct: (v) => {
    const n = normalizeNumber(v.replace("%", ""));
    return n !== null && parseFloat(n) <= 100 ? n : null;
  },
  close_date: (v) => (isRealCalendarDate(v.trim()) ? v.trim() : null),
  deal_stage: (v) => ((DEAL_STAGES as readonly string[]).includes(v.trim()) ? v.trim() : null),
  next_step: (v) => v.trim() || null,
  email_intent: (v) => v.trim() || null,
  cancelled: (v) => (v.trim() === "true" ? "true" : v.trim() === "false" ? "false" : null),
  delivery: (v) => (v.trim() === "send" || v.trim() === "draft" ? v.trim() : null),
};

function normalizeNumber(v: string): string | null {
  const m = v.trim().toLowerCase().replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1);
  return String(Math.round(n * 100) / 100);
}

/**
 * "YYYY-MM-DD" is only a real calendar date if it round-trips through Date's UTC parser —
 * `Date.parse`/`new Date(...)` silently rolls month 13 or Feb 30 over into the following month
 * instead of rejecting them, which would otherwise write a plausible-looking wrong date.
 */
function isRealCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Validates raw facts from any extractor. Drops facts with invalid values or
 * whose source quote does not appear in the instruction (hallucination guard).
 */
export function normalizeFacts(
  raw: Array<{ key: string; value: string; source: string }>,
  instruction: string,
): { facts: FactSet; dropped: string[] } {
  const facts: FactSet = {};
  const dropped: string[] = [];
  const haystack = instruction.toLowerCase();
  for (const r of raw) {
    if (!(FACT_KEYS as readonly string[]).includes(r.key)) {
      dropped.push(`${r.key}: unknown key`);
      continue;
    }
    const key = r.key as FactKey;
    const value = NORMALIZERS[key](r.value);
    if (value === null) {
      dropped.push(`${key}: invalid value "${r.value}"`);
      continue;
    }
    // Every fact must be backed by a real, non-empty quote from the instruction. An empty or
    // whitespace-only source is not "no quote to check" — it's a hallucination the guard must catch.
    const source = r.source?.trim() ?? "";
    if (!source || !haystack.includes(source.toLowerCase())) {
      dropped.push(`${key}: source "${r.source ?? ""}" not found in instruction`);
      continue;
    }
    facts[key] = { key, value, source };
  }
  return { facts, dropped };
}

export function factValue(facts: FactSet, key: FactKey): string | undefined {
  return facts[key]?.value;
}

/** Keys whose normalized value differs between two fact sets. */
export function diffFacts(prev: FactSet | undefined, next: FactSet): FactKey[] {
  return FACT_KEYS.filter((k) => prev?.[k]?.value !== next[k]?.value);
}

export const ExtractionSchema = z.object({
  facts: z.array(
    z.object({
      key: z.enum(FACT_KEYS),
      value: z.string(),
      source: z.string(),
    }),
  ),
  rejected_instructions: z.array(z.string()),
  clarifications: z.array(z.string()),
});
