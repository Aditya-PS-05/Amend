/**
 * Adapter contracts. Every external app has a real implementation and a fake
 * (in-memory, fault-injectable) implementation used by the eval harness.
 */

export const DEAL_FIELDS = ["dealname", "amount", "closedate", "dealstage", "hs_next_step"] as const;
export type DealField = (typeof DEAL_FIELDS)[number];

export const DRAFT_FIELDS = ["to", "subject", "body", "attachments"] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];

/** Who last changed a field, when the app exposes it (HubSpot property history). */
export interface ChangeSource {
  sourceType: string; // e.g. CRM_UI, INTEGRATION, API
  userId?: string;
  at?: string;
}

export interface DealSnapshot {
  id: string;
  fields: Record<DealField, string | null>;
  lastChangedBy: Partial<Record<DealField, ChangeSource>>;
}

export interface CrmAdapter {
  /** Finds a deal previously created for this thread (idempotent create recovery). */
  findDealByThreadKey(threadKey: string): Promise<DealSnapshot | null>;
  createDeal(threadKey: string, fields: Partial<Record<DealField, string>>): Promise<DealSnapshot>;
  /** Returns null if the deal no longer exists. */
  getDeal(id: string): Promise<DealSnapshot | null>;
  updateDeal(id: string, fields: Partial<Record<DealField, string>>): Promise<void>;
  /** Amend-managed deals modified at or after the given time (change feed without webhooks). */
  findChangedSince(sinceMs: number): Promise<Array<DealSnapshot & { threadKey: string }>>;
}

/** Where a sent email lives, so follow-ups can reply in the same conversation. */
export interface SentMessage {
  id: string;
  threadId?: string;
  /** RFC 822 Message-ID header, used for In-Reply-To/References. */
  rfcMessageId?: string;
}

export interface AttachmentMeta {
  name: string;
  mimeType: string;
  size: number;
}

export interface Attachment extends AttachmentMeta {
  data?: Buffer;
}

/** A file shared on a Slack message; the bytes stay in Slack and are fetched when a draft is written. */
export interface FileRef extends AttachmentMeta {
  id: string;
}

export interface FileSource {
  download(ref: FileRef, channel: string): Promise<Buffer>;
}

/** Gmail's limit for a whole message, attachments included. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface DraftContent {
  to: string;
  subject: string;
  body: string;
  /** Operation that created this draft (X-Amend-Op header); proves ownership during recovery. */
  amendOpId?: string;
  /** Makes the draft a reply in an existing email conversation. */
  inReplyTo?: { threadId?: string; rfcMessageId?: string };
  /** Files carried by the email. On update, omitting this keeps the draft's existing attachments. */
  attachments?: Attachment[];
}

export interface DraftSnapshot extends DraftContent {
  id: string;
  threadId?: string;
}

export interface MailAdapter {
  createDraft(content: DraftContent): Promise<DraftSnapshot>;
  /** Returns null if the draft no longer exists (sent or deleted). */
  getDraft(id: string): Promise<DraftSnapshot | null>;
  updateDraft(id: string, content: DraftContent): Promise<DraftSnapshot>;
  deleteDraft(id: string): Promise<void>;
  /** Finds the draft created by a specific operation (recovers a create whose response or process was lost). */
  findDraft(query: { to: string; subject: string; opId: string }): Promise<DraftSnapshot | null>;
  /** Sends an existing draft. */
  sendDraft(id: string): Promise<SentMessage>;
  /** Looks for a sent message matching a former draft. */
  /**
   * `opId`, when given, must match the sent message's own X-Amend-Op header (the same header
   * `findDraft` matches on) — to/subject alone can collide across two different threads whose
   * subjects happen to match (e.g. two deals for the same company), which would let one thread's
   * "already sent" check silently swallow another thread's send request.
   */
  findSent(query: { to: string; subject: string; afterMs: number; opId?: string }): Promise<SentMessage | null>;
}

export interface ChatAdapter {
  postReply(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<{ ts: string }>;
  /** Removes one of the app's own messages (used for the transient "working on it" indicator). */
  deleteMessage?(channel: string, ts: string): Promise<void>;
}

/** Retryable failure: rate limits, 5xx, timeouts. Anything else is permanent. */
export class TransientError extends Error {
  constructor(
    message: string,
    public retryAfterMs = 0,
  ) {
    super(message);
    this.name = "TransientError";
  }
}
