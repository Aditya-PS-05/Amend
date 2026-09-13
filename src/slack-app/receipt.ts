import type { EmailCard, FieldOutcome, OutcomeKind, RunReport } from "../engine/engine.js";

const ICON: Record<OutcomeKind, string> = {
  created: ":sparkles:",
  updated: ":white_check_mark:",
  deleted: ":wastebasket:",
  compensated: ":repeat:",
  unchanged: ":fast_forward:",
  already_correct: ":ballot_box_with_check:",
  human_edit_preserved: ":shield:",
  human_edit_accepted: ":handshake:",
  conflict: ":warning:",
  failed: ":x:",
  superseded: ":hourglass:",
  held: ":pause_button:",
};

const LABEL: Record<string, string> = { deal: "HubSpot deal", draft: "Gmail draft" };

// Slack Block Kit limits we must respect, or Slack rejects the whole message with `invalid_blocks` —
// silently dropping the receipt on precisely the runs that most need one.
const MRKDWN_MAX = 2900; // section/context text.text (Slack's cap is 3000)
const BUTTON_TEXT_MAX = 75;
const CONFIRM_TEXT_MAX = 300;
const MAX_BLOCKS = 50;
const MAX_CONFLICT_ACTION_BLOCKS = 20; // each conflict is its own actions block; leaves room for the rest
const BUTTON_VALUE_MAX = 2000;

/**
 * A button's `value` must never exceed Slack's limit, and must never be silently truncated — a
 * truncated threadKey/conflictId would resolve to the wrong record. In the (unrealistic in
 * practice) case where the identifiers are too long to fit, no button is safer than a broken one.
 */
function actionValue(payload: Record<string, string>): string | undefined {
  const s = JSON.stringify(payload);
  return s.length <= BUTTON_VALUE_MAX ? s : undefined;
}

/**
 * Escapes Slack mrkdwn's special characters so text that came from a user, HubSpot, or the LLM
 * (company names, quoted instructions, extracted values) can never be interpreted as markup —
 * in particular `<!channel>`, `<@U…>`, `<#C…>` must render as literal text, not fire a mention.
 */
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cap(s: string, max = MRKDWN_MAX): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Caps a list of user-controlled lines to a total render budget, noting how many were omitted. */
function capLines(lines: string[], max = MRKDWN_MAX): string {
  let out = "";
  for (const [i, line] of lines.entries()) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > max - 20) return `${out}\n_…and ${lines.length - i} more_`.trim();
    out = next;
  }
  return out;
}

function line(o: FieldOutcome): string {
  const target = `${LABEL[o.resource]}${o.field === "*" ? "" : ` · \`${o.field}\``}`;
  const before = o.before !== null ? escapeMrkdwn(o.before) : "∅";
  const after = o.after !== null ? escapeMrkdwn(o.after) : "∅ (cleared)";
  const change = o.kind === "updated" && o.before !== o.after ? ` ${before} → *${after}*` : o.after && o.kind !== "unchanged" ? ` *${after}*` : "";
  const because = o.because.length
    ? `\n      _because_ ${o.because
        .map((c) => `${c.key.replace(/_/g, " ")} ${escapeMrkdwn(c.from ?? "∅")} → ${escapeMrkdwn(c.to ?? "∅")}${c.source ? ` ("${escapeMrkdwn(c.source)}")` : ""}`)
        .join("; ")}`
    : "";
  const who = o.changedBy ? ` _(changed by ${escapeMrkdwn(o.changedBy)})_` : "";
  const note = o.note ? `\n      ${escapeMrkdwn(o.note)}` : "";
  return `${ICON[o.kind]} ${target} — ${o.kind.replace(/_/g, " ")}${change}${who}${because}${note}`;
}

export function renderReceipt(r: RunReport): { text: string; blocks: unknown[] } {
  const passed = r.checks.filter((c) => c.ok).length;
  const header =
    r.status === "completed"
      ? `:white_check_mark: Amend v${r.version} — done · verified ${passed}/${r.checks.length}`
      : r.status === "needs_attention"
        ? `:warning: Amend v${r.version} — needs attention · verified ${passed}/${r.checks.length}`
        : r.status === "superseded"
          ? `:hourglass: Amend v${r.version} — superseded by a newer edit`
          : r.status === "clarification"
            ? `:question: Amend v${r.version} — need a clarification`
            : `:x: Amend v${r.version} — failed`;

  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: `*${header}*` } }];

  if (r.version > 1 && r.changedFacts.length) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: cap(`Edit changed: ${r.changedFacts.map((k) => `\`${k}\``).join(", ")}`) }] });
  }

  const acted = r.outcomes.filter((o) => o.kind !== "unchanged");
  const skipped = r.outcomes.length - acted.length;
  if (acted.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: cap(acted.map(line).join("\n")) } });
  if (skipped) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `:fast_forward: ${skipped} field(s) unaffected by this edit — left untouched` }] });

  const conflicts = r.outcomes.filter((x) => x.kind === "conflict" && x.conflictId);
  const shownConflicts = conflicts.slice(0, MAX_CONFLICT_ACTION_BLOCKS);
  for (const o of shownConflicts) {
    const keepValue = actionValue({ threadKey: r.threadKey, conflictId: o.conflictId!, choice: "keep_human" });
    const applyValue = actionValue({ threadKey: r.threadKey, conflictId: o.conflictId!, choice: "apply_new" });
    if (!keepValue || !applyValue) {
      // threadKey/conflictId too long to fit a button value (should not happen with real Slack ids) — never
      // emit a button that could truncate into resolving the wrong conflict.
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `:warning: A conflict on \`${escapeMrkdwn(o.field)}\` needs a decision, but its reference is too long for a button. Resolve it from the ledger viewer.` }] });
      continue;
    }
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: cap(`Keep human edit (${LABEL[o.resource]} ${o.field})`, BUTTON_TEXT_MAX) },
          action_id: "amend_conflict_keep",
          value: keepValue,
        },
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Apply new instruction" },
          action_id: "amend_conflict_apply",
          value: applyValue,
        },
      ],
    });
  }
  if (conflicts.length > shownConflicts.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `…and ${conflicts.length - shownConflicts.length} more conflict(s). Open the thread to resolve them, or open the ledger viewer.` }],
    });
  }

  if (r.rejected.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: cap(`:no_entry: Ignored out-of-scope instructions:\n${capLines(r.rejected.map((x) => `> ${escapeMrkdwn(x)}`))}`) } });
  }
  if (r.clarifications.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: cap(`:question: ${capLines(r.clarifications.map(escapeMrkdwn))}`) } });
  }
  const failedChecks = r.checks.filter((c) => !c.ok);
  if (failedChecks.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: cap(`:mag: Failed checks:\n${capLines(failedChecks.map((c) => `• ${escapeMrkdwn(c.name)}${c.detail ? ` (${escapeMrkdwn(c.detail)})` : ""}`))}`) },
    });
  }
  if (r.notes.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: cap(r.notes.map(escapeMrkdwn).join(" · ")) }] });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${r.writes} external write(s)` }] });

  // Last resort: Slack rejects the whole message past 50 blocks. Truncate rather than lose the receipt.
  const finalBlocks = blocks.length > MAX_BLOCKS ? [...blocks.slice(0, MAX_BLOCKS - 1), { type: "context", elements: [{ type: "mrkdwn", text: "…output truncated; see the ledger viewer for the full receipt." }] }] : blocks;

  return { text: header, blocks: finalBlocks };
}

const CARD_TITLE: Record<EmailCard["state"], string> = {
  drafted: ":email: Email drafted",
  updated: ":pencil2: Email updated",
  correction_drafted: ":repeat: Correction drafted",
  sent: ":outbox_tray: Email sent",
};

/** User-facing card: what the email says, why Amend did or didn't send it, and a Send button when it's the user's call. */
export function renderEmailCard(threadKey: string, e: EmailCard): { text: string; blocks: unknown[] } {
  const who = e.requestedBy ? `<@${e.requestedBy}> ` : "";
  const title = e.decision === "blocked" ? ":raised_hand: Email ready, send on hold" : CARD_TITLE[e.state];
  const to = escapeMrkdwn(e.to);
  const subject = escapeMrkdwn(e.subject);
  const files = e.attachments?.length ? `\n*Attachments:* ${escapeMrkdwn(e.attachments.join(", "))}` : "";
  const preview = e.body.length > 700 ? `${e.body.slice(0, 700)}…` : e.body;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: cap(`${who}*${title}*\n*To:* ${to}\n*Subject:* ${subject}${files}`) } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: cap(
          preview
            .split("\n")
            .map((l) => `> ${escapeMrkdwn(l)}`)
            .join("\n"),
        ),
      },
    },
    { type: "context", elements: [{ type: "mrkdwn", text: cap(escapeMrkdwn(e.reason)) }] },
  ];
  if (e.decision !== "auto_sent") {
    const sendValue = actionValue({ threadKey, draftId: e.draftId, bodyToken: e.bodyToken });
    const openGmail = { type: "button", action_id: "amend_open_gmail", text: { type: "plain_text", text: "Open in Gmail" }, url: "https://mail.google.com/mail/u/0/#drafts" };
    if (!sendValue) {
      // Same rule as the conflict buttons: never emit a Send button that could resolve to the wrong draft.
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: ":warning: This email's reference is too long for a Send button — send it from Gmail directly." }] });
      blocks.push({ type: "actions", elements: [openGmail] });
    } else {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            action_id: "amend_send",
            text: { type: "plain_text", text: e.state === "correction_drafted" ? "Send correction" : "Send email" },
            value: sendValue,
            confirm: {
              title: { type: "plain_text", text: "Send this email?" },
              text: { type: "mrkdwn", text: cap(`Send "${subject}" to ${to}. This can't be undone.`, CONFIRM_TEXT_MAX) },
              confirm: { type: "plain_text", text: "Send" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
          openGmail,
        ],
      });
    }
  }
  return { text: cap(`${title}: ${e.subject} → ${e.to}`, 150), blocks };
}
