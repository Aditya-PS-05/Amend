# Amend

**Agents do what you said. Amend fixes things when you change your mind.**

A sales lead posts an instruction in Slack. Amend updates the HubSpot deal and prepares a Gmail draft. When the lead **edits the Slack message**, Amend works out which earlier actions are now stale, repairs only those, leaves human edits alone (or asks), never duplicates work, and posts a verified receipt back to the thread.

```
Slack message / message_changed
  → Extract   (Claude: typed facts, each tied to an exact quote)
  → Compile   (code: facts → desired state per field, with dependencies)
  → Diff      (what changed → which fields are affected)
  → Reconcile (base = last write · current = the app now · desired = new instruction)
  → Execute   (ledger entries, idempotency keys, stale-version check before every write, retries)
  → Verify    (re-read every app, check the email body states current facts only)
  → Receipt   (Slack thread: updated · untouched · human edit kept · conflict buttons · checks)
```

The LLM only extracts facts and writes email prose. Every decision about **what to change** is deterministic, testable code.

## Demo (2 minutes)

**[Watch on YouTube](https://youtu.be/gtzLwmcxU6A)** (also in the repo: [docs/demo.mp4](docs/demo.mp4)) — real run, no mocks: a Slack `@Amend` instruction creates the HubSpot deal and sends the Gmail proposal; a thread correction repairs only the stale fields and sends the fix as a reply in the same Gmail thread; then a draft-only update, shown in Slack → Gmail → HubSpot → Lemma traces.

## External apps

Slack (Bolt, Socket Mode) · HubSpot CRM (deals) · Gmail (drafts, send, threaded replies, attachments) · Claude (`claude-opus-5`, fact extraction / routing / email writing) · Neon Postgres (ledger) · Lemma (tracing).

## Reliability testing

- `pnpm test` — 667 adversarial tests (races, retries, crash recovery, human edits, prompt injection, header injection, attachments).
- `pnpm eval` — 60 end-to-end scenarios against fault-injecting fakes of every app; `pnpm eval:pg` runs the same on the real Postgres ledger. Latest: 60/60, duplicates 0, human edits overwritten 0, stale facts 0, self-checks 543/543.
- Every run verifies HubSpot and Gmail after writing and posts the check count in Slack. See [docs/reliability-brief.md](docs/reliability-brief.md).

## Using it in Slack

| You do | Amend does |
|---|---|
| `@Amend Acme Corp is ready, $42k, close Oct 15, contact Priya (priya@acme.com), send the proposal` | Creates the HubSpot deal + Gmail draft, replies in the thread with a verified receipt |
| Edit that message (`$42k` → `$50k`), even if the edit drops the mention | Repairs only what depends on the change |
| Reply in the thread: `@Amend actually add a 10% discount` | Treats the reply as a later, overriding update to the same instruction |
| Post a new message: `@Amend for Acme, sorry it's $50k not $42k` | Recognizes the existing Acme deal (Claude decides: update vs. new deal vs. ask which), updates it instead of creating a duplicate, and keeps following edits to that message |
| Edit your reply | Re-reconciles from the edited reply |
| Click **Keep human edit** / **Apply new instruction** on a conflict | Applies your decision and re-verifies |
| (every draft or update) | Posts an email card in the thread: recipient, subject, preview, why it did or didn't send, and a **Send email** button |
| Say "send the proposal" / "go ahead and email her now" | Sends automatically, but only if every check passed, nothing is in conflict, and the message contained no refused instructions; otherwise holds it, says why, and sends once the blocker clears |
| Say "draft it, I'll review" | Keeps it as a draft |

**Delivery is decided, not hard-coded.** Claude reads the delivery intent from the user's words (quoting them, like every other fact): "send the proposal" or "send the updated proposal" means send, "draft it / I'll review" means draft, silence means ask. Code then gates the irreversible action: the Send button sends exactly the previewed text (refused if the draft changed since), double clicks send once, and a send request is not re-applied on later edits: after sending, edits produce a correction draft that asks first. Set `SLACK_CHANNEL_ID` for a dedicated channel where every top-level message is an instruction without a mention.

## What makes it hard (and what's handled)

| Situation | Behavior |
|---|---|
| Amount edited $42k → $50k | Updates `deal.amount` + regenerates the email body; 6 other fields untouched |
| Discount added | `deal.amount` is derived from `deal_amount` + `discount_pct`, so it recomputes |
| Rep changed a *different* HubSpot field | Kept. Amend only touches fields whose inputs changed |
| Rep changed the *same* field | Conflict → Slack buttons (keep human / apply new). The dependent email change is **held** so apps don't disagree |
| Rep rewrote the Gmail draft | Conflict instead of clobbering their text |
| Email already sent | Never edits history; drafts a **correction as a reply in the same email thread** ("Re: …"), sent on request or by button |
| Deal cancelled | Stage → `closedlost`; unsent draft deleted, or correction drafted if already sent |
| Edit arrives while the previous version is mid-write | Checks version before every write; the old run stops, the new one converges |
| HubSpot 429 / 5xx | Retry with backoff, applied exactly once |
| Deal created but response lost | Looks up by thread key before retrying: no duplicate deal |
| Slack redelivers an event / edit with same text | Event-id and text-hash dedupe: zero writes |
| Someone edits the deal in HubSpot or sends/edits the draft in Gmail | The watcher posts it in the Slack thread within ~20s; a HubSpot value that contradicts the instruction gets **Keep HubSpot value / Restore instruction value** |
| You delete a sentence (e.g. the next step) | The HubSpot field Amend set from it is cleared and the email stops mentioning it |
| HubSpot keeps failing | The run isn't marked done; it retries with backoff (also after a restart) and reports when it succeeds or gives up |
| App restarts or crashes mid-run | Resumes unfinished runs on startup, reuses the draft Gmail already created, still honors a pending send once; shutdown waits for in-flight runs |
| Prompt injection in the message | Out-of-scope instructions are listed as rejected, never executed |
| Extractor "hallucinates" a value | Facts whose quote isn't in the message are dropped |
| Missing company | Asks a question, writes nothing |

## Evaluation

```bash
pnpm eval            # 60 scenarios on fault-injectable fake apps (in-memory ledger)
pnpm eval:pg         # same scenarios on the real Postgres ledger
pnpm eval:extraction # live Claude extraction eval (needs ANTHROPIC_API_KEY)
pnpm test            # unit tests + all scenarios via vitest
```

Latest scenario run (`evals/out/scoreboard.md`):

| Metric | Result |
|---|---|
| Scenarios passed | **60/60** (in-memory and Postgres) |
| Duplicate deals created | 0 |
| Human edits overwritten | 0 |
| Stale facts left in emails | 0 |
| Agent self-verification checks passed | 543/543 |

Scenario categories: happy path, edits (amount, discount, contact, date, typo, successive edits, thread-reply correction, edited reply), human edits (other field, same field ×3, draft body, deleted draft), already-sent (correction, cancel before/after send), faults (429, lost create response, duplicate events), races (edit mid-run, edit between apps), routing (follow-up message updates the existing deal, edited follow-up, other company, explicit separate deal, deleted message, "send the updated proposal"), delivery (ask by default, explicit send, draft only, Send button, stale preview, double click, held by conflict then sent, held by injection, lost send response, Gmail edit after preview, send wish not re-applied), safety (injection, hallucinated fact, missing company).

## Run it

```bash
pnpm install
cp .env.example .env        # fill in (see docs/SETUP.md)
pnpm setup:hubspot          # creates the amend_thread_key deal property
pnpm setup:gmail            # prints GOOGLE_REFRESH_TOKEN
pnpm preflight              # checks every credential + the database, says how to fix failures
pnpm smoke                  # real HubSpot + Gmail (+ Claude): create → edit → conflict → resolve, then cleans up
pnpm start                  # Slack Socket Mode (no public URL needed) + ledger viewer on :4000
```

`DATABASE_URL` accepts a Neon connection string as-is: a `-pooler` host is switched to the direct endpoint (session advisory locks need it) and `channel_binding` is stripped. Without `DATABASE_URL`, an in-memory ledger is used.

No credentials yet? `pnpm viewer:demo` fills the ledger viewer by running real engine scenarios against the fake apps.

## Layout

```
src/core/       facts, compile (dependencies), reconcile — pure logic
src/engine/     pipeline: dedupe, lock, stale-version check, execute, verify
src/adapters/   types + real (Slack, HubSpot, Gmail) + fakes with fault injection
src/llm/        Claude extraction (structured outputs) + email writer with verification
src/db/         Store interface, in-memory store, Postgres store (advisory locks)
src/slack-app/  Bolt app (message + message_changed + conflict buttons), receipt blocks
evals/          scenario harness, scenarios, scoreboard, live extraction eval
docs/           SETUP.md, reliability-brief.md
```

## Stack

TypeScript · Node 22 · `@uselemma/tracing` (optional Lemma traces) · `@anthropic-ai/sdk` (Claude Opus 5, structured outputs, server-side refusal fallback) · Slack Bolt (Socket Mode) · `@hubspot/api-client` (property history for human-edit attribution) · `googleapis` Gmail drafts · Postgres (`postgres`) · vitest
