import { randomBytes } from "node:crypto";
import { google, type gmail_v1 } from "googleapis";
import { TransientError, type Attachment, type AttachmentMeta, type DraftContent, type DraftSnapshot, type MailAdapter, type SentMessage } from "../types.js";

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function httpStatus(err: unknown): number | undefined {
  // A DOMException (e.g. a fetch AbortError) has a legacy numeric `.code` (AbortError = 20) that is
  // not an HTTP status; reading it as one hides real aborts/timeouts behind an unrelated status check.
  if (err instanceof DOMException) return undefined;
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  if (typeof e?.response?.status === "number") return e.response.status;
  if (typeof e?.status === "number") return e.status;
  if (typeof e?.code === "number" && e.code >= 100 && e.code <= 599) return e.code;
  if (typeof e?.code === "string" && /^\d{3}$/.test(e.code)) return Number(e.code);
  return undefined;
}

export function retryAfterMs(err: unknown): number {
  const headers = (err as { response?: { headers?: unknown } })?.response?.headers as
    | ({ get?: (k: string) => string | null } & Record<string, unknown>)
    | undefined;
  if (!headers) return 0;
  let v: string | undefined;
  if (typeof headers.get === "function") v = headers.get("retry-after") ?? undefined;
  else {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "retry-after");
    v = key ? String(headers[key]) : undefined;
  }
  if (!v) return 0;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : 0;
}

export function mapError(err: unknown, op: string): never {
  const status = httpStatus(err);
  if (status === 429 || (status !== undefined && status >= 500)) {
    throw new TransientError(`Gmail ${op} failed with HTTP ${status}`, retryAfterMs(err));
  }
  // Gmail sometimes signals per-user rate limits as 403 rateLimitExceeded.
  const msg = (err as { message?: string })?.message ?? "";
  if (status === 403 && /rate ?limit/i.test(msg)) {
    throw new TransientError(`Gmail ${op} rate limited: ${msg}`, retryAfterMs(err));
  }
  if (status === undefined) {
    const e = err as { code?: unknown; cause?: { code?: unknown }; name?: string };
    const code = typeof e?.code === "string" ? e.code : typeof e?.cause?.code === "string" ? (e.cause.code as string) : "";
    if (NETWORK_CODES.has(code) || e?.name === "AbortError" || /fetch failed|socket hang up|network|timeout/i.test(msg)) {
      throw new TransientError(`Gmail ${op} network error: ${msg || code}`);
    }
  }
  throw err;
}

export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

export function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeB64url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// RFC 5322 caps a header line at 998 octets. A plain (non-encoded) ASCII value has no fold points
// we can insert without changing what it says, so only values short enough to never approach that
// limit skip encoding; anything longer is RFC 2047 B-encoded (and thus safely chunked) regardless
// of character set — encoded-words may be split anywhere without altering the decoded value.
const SAFE_UNENCODED_HEADER_LEN = 200;

/** RFC 2047 B-encoding, split into encoded-words of <= 75 chars without splitting characters. */
/**
 * @param forceEncode Set when the value originally contained CR/LF/NUL before sanitization: those
 * bytes are gone by now, but the surrounding text they carried in (e.g. "Bcc: ceo@rival.com") must
 * still not appear as plain, header-line-shaped text in the raw message — RFC 2047-encode it
 * regardless of length so the wire bytes never spell out anything header-like.
 */
export function encodeHeader(value: string, forceEncode = false): string {
  // eslint-disable-next-line no-control-regex
  if (!forceEncode && /^[\x20-\x7e]*$/.test(value) && value.length <= SAFE_UNENCODED_HEADER_LEN) return value;
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    const next = chunk + ch;
    // 75 - len("=?UTF-8?B?") - len("?=") = 63 base64 chars => 45 bytes max (multiple of 3 for no padding mid-word)
    if (Buffer.byteLength(next, "utf8") > 45) {
      words.push(chunk);
      chunk = ch;
    } else {
      chunk = next;
    }
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

export function decodeHeader(value: string): string {
  // Remove whitespace between adjacent encoded-words, then decode each.
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
    const cs = /utf-?8/i.test(charset) ? "utf8" : "latin1";
    if (enc.toUpperCase() === "B") return Buffer.from(text, "base64").toString(cs);
    const bytes = text
      .replace(/_/g, " ")
      .replace(/=([0-9A-Fa-f]{2})/g, (_x, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, "latin1").toString(cs);
  });
}

/**
 * Header injection guard: a header value containing CR/LF/NUL could otherwise terminate the header
 * and start a new one (e.g. a poisoned contact_email adding a real Bcc:). No legitimate header value
 * needs these characters, so they are stripped rather than escaped.
 */
function sanitizeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\0]+/g, " ").trim();
}

function b64Lines(data: Buffer): string {
  return data.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

/** Quoted MIME parameter (filename/name), with header-breaking characters removed and non-ASCII RFC 2047-encoded. */
function mimeParam(value: string): string {
  const clean = sanitizeHeaderValue(value).replace(/["\\]/g, "_") || "attachment";
  return /^[\x20-\x7e]*$/.test(clean) ? `"${clean}"` : `"${encodeHeader(clean, true).replace(/\r\n /g, " ")}"`;
}

export function buildRaw(content: DraftContent, from?: string): string {
  return b64url(Buffer.from(buildMime(content, from), "utf8"));
}

/** The RFC 822 message: plain text, or multipart/mixed when files are attached. */
export function buildMime(content: DraftContent, from?: string): string {
  const bodyB64 = b64Lines(Buffer.from(content.body, "utf8"));
  const to = sanitizeHeaderValue(content.to);
  const opId = content.amendOpId ? sanitizeHeaderValue(content.amendOpId) : undefined;
  const rfcMessageId = content.inReplyTo?.rfcMessageId ? sanitizeHeaderValue(content.inReplyTo.rfcMessageId) : undefined;
  const lines = [
    ...(from ? [`From: ${sanitizeHeaderValue(from)}`] : []),
    `To: ${to}`,
    `Subject: ${encodeHeader(sanitizeHeaderValue(content.subject), /[\r\n\0]/.test(content.subject))}`,
    ...(opId ? [`X-Amend-Op: ${opId}`] : []),
    ...(rfcMessageId ? [`In-Reply-To: ${rfcMessageId}`, `References: ${rfcMessageId}`] : []),
    "MIME-Version: 1.0",
  ];
  const files = (content.attachments ?? []).filter((a): a is Attachment & { data: Buffer } => !!a.data);
  if (!files.length) {
    lines.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", bodyB64);
    return lines.join("\r\n");
  }
  const boundary = `amend_${randomBytes(12).toString("hex")}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", bodyB64);
  for (const f of files) {
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(f.mimeType) ? f.mimeType : "application/octet-stream";
    lines.push(
      `--${boundary}`,
      `Content-Type: ${mime}; name=${mimeParam(f.name)}`,
      `Content-Disposition: attachment; filename=${mimeParam(f.name)}`,
      "Content-Transfer-Encoding: base64",
      "",
      b64Lines(f.data),
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

/** File parts of a Gmail message (anything with a filename), with the id needed to download them. */
export function attachmentParts(part: gmail_v1.Schema$MessagePart | undefined): Array<AttachmentMeta & { attachmentId?: string; inline?: string }> {
  if (!part) return [];
  const own = part.filename ? [{ name: part.filename, mimeType: part.mimeType ?? "application/octet-stream", size: part.body?.size ?? 0, ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}), ...(part.body?.data ? { inline: part.body.data } : {}) }] : [];
  return [...own, ...(part.parts ?? []).flatMap(attachmentParts)];
}

export function findTextPlain(part: gmail_v1.Schema$MessagePart | undefined): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;
  // A text/plain part with a filename is an attached .txt file, not the email body.
  if ((part.mimeType ?? "").toLowerCase().startsWith("text/plain") && part.body?.data && !part.filename) return part;
  for (const p of part.parts ?? []) {
    const hit = findTextPlain(p);
    if (hit) return hit;
  }
  return undefined;
}

export class GmailMail implements MailAdapter {
  private gmail: gmail_v1.Gmail;
  private from?: string;

  constructor(opts: { clientId: string; clientSecret: string; refreshToken: string; from?: string }) {
    const auth = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
    auth.setCredentials({ refresh_token: opts.refreshToken });
    this.gmail = google.gmail({ version: "v1", auth });
    this.from = opts.from;
  }

  private snapshot(id: string, content: DraftContent): DraftSnapshot {
    return {
      id,
      to: content.to,
      subject: content.subject,
      body: normalizeBody(content.body),
      ...(content.attachments?.length ? { attachments: content.attachments.map(({ name, mimeType, size }) => ({ name, mimeType, size })) } : {}),
    };
  }

  /** Small plain messages go inline as `raw`; messages with files use the upload endpoint (up to 35 MB). */
  private messageRequest(content: DraftContent) {
    const threadId = content.inReplyTo?.threadId ? { threadId: content.inReplyTo.threadId } : {};
    if (!content.attachments?.length) return { requestBody: { message: { raw: buildRaw(content, this.from), ...threadId } } };
    return { requestBody: { message: threadId }, media: { mimeType: "message/rfc822", body: buildMime(content, this.from) } };
  }

  async createDraft(content: DraftContent): Promise<DraftSnapshot> {
    try {
      const req = this.messageRequest(content);
      const res = await this.gmail.users.drafts.create({ userId: "me", ...req });
      return { ...this.snapshot(res.data.id!, content), threadId: res.data.message?.threadId ?? content.inReplyTo?.threadId };
    } catch (err) {
      mapError(err, "createDraft");
    }
  }

  async getDraft(id: string): Promise<DraftSnapshot | null> {
    let res;
    try {
      res = await this.gmail.users.drafts.get({ userId: "me", id, format: "full" });
    } catch (err) {
      if (httpStatus(err) === 404) return null;
      mapError(err, "getDraft");
    }
    const payload = res.data.message?.payload;
    const headers = payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
    const part = findTextPlain(payload) ?? (payload?.body?.data ? payload : undefined);
    const body = part?.body?.data ? decodeB64url(part.body.data) : "";
    const inReplyTo = header("In-Reply-To");
    const amendOpId = header("X-Amend-Op");
    const threadId = res.data.message?.threadId ?? undefined;
    const files = attachmentParts(payload).map(({ name, mimeType, size }) => ({ name, mimeType, size }));
    return {
      ...(files.length ? { attachments: files } : {}),
      id: res.data.id ?? id,
      to: decodeHeader(header("To")),
      subject: decodeHeader(header("Subject")),
      body: normalizeBody(body),
      ...(threadId ? { threadId } : {}),
      ...(amendOpId ? { amendOpId } : {}),
      ...(inReplyTo ? { inReplyTo: { threadId, rfcMessageId: inReplyTo } } : {}),
    };
  }

  /** Downloads the files already on a draft, so an update that doesn't touch attachments keeps them. */
  private async existingAttachments(id: string): Promise<Attachment[]> {
    let res;
    try {
      res = await this.gmail.users.drafts.get({ userId: "me", id, format: "full" });
    } catch (err) {
      mapError(err, "updateDraft");
    }
    const messageId = res.data.message?.id;
    const out: Attachment[] = [];
    for (const p of attachmentParts(res.data.message?.payload)) {
      let data = p.inline;
      if (!data && p.attachmentId && messageId) {
        try {
          data = (await this.gmail.users.messages.attachments.get({ userId: "me", messageId, id: p.attachmentId })).data.data ?? undefined;
        } catch (err) {
          mapError(err, "updateDraft");
        }
      }
      if (data) out.push({ name: p.name, mimeType: p.mimeType, size: p.size, data: Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64") });
    }
    return out;
  }

  async updateDraft(id: string, content: DraftContent): Promise<DraftSnapshot> {
    if (content.attachments === undefined) content = { ...content, attachments: await this.existingAttachments(id) };
    try {
      const req = this.messageRequest(content);
      const res = await this.gmail.users.drafts.update({ userId: "me", id, ...req, requestBody: { id, ...req.requestBody } });
      return { ...this.snapshot(res.data.id ?? id, content), threadId: res.data.message?.threadId ?? content.inReplyTo?.threadId };
    } catch (err) {
      mapError(err, "updateDraft");
    }
  }

  async findDraft(query: { to: string; subject: string; opId: string }): Promise<DraftSnapshot | null> {
    let res;
    try {
      res = await this.gmail.users.drafts.list({ userId: "me", q: `to:${query.to} subject:"${query.subject.replace(/"/g, "")}"`, maxResults: 10 });
    } catch (err) {
      mapError(err, "findDraft");
    }
    for (const d of res.data.drafts ?? []) {
      const snap = d.id ? await this.getDraft(d.id) : null;
      // Recipient and subject only narrow the search; the operation id proves the draft is ours.
      if (snap && snap.amendOpId === query.opId) return snap;
    }
    return null;
  }

  async sendDraft(id: string): Promise<SentMessage> {
    let res;
    try {
      res = await this.gmail.users.drafts.send({ userId: "me", requestBody: { id } });
    } catch (err) {
      mapError(err, "sendDraft");
    }
    return this.sentMessage(res.data.id!, res.data.threadId ?? undefined);
  }

  /** Reads the Message-ID header so later corrections can reply in the same conversation. */
  private async sentMessage(id: string, threadId?: string): Promise<SentMessage> {
    try {
      const m = await this.gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["Message-ID"] });
      const rfc = m.data.payload?.headers?.find((h) => (h.name ?? "").toLowerCase() === "message-id")?.value ?? undefined;
      return { id, threadId: m.data.threadId ?? threadId, ...(rfc ? { rfcMessageId: rfc } : {}) };
    } catch {
      // The send already happened; missing reply headers must not turn it into a failure.
      return { id, ...(threadId ? { threadId } : {}) };
    }
  }

  async deleteDraft(id: string): Promise<void> {
    try {
      await this.gmail.users.drafts.delete({ userId: "me", id });
    } catch (err) {
      if (httpStatus(err) === 404) return;
      mapError(err, "deleteDraft");
    }
  }

  async findSent(query: { to: string; subject: string; afterMs: number; opId?: string }): Promise<SentMessage | null> {
    const subject = query.subject.replace(/"/g, "");
    // Gmail returns nothing for "after:0", so only filter by time when there is a real timestamp.
    const after = query.afterMs > 0 ? ` after:${Math.floor(query.afterMs / 1000)}` : "";
    const q = `in:sent to:${query.to} subject:"${subject}"${after}`;
    try {
      // Without an opId, to/subject alone can't tell two threads with the same subject apart —
      // take the single best (most recent) guess, as before. With one, check every candidate's own
      // X-Amend-Op header rather than trusting the first hit belongs to this operation.
      const res = await this.gmail.users.messages.list({ userId: "me", q, maxResults: query.opId ? 10 : 1 });
      const hits = res.data.messages ?? [];
      if (!query.opId) return hits[0]?.id ? await this.sentMessage(hits[0].id, hits[0].threadId ?? undefined) : null;
      for (const hit of hits) {
        if (!hit.id) continue;
        const m = await this.gmail.users.messages.get({ userId: "me", id: hit.id, format: "metadata", metadataHeaders: ["X-Amend-Op"] });
        const opId = m.data.payload?.headers?.find((h) => (h.name ?? "").toLowerCase() === "x-amend-op")?.value;
        if (opId === query.opId) return this.sentMessage(hit.id, hit.threadId ?? undefined);
      }
      return null;
    } catch (err) {
      mapError(err, "findSent");
    }
  }
}
