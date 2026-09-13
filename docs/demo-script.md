# Amend: 2-minute demo script

**Setup before recording:**
- Screen layout: Slack (left), HubSpot deal (top right), Gmail Drafts (bottom right), ledger viewer at `localhost:4000` in a second browser tab.
- A clean `#sales-handoffs` channel with the bot invited.
- `pnpm start` running in a visible terminal.
- Keep the pasted message short so it's readable on video.

**Sending is real.** Replace `priya@acme.com` with an inbox you own (e.g. a second Gmail address) before recording.

**Optional send beat (after the conflict, around 1:20):** click **Send email** on the latest email card → confirm → "📤 Sent to … by @you". Then edit the close date: Amend drafts a *Correction* and asks, rather than silently re-sending. To show autonomous sending instead, end a fresh instruction with "Go ahead and email it to her now."; the card reads "Sent because you said …".

**Pasted message:**
> @Amend Acme Corp is ready to move forward, contract sent. Deal is $42k, close by Oct 15. Contact is Priya Shah (priya@acme.com). Send the proposal. Next step: legal review.

---

### 0:00–0:12 · The problem (voiceover over Slack)
"Agents treat instructions as one-shot commands. But people edit their messages. If an agent already updated the CRM and drafted the email, an edit leaves stale data everywhere. Nothing throws an error."

### 0:12–0:30 · v1: instruction → three apps
- Post the message.
- The receipt appears in the thread: ✨ deal created, ✨ draft created, **all checks verified**.
- Cut to HubSpot: Acme Corp deal, $42,000, Oct 15, contract sent.
- Cut to Gmail: the draft to Priya says $42,000.

"Amend extracts typed facts, each tied to an exact quote, and writes them to HubSpot and Gmail. Then it re-reads both apps to verify."

### 0:30–0:55 · The edit: only what's stale changes
- Reply in the thread: `@Amend actually add a 10% discount` (or edit the original message; both work).
- New receipt: ✅ `deal.amount` 42000 → **37800** *because discount pct ∅ → 10 ("10%")*; ✅ draft body regenerated; ⏭ **6 fields untouched**; 2 writes.
- HubSpot: $37,800. Gmail: the draft now says $37,800 and "10% discount", and the $42,000 is gone.

"Amend knows the amount depends on price and discount, so it repaired exactly two things and touched nothing else."

### 0:55–1:20 · Human edit → conflict, not clobber
- In HubSpot, change amount to $40,000 by hand (the rep negotiated).
- Edit Slack: `$42k` → `$50k`.
- Receipt: ⚠️ **conflict** on `deal.amount` *(changed by CRM_UI · user …)*; ⏸ the email change is **held** so the apps stay consistent; buttons: *Keep human edit / Apply new instruction*.
- Click **Apply new instruction**. Receipt: amount $45,000, email updated, verified.

"HubSpot's property history tells us a person made that change. Amend asks instead of overwriting, and holds the email so the CRM and the customer never disagree."

### 1:20–1:38 · Already sent → correction, never rewrite history
- In Gmail, send the draft.
- Edit Slack: close date `Oct 15` → `Nov 3`.
- Receipt: 🔁 **compensated**. The email was already sent, so there's a *Correction:* draft for a human to review; the deal close date is updated.

### 1:38–1:55 · How we know it works
- Terminal: `pnpm eval` → **60/60 · duplicates 0 · human edits overwritten 0 · stale facts 0 · self-checks 543/543**.
- Viewer `/scoreboard`, scrolled over the categories: races (edit mid-run), 429s, lost create response, duplicate Slack events, prompt injection, hallucinated fact.
- Viewer thread page: version timeline with highlighted edits, ledger entries `pending → applied`, idempotency keys.

"60 end-to-end scenarios and 645 tests run against fault-injecting fakes of every app, on the same Postgres ledger that runs in production. The LLM only extracts facts. Every decision about what to change is deterministic code."

### 1:55–2:00 · Close
"Amend. Agents do what you said; Amend fixes things when you change your mind."

---

## Backup plan if a live API misbehaves while recording
- Run `pnpm viewer:demo` to fill the viewer from real engine runs on fake apps, and narrate over it.
- Show `pnpm eval` output and `evals/out/scoreboard.md`.
- Show `pnpm smoke --keep`, which runs the same create → edit → conflict → resolve flow against real HubSpot and Gmail without Slack.
