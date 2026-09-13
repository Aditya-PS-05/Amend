/**
 * Three-way reconciliation of one field:
 *   base    = what Amend last wrote (from the ledger)
 *   current = what the app holds now
 *   desired = what the latest instruction compiles to
 */

export type Resolution = "keep_human" | "apply_new";

export type Decision =
  | { kind: "apply"; reason: "create" | "spec_changed" | "resolved_apply_new" }
  | { kind: "noop_unchanged" }
  | { kind: "noop_already" }
  | { kind: "preserve_human" }
  | { kind: "accept_human" }
  | { kind: "conflict" };

export interface BaseRecord {
  /** Spec token Amend last applied. */
  desiredCmp: string;
  /** Token Amend observed right after its last write (or accepted from a human). */
  observedToken: string | null;
}

/**
 * A ledger entry as read back from the store, for building a `BaseRecord`. A "failed" entry (a
 * read-back mismatch — see isUsableBase in store.ts) has a real, known observedToken but did NOT
 * reach the spec it recorded as `desiredCmp`; treating that desiredCmp as confirmed would make a
 * lasting mismatch look "settled" and stop retrying it forever, once fixed only by luck.
 */
export function reconcileBase(entry: { status: string; desiredCmp: string; observedToken: string | null } | null): BaseRecord | null {
  if (!entry) return null;
  // Sentinel that cannot equal any real spec token, so `specChanged` is always true for a mismatch
  // base — the next run always retries the write rather than accepting the near-miss as done.
  return entry.status === "failed" ? { desiredCmp: "∅unconfirmed", observedToken: entry.observedToken } : entry;
}

export interface ReconcileInput {
  desiredCmp: string;
  /** Expected token after applying desired, if knowable up front. */
  desiredToken?: string | null;
  base: BaseRecord | null;
  currentToken: string | null;
  resolution?: Resolution;
}

export function reconcileField(i: ReconcileInput): Decision {
  const { base, currentToken, desiredCmp, desiredToken, resolution } = i;

  if (!base) {
    if (desiredToken !== undefined && currentToken === desiredToken) return { kind: "noop_already" };
    return { kind: "apply", reason: "create" };
  }

  const humanChanged = currentToken !== base.observedToken;
  const specChanged = desiredCmp !== base.desiredCmp;

  if (!humanChanged) {
    if (specChanged) return { kind: "apply", reason: "spec_changed" };
    // Nothing has moved since the base was recorded. Normally that's a true no-op — but the base
    // may itself be an earlier ACCEPTED human decision that still differs from what's desired
    // (accepting keeps desiredCmp at the current spec while observedToken stays the human value).
    // A caller-scoped resolution for that exact still-current pairing must still be able to flip
    // the outcome — that's what a second, different click on the same settled conflict is.
    if (desiredToken !== undefined && currentToken !== desiredToken) {
      if (resolution === "apply_new") return { kind: "apply", reason: "resolved_apply_new" };
      if (resolution === "keep_human") return { kind: "accept_human" };
    }
    return { kind: "noop_unchanged" };
  }

  // A value that already matches what's desired is settled regardless of any resolution on file —
  // a stale resolution must never "resurrect" a conflict that reality has since resolved itself.
  if (desiredToken !== undefined && currentToken === desiredToken) return { kind: "noop_already" };
  if (resolution === "apply_new") return { kind: "apply", reason: "resolved_apply_new" };
  if (resolution === "keep_human") return { kind: "accept_human" };
  if (!specChanged) return { kind: "preserve_human" };
  return { kind: "conflict" };
}
