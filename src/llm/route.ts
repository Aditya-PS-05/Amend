import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { anthropicUsage, traced } from "../telemetry.js";

/** An existing tracked deal that a new top-level message might be about. */
export interface RouteCandidate {
  threadKey: string;
  company: string;
  contact?: string;
  amount?: string;
  instruction: string;
}

export type RouteDecision =
  | { kind: "existing"; threadKey: string; reason: string }
  | { kind: "new"; reason: string }
  | { kind: "unclear"; reason: string };

export interface Router {
  route(message: string, candidates: RouteCandidate[]): Promise<RouteDecision>;
}

const STOP = new Set(["corp", "corporation", "inc", "llc", "ltd", "co", "company", "the", "group", "labs", "industries", "enterprises", "technologies", "tech"]);
// Pure legal-suffix/article noise — never load-bearing even when it's all that's left of a name.
// ("group"/"labs"/etc. above ARE still meaningful in that fallback: "The Group Inc" -> "group".)
const PURE_NOISE = new Set(["corp", "corporation", "inc", "llc", "ltd", "co", "company", "the"]);

/**
 * Tokenizes on whitespace/punctuation, keeping "." and "@" so email-like tokens ("acme.com",
 * "priya@acme.com") stay intact for whole-token/domain matching — but also adds every token's
 * finer sub-parts (splitting further on '.'/'@') so "Acme." (trailing sentence punctuation) and
 * "acme.com" (a domain) both still match a plain company token like "acme".
 */
function words(s: string): Set<string> {
  // Strip diacritics first so "Zoë Labs" and a plain-ASCII "Zoe Labs" spelling tokenize the same
  // way, instead of the accented letter silently becoming a token boundary ("zoë" -> "zo").
  const normalized = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const coarse = normalized.toLowerCase().split(/[^a-z0-9@.]+/).filter(Boolean);
  const out = new Set(coarse);
  for (const t of coarse) for (const p of t.split(/[.@]+/)) if (p) out.add(p);
  return out;
}

/**
 * A company's distinguishing tokens: any token long enough and not a generic corporate suffix.
 * When a name is made ENTIRELY of short/generic tokens ("HP", "3M"), or entirely of tokens that
 * are only non-distinguishing WHEN PAIRED with a real word ("The Group Inc"), there is no single
 * token that would be safe to match on its own merit — but the name still needs to recognize
 * itself and near-mentions of itself. Fall back in two steps: drop only pure legal-suffix/article
 * noise first (keeps "group" from "The Group Inc"); only if that leaves nothing, use every token.
 */
function companyKeys(company: string): string[] {
  const all = [...words(company)];
  const distinguishing = all.filter((t) => t.length >= 3 && !STOP.has(t));
  if (distinguishing.length) return distinguishing;
  const lessNoisy = all.filter((t) => !PURE_NOISE.has(t));
  return lessNoisy.length ? lessNoisy : all;
}

function matches(tokens: string[], target: Set<string>): boolean {
  return tokens.some((t) => target.has(t));
}

/** Cheap deterministic prefilter: only deals whose company or contact is named are offered to the router. */
export function mentionsCandidate(message: string, c: Pick<RouteCandidate, "company" | "contact">): boolean {
  const w = words(message);
  if (matches(companyKeys(c.company), w)) return true;
  if (!c.contact) return false;
  // Word-boundary token matching only — a raw substring check would match "Sam" inside "same".
  return [...words(c.contact)].some((p) => p.length >= 3 && w.has(p));
}

/** "Acme" matches "Acme Corp"; "Amicoo Inc" matches "amicoo"; a company always matches itself. */
export function sameCompany(a: string, b: string): boolean {
  return matches(companyKeys(a), words(b));
}

/** Deterministic router for evals and as an offline fallback. */
export class HeuristicRouter implements Router {
  async route(message: string, candidates: RouteCandidate[]): Promise<RouteDecision> {
    if (/\b(new|another|second|separate)\s+(deal|opportunity)\b/i.test(message)) return { kind: "new", reason: "message asks for a new deal" };
    if (candidates.length === 0) return { kind: "new", reason: "no existing deals to fold into" };
    // A single candidate being offered isn't proof the message is about it — the caller may pass
    // a handful of "most recent" deals as a fallback when nothing distinctly matched.
    if (candidates.length === 1) {
      const c = candidates[0];
      if (mentionsCandidate(message, c)) return { kind: "existing", threadKey: c.threadKey, reason: `mentions ${c.company}` };
      // No positive match. Still fold a company-less correction ("sorry, it's $50k not $42k") into
      // the only tracked deal — that's the common case. But a message naming a different email's
      // domain (a real third party) reads as its own opportunity, not a correction to this one.
      const otherDomain = message.match(/[\w.+-]+@([\w-]+)\.[a-z]{2,}/i)?.[1];
      const namesOther = !!otherDomain && !sameCompany(otherDomain, c.company) && !c.contact?.toLowerCase().includes(otherDomain.toLowerCase());
      if (!namesOther) return { kind: "existing", threadKey: c.threadKey, reason: `no unrelated company named; assuming it continues ${c.company}` };
      return { kind: "new", reason: `mentions an unrelated contact, not ${c.company}` };
    }
    return { kind: "unclear", reason: "more than one matching deal" };
  }
}

const RouteSchema = z.object({
  decision: z.enum(["update_existing", "new_deal", "unclear"]),
  deal_number: z.number().int(),
  reason: z.string(),
});

export class ClaudeRouter implements Router {
  constructor(
    private client = new Anthropic(),
    private model = process.env.AMEND_MODEL ?? "claude-opus-5",
  ) {}

  async route(message: string, candidates: RouteCandidate[]): Promise<RouteDecision> {
    const list = candidates
      .map((c, i) => `Deal ${i + 1} (most recent first): company=${c.company}; contact=${c.contact ?? "?"}; amount=${c.amount ?? "?"}\n  latest instruction: ${c.instruction.slice(0, 400)}`)
      .join("\n");
    const system =
      "A sales lead posted a new Slack message to an agent that manages HubSpot deals and customer emails. Decide whether the message corrects or continues one of the existing deals listed, or starts a genuinely new deal. Corrections like 'sorry, it's $50k not $42k', 'for Acme, change the date', or 'send the updated proposal' update an existing deal; a message that names no company is usually a follow-up to the deal whose details it references (e.g. the old amount it corrects). Only choose new_deal when the message clearly describes a separate opportunity. Use unclear when it could refer to more than one listed deal. deal_number is 1-based, or 0 when not update_existing.";
    const messages = [{ role: "user" as const, content: `<existing_deals>\n${list}\n</existing_deals>\n\n<new_message>\n${message}\n</new_message>` }];
    const response = await traced(
      "llm.route",
      { "gen_ai.system": "anthropic", "gen_ai.operation.name": "chat", "gen_ai.request.model": this.model, "amend.step": "route", "amend.route_candidates": candidates.length },
      async (span) => {
        span.setInput([{ role: "system", content: system }, ...messages]);
        const res = await this.client.beta.messages.parse({
          model: this.model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low", format: betaZodOutputFormat(RouteSchema) },
          system,
          messages,
        });
        span.setUsage(anthropicUsage(res.usage));
        span.setAttributes({ "gen_ai.response.model": res.model, stop_reason: res.stop_reason ?? undefined, "gen_ai.response.finish_reasons": res.stop_reason ?? undefined });
        span.setOutput(res.parsed_output ?? null);
        return res;
      },
    );
    const out = response.parsed_output;
    if (response.stop_reason === "refusal" || !out) return { kind: "unclear", reason: "could not classify the message" };
    if (out.decision === "new_deal") return { kind: "new", reason: out.reason };
    const c = candidates[out.deal_number - 1];
    if (out.decision === "update_existing" && c) return { kind: "existing", threadKey: c.threadKey, reason: out.reason };
    return { kind: "unclear", reason: out.reason };
  }
}
