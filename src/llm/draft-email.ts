import Anthropic from "@anthropic-ai/sdk";
import { formatDate, formatUsd, netAmount, requiredBodyTokens } from "../core/compile.js";
import { factValue, type FactKey, type FactSet } from "../core/facts.js";
import { anthropicUsage, traced } from "../telemetry.js";

export interface EmailRequest {
  facts: FactSet;
  mode: "new" | "revision" | "correction";
  /** For corrections: facts that changed after the original email was sent. */
  changed?: FactKey[];
  previous?: FactSet;
  /** Names of the files attached to this email. */
  attachments?: string[];
}

export interface EmailWriter {
  write(req: EmailRequest): Promise<string>;
}

/** Deterministic writer: used by evals and as a fallback when verification fails. */
export class TemplateWriter implements EmailWriter {
  async write({ facts, mode, changed = [], previous, attachments = [] }: EmailRequest): Promise<string> {
    const first = factValue(facts, "contact_name")?.split(/\s+/)[0] ?? "there";
    const lines = [`Hi ${first},`, ""];
    if (mode === "correction") {
      lines.push("A quick correction to my earlier email:", "");
      for (const k of changed) {
        const was = previous?.[k]?.value;
        lines.push(`- ${k.replace(/_/g, " ")}: ${was ?? "(none)"} -> ${facts[k]?.value ?? "(removed)"}`);
      }
      lines.push("");
    }
    if (factValue(facts, "cancelled") === "true") {
      lines.push("Please disregard my earlier note; we are pausing this for now. I'll follow up soon.");
    } else {
      const intent = factValue(facts, "email_intent") ?? "follow up on next steps";
      lines.push(`Following up to ${intent} for ${factValue(facts, "company")}.`);
      const net = netAmount(facts);
      const pct = factValue(facts, "discount_pct");
      const discounted = pct !== undefined && parseFloat(pct) > 0;
      if (net) {
        lines.push(discounted ? `The total comes to ${formatUsd(net)}, including a ${pct}% discount.` : `The total comes to ${formatUsd(net)}.`);
      } else if (discounted) {
        lines.push(`This includes a ${pct}% discount.`);
      }
      const date = factValue(facts, "close_date");
      if (date) lines.push(`We're targeting ${formatDate(date)} to finalize.`);
      const next = factValue(facts, "next_step");
      if (next) lines.push(`Next step: ${next}.`);
      if (attachments.length) lines.push(`Attached: ${attachments.join(", ")}.`);
    }
    lines.push("", "Best regards");
    return lines.join("\n");
  }
}

/** Plain-text drafts carry no files, so any wording that promises one misleads the recipient. */
export const CLAIMS_ATTACHMENT = /\b(attach(ed|ing|ment|ments)?|enclosed|see (the )?enclosure)\b/i;

export class ClaudeWriter implements EmailWriter {
  constructor(
    private client = new Anthropic(),
    private model = process.env.AMEND_MODEL ?? "claude-opus-5",
  ) {}

  async write(req: EmailRequest): Promise<string> {
    const required = requiredBodyTokens(req.facts);
    const factLines = Object.values(req.facts).map((f) => `- ${f!.key}: ${f!.value}`);
    const task =
      req.mode === "correction"
        ? `The original email was already sent. Write a short correction email. Changed facts: ${req.changed?.join(", ")}. Previous values: ${req.changed?.map((k) => `${k}=${req.previous?.[k]?.value ?? "none"}`).join(", ")}.`
        : factValue(req.facts, "cancelled") === "true"
          ? "The deal is paused/cancelled. Write a short, polite note."
          : "Write a short customer email for this sales handoff.";
    const system =
      "You write concise, professional B2B sales emails (under 120 words). Output only the plain-text email body: no subject line, no placeholders, no markdown.";
    const files = req.attachments?.length
      ? `These files are attached to the email: ${req.attachments.join(", ")}. Refer to them naturally as attached; do not invent any other attachments.`
      : "The email has no attachments: never say anything is attached, enclosed, or included with the email (e.g. 'I have attached the proposal'); if a document is mentioned, say you will send it separately or share it on request.";
    const messages = [
      {
        role: "user" as const,
        content: `${task}\n\n${files}\n\nFacts:\n${factLines.join("\n")}\n\nThe body must include each of these strings verbatim: ${required.map((t) => JSON.stringify(t)).join(", ")}. Sign off as "Best regards" with no name.`,
      },
    ];
    const response = await traced(
      "llm.draft_email",
      { "gen_ai.system": "anthropic", "gen_ai.operation.name": "chat", "gen_ai.request.model": this.model, "amend.step": "draft_email", "amend.email_mode": req.mode },
      async (span) => {
        span.setInput([{ role: "system", content: system }, ...messages]);
        const res = await this.client.beta.messages.create({
          model: this.model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low" },
          system,
          messages,
        });
        span.setUsage(anthropicUsage(res.usage));
        span.setAttributes({ "gen_ai.response.model": res.model, stop_reason: res.stop_reason ?? undefined, "gen_ai.response.finish_reasons": res.stop_reason ?? undefined });
        span.setOutput(res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
        return res;
      },
    );
    if (response.stop_reason === "refusal") throw new Error("email generation refused");
    // "max_tokens" means the body was cut off mid-sentence — a partial email must never reach a
    // customer. And required-token verification is vacuously true when a fact set needs no
    // verbatim tokens, so an empty body would otherwise slip past it undetected.
    if (response.stop_reason === "max_tokens") throw new Error("email generation was truncated by the token limit");
    const text = response.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
      .trim();
    if (!text) throw new Error("email generation returned an empty body");
    return text;
  }
}
