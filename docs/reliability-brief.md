# Amend: system and reliability brief

## 1. Problem

Multi-app agents treat an instruction as a one-shot command. Real instructions change: a Slack message gets edited from "$42k" to "$50k, 10% discount" after the agent already updated the CRM and drafted an email. Rerunning the agent duplicates records, overwrites edits reps made in the meantime, and leaves stale numbers in customer emails. Nothing reports these as errors; they are silent failures.

## 2. System design

**Split of responsibility.** Claude does two narrow jobs: extract typed facts (each with a verbatim quote from the message), and write email prose. Everything that decides *what to change* is deterministic code:

1. **Compile.** Facts become a desired value for every managed field, and each field records the facts it depends on (`deal.amount ← deal_amount, discount_pct`; `draft.body ← 7 facts`).
2. **Reconcile.** Each field is compared three ways: `base` (what Amend last wrote, from the ledger), `current` (read from the app now), and `desired` (from the new instruction).
   - `current == base`, spec changed → apply
   - `current != base`, spec unchanged → preserve the human edit
   - both changed → conflict; ask in Slack, and hold dependent writes in other apps
   - `current == desired` → no-op
3. **Execute.** Every write is preceded by a `pending` ledger entry with an idempotency key, and a check that this run's instruction version is still the latest. It's wrapped in retry-with-backoff for 429/5xx. Creates look up by thread key before each attempt.
4. **Verify.** Every app is re-read after writing. The email body must contain the current facts verbatim (e.g. `$37,800`, `November 3, 2026`) and must not contain facts from the previous version. If generated prose fails verification, a deterministic template is used instead.
5. **Receipt.** A Slack thread reply shows what was updated, what was left untouched, which human edits were kept, any conflicts (with buttons), and the self-check results.

**Concurrency.** A per-thread Postgres advisory lock serializes runs. Version appends use a *separate* lock namespace, so an edit arriving mid-run registers immediately and the in-flight run stops at its next write.

**Irreversible actions: model decides intent, code gates the send.** Claude extracts a `delivery` fact (`send` / `draft` / absent) with a verbatim quote, ("send the proposal" → send, "draft it / I'll review" → draft, silence → ask). Amend auto-sends only when that wish is new in this version and the run completed, no conflict is open, no dependent change is held, and no instruction was refused. Otherwise it posts an email card with a Send button and the reason. A blocked send request is remembered and executed once the blocker clears. The Send button re-validates against the latest state and refuses if the draft changed since the preview. Sends are idempotent (ledger key + Sent-folder lookup before each attempt). Once an email is sent it is never edited; later changes produce a correction drafted as a reply in the same Gmail conversation (same threadId, In-Reply-To/References set, "Re:" subject), verified live against Gmail.

## 3. How we know it works

**Scenario suite (deterministic, `pnpm eval`).** 60 scenarios run against fake HubSpot and Gmail adapters that support fault injection (rate limits, lost responses) and simulated human actions (CRM edits with attribution, draft rewrites, sends, deletes). Each scenario asserts final app state, write counts, duplicates, conflicts, and that the agent's own verification passed. The same suite runs on the in-memory ledger and on real Postgres.

| Metric | Result |
|---|---|
| Scenarios passed | 60/60 |
| Duplicate deals | 0 |
| Human edits overwritten | 0 |
| Stale facts left in emails | 0 |
| Self-verification checks | 543/543 |
| Unnecessary writes on a no-fact-change edit | 0 |

Two real bugs were caught by this suite during the build: verification expected Amend's value after a human edit had been accepted, and a too-coarse idempotency key blocked a legitimate draft re-creation.

**Extraction eval (live, `pnpm eval:extraction`).** 12 messages covering relative dates, shorthand amounts, cancellation, two prompt injections, invented facts, and an ambiguous amount. Scores field precision/recall, invented facts, injections flagged, and whether ambiguity is raised instead of guessed.

| Metric (claude-opus-5, 12 messages + 4 routing cases) | Result |
|---|---|
| Field precision | 100% |
| Field recall | 100% |
| Invented facts | 0 |
| Prompt injections flagged | 2/2 |
| Ambiguity raised instead of guessing | 1/1 |
| Delivery intent (imperative send, explicit send, review-first, changed in a later update) | 4/4 |
| Follow-up routing (correction → existing deal, separate deal → new, ambiguous → ask, by contact name) | 4/4 |

Small set: this shows the extraction contract holds on representative and adversarial inputs, not a broad accuracy estimate.

**Live run (`pnpm smoke`).** Against real HubSpot, Gmail, Claude, and the Neon Postgres ledger: create (10/10 checks) → edit amount + discount (2 writes, 6 fields untouched, 10/10) → duplicate delivery ignored → out-of-band HubSpot change + new amount raises a conflict with the email change held (0 writes, 8/8) → resolve "apply new" (10/10). The Slack flow runs on the same engine via Socket Mode.

## 4. Failure modes and guards

| Failure | Guard |
|---|---|
| LLM invents a value | Quote must appear in the message; invalid values dropped; facts are typed/normalized |
| Prompt injection | Extraction schema has no action fields; out-of-scope requests are only listed as rejected |
| Email prose states wrong numbers | Verbatim fact tokens required, stale tokens forbidden, template fallback |
| Duplicate Slack delivery | Event-id dedupe + text-hash dedupe |
| Follow-up posted as a new message creates a duplicate deal | Deterministic prefilter (company/contact named) + Claude router (update / new / ask); routed messages are linked so their edits follow |
| Sending the wrong email | Send only on explicit intent + passing gates; button sends exactly the previewed body; stale previews and double clicks refused |
| Retry after committed create | Lookup by `amend_thread_key` before each attempt |
| Edit during execution | Stale-version check before each write; superseded run stops |
| Human and agent both change a field | Three-way merge; conflict with explicit choice; dependent writes held |
| Partial failure | Ledger `pending → applied / failed / superseded`; next run reconciles from observed state |
| Failed writes (retries exhausted) | Run is not marked complete; retried with backoff (20s×2ⁿ, 5 attempts) by a sweep and after restart; quiet until it succeeds, needs a person, or gives up |
| Recovery adopting someone else's draft | Drafts carry an `X-Amend-Op` header tied to the operation; recovery reuses only a draft with that exact id, never one matched by recipient/subject |
| Crash between recording a create and saving the thread | The applied ledger entry holds the draft id; the next run restores the link and finishes bookkeeping |
| Stale conflict decision overwriting a newer human edit | Decisions bind to the exact human value they resolved; a different later edit is asked about again |
| Fact removed from the message | Fields Amend wrote whose facts disappear are cleared (never fields Amend didn't manage) |
| Company renamed after sending | Correction starts a new email with the new subject instead of replying under the old name |
| Changes made directly in HubSpot/Gmail | Watcher reports them in the Slack thread: field conflicts get Keep/Restore buttons; Gmail sends, edits, deletions are recorded |
| Process restart or crash mid-run | Each thread records its last completed version; on startup unfinished runs resume (idempotent), interrupted draft creates are adopted via a Gmail draft lookup, unfulfilled send requests are still honored once; SIGTERM drains in-flight runs before exit |

## 5. Known limitations

- **Multi-workspace Slack install** is implemented with Bolt's OAuth installer (installs and the channel-to-workspace map are stored in Postgres, and switched on by env vars) but has not been exercised end to end: Slack requires an HTTPS redirect URL (a tunnel). Single-workspace mode is what the demo runs.
- **Change detection is a change feed, not webhooks.** HubSpot is queried for Amend's deals modified since the last pass; Gmail drafts are re-read each pass (default every 20s). Real webhooks or Gmail push need a public endpoint, which Socket Mode deliberately avoids.
- **Lemma tracing** uses the official `@uselemma/tracing` SDK around every Claude call and each Slack message, but ingestion was not verified without a Lemma project key.
- **Tenancy:** HubSpot and Gmail are one account each; a multi-workspace deployment would also need per-tenant HubSpot/Google OAuth.
- The live extraction/routing eval is small (16 cases); it shows the contract holds on representative and adversarial inputs, not a broad accuracy estimate.

## 6. Path to production

OAuth installs for multiple workspaces, HubSpot webhooks and Gmail push instead of reads on each run, Temporal for durable execution, a web view of each thread's ledger, PII redaction in traces, and OpenTelemetry export to an agent-monitoring tool.
