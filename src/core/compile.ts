import { createHash } from "node:crypto";
import type { AttachmentMeta, DealField, DraftField } from "../adapters/types.js";
import { factValue, type FactKey, type FactSet } from "./facts.js";

export type ResourceKind = "deal" | "draft";

export interface DesiredField<F extends string = string> {
  resource: ResourceKind;
  field: F;
  /** Concrete value to write. Null for generated fields (email body). */
  value: string | null;
  /** Comparable spec token: identical spec => identical cmp, across versions. */
  cmp: string;
  /** Observed token we expect to read back, when knowable before writing (null = empty). */
  expectedToken?: string | null;
  /** Facts this field is derived from. */
  deps: FactKey[];
}

export interface DesiredState {
  deal: DesiredField<DealField>[];
  draft: { exists: boolean; fields: DesiredField<DraftField>[] };
}

export function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** How an observed body is compared: whitespace-insensitive hash. */
export function bodyToken(body: string): string {
  return sha(body.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim());
}

/** Identity of a set of attachments as Gmail can observe it (name and size; order-insensitive). */
export function attachmentsToken(list: AttachmentMeta[] | undefined): string {
  if (!list?.length) return "none";
  return sha(list.map((a) => `${a.name}:${a.size}`).sort().join("\n"));
}

function concrete<F extends string>(
  resource: ResourceKind,
  field: F,
  value: string | undefined,
  deps: FactKey[],
): DesiredField<F> | null {
  if (value === undefined) return null;
  return { resource, field, value, cmp: value, expectedToken: value, deps };
}

export function netAmount(facts: FactSet): string | undefined {
  const gross = factValue(facts, "deal_amount");
  if (gross === undefined) return undefined;
  // facts.ts rejects discount_pct over 100 during extraction, but this is called directly in a few
  // places (e.g. required-token checks on arbitrary fact sets) — never let a deal amount go negative.
  const pct = Math.min(100, Math.max(0, parseFloat(factValue(facts, "discount_pct") ?? "0")));
  return String(Math.max(0, Math.round(parseFloat(gross) * (1 - pct / 100) * 100) / 100));
}

/** Facts each HubSpot field is derived from (used to clear a field when its facts are removed). */
export const DEAL_FIELD_DEPS: Record<DealField, FactKey[]> = {
  dealname: ["company"],
  amount: ["deal_amount", "discount_pct"],
  closedate: ["close_date"],
  dealstage: ["deal_stage", "cancelled"],
  hs_next_step: ["next_step"],
};

export const CLEARED_CMP = "∅cleared";

export const BODY_DEPS: FactKey[] = [
  "contact_name",
  "company",
  "deal_amount",
  "discount_pct",
  "close_date",
  "next_step",
  "email_intent",
];

/**
 * Deterministic compilation of facts into the desired state of every managed
 * field, each annotated with the facts it depends on.
 */
/** `attachments` is undefined when the instruction never carried files, so the email ignores them entirely. */
export function compile(facts: FactSet, attachments?: AttachmentMeta[]): DesiredState {
  const cancelled = factValue(facts, "cancelled") === "true";
  const company = factValue(facts, "company");

  const deal = [
    concrete("deal", "dealname", company, ["company"]),
    concrete("deal", "amount", netAmount(facts), ["deal_amount", "discount_pct"]),
    concrete("deal", "closedate", factValue(facts, "close_date"), ["close_date"]),
    concrete(
      "deal",
      "dealstage",
      cancelled ? "closedlost" : factValue(facts, "deal_stage"),
      ["deal_stage", "cancelled"],
    ),
    concrete("deal", "hs_next_step", factValue(facts, "next_step"), ["next_step"]),
  ].filter((f): f is DesiredField<DealField> => f !== null);

  const to = factValue(facts, "contact_email");
  const exists = !cancelled && to !== undefined && company !== undefined;
  const fields: DesiredField<DraftField>[] = [];
  if (exists) {
    fields.push(concrete("draft", "to", to, ["contact_email"])!);
    fields.push(concrete("draft", "subject", subjectFor(company!, factValue(facts, "email_intent")), ["company", "email_intent"])!);
    const names = attachments?.map((a) => a.name) ?? [];
    const spec = BODY_DEPS.map((k) => `${k}=${factValue(facts, k) ?? ""}`).join("|") + (names.length ? `|files=${names.join(",")}` : "");
    fields.push({ resource: "draft", field: "body", value: null, cmp: `spec:${sha(spec)}`, deps: BODY_DEPS });
    if (attachments !== undefined) {
      const token = attachmentsToken(attachments);
      fields.push({ resource: "draft", field: "attachments", value: names.join(", "), cmp: `files:${token}`, expectedToken: token, deps: [] });
    }
  }
  return { deal, draft: { exists, fields } };
}

/** "send the updated proposal" → "Proposal for Acme Corp". Stable across wording changes of the same intent. */
export function subjectFor(company: string, intent: string | undefined): string {
  const noun = (intent ?? "")
    .trim()
    // Collapse embedded newlines/runs of whitespace first: a subject line must never contain one.
    .replace(/\s+/g, " ")
    .replace(/^(please\s*)?(go ahead and\s*)?(send|share|email|forward|confirm|provide|deliver|draft|prepare|write|follow up (on|with|about)|follow up)\s*(over\s*)?/i, "")
    .replace(/^(him|her|them|it|this|that|priya|the customer)\s+/i, "")
    .replace(/^(the|a|an|our|my|their)\s+/i, "")
    .replace(/^(updated|revised|new|final)\s+/i, "")
    .replace(/[.!]+$/, "")
    // A bare verb/pronoun object can leave nothing but a filler word behind ("now", "please") —
    // that isn't a noun either, so fall back the same as an empty result.
    .replace(/^(now|please|right away|asap|thanks?|ok(ay)?)$/i, "")
    .trim()
    // RFC 5322 caps a header line at 998 octets; keep the whole subject far under that regardless
    // of how long the source instruction's wording was.
    .slice(0, 80)
    .trim();
  const title = noun ? noun[0].toUpperCase() + noun.slice(1) : "Next steps";
  return `${title} for ${company}`;
}

export function formatUsd(amount: string): string {
  const n = parseFloat(amount);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: abs % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // A syntactically valid-looking date (month 13, Feb 30) silently rolls over into a different,
  // equally plausible-looking real date instead of failing — never present that as if it were
  // what was actually asked for. (Extraction already rejects these; this is a last-resort guard.)
  if (date.toISOString().slice(0, 10) !== iso) return iso;
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Strings the email body must contain verbatim for verification to pass. */
export function requiredBodyTokens(facts: FactSet): string[] {
  const tokens: string[] = [];
  const first = factValue(facts, "contact_name")?.split(/\s+/)[0];
  if (first) tokens.push(first);
  const net = netAmount(facts);
  if (net) tokens.push(formatUsd(net));
  const date = factValue(facts, "close_date");
  if (date) tokens.push(formatDate(date));
  const pct = factValue(facts, "discount_pct");
  if (pct && parseFloat(pct) > 0) tokens.push(`${pct}%`);
  return tokens;
}

/** Tokens from a previous version that must NOT survive in a corrected body. */
export function staleBodyTokens(prev: FactSet | undefined, next: FactSet): string[] {
  if (!prev) return [];
  const now = requiredBodyTokens(next);
  // A stale token that is itself a substring of a CURRENT token isn't actually stale in the body —
  // e.g. old "5%" is contained in new "15%", and old "$4,200" would be contained in new "$14,200".
  // Only flag it when it can't be explained away as part of a still-current value.
  return requiredBodyTokens(prev).filter((t) => !now.includes(t) && !now.some((n) => n.includes(t)));
}
