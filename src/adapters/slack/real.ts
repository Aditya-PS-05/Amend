import type { webApi } from "@slack/bolt";
import { MAX_ATTACHMENT_BYTES, TransientError, type ChatAdapter, type FileRef, type FileSource } from "../types.js";

function mapError(err: unknown): never {
  const e = err as { code?: string; data?: { error?: string }; retryAfter?: number; statusCode?: number; message?: string };
  if (e?.code === "slack_webapi_rate_limited_error") {
    throw new TransientError("Slack rate limited", (e.retryAfter ?? 1) * 1000);
  }
  if (e?.code === "slack_webapi_http_error" && (e.statusCode ?? 0) >= 500) {
    throw new TransientError(`Slack HTTP ${e.statusCode}`);
  }
  if (e?.code === "slack_webapi_request_error") {
    throw new TransientError(`Slack request error: ${e.message ?? ""}`);
  }
  if (e?.code === "slack_webapi_platform_error" && /internal_error|fatal_error|service_unavailable|ratelimited/.test(e.data?.error ?? "")) {
    throw new TransientError(`Slack platform error: ${e.data?.error}`);
  }
  throw err;
}

export class SlackChat implements ChatAdapter {
  /**
   * @param tokenForChannel multi-workspace (OAuth) mode only: resolves the bot token of the
   * workspace that owns the channel. Omit it for single-token mode (the client's own token is used).
   */
  constructor(
    private client: webApi.WebClient,
    private tokenForChannel?: (channel: string) => Promise<string | undefined>,
  ) {}

  async postReply(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<{ ts: string }> {
    let token: string | undefined;
    if (this.tokenForChannel) {
      try {
        token = await this.tokenForChannel(channel);
      } catch (err) {
        throw new TransientError(`Slack installation lookup failed: ${(err as Error)?.message ?? err}`);
      }
      if (!token) throw new Error(`amend: no Slack installation known for channel ${channel}`);
    }
    try {
      const res = await this.client.chat.postMessage({
        ...(token ? { token } : {}),
        channel,
        thread_ts: threadTs,
        text,
        ...(blocks ? { blocks: blocks as never } : {}),
      } as webApi.ChatPostMessageArguments);
      return { ts: res.ts ?? "" };
    } catch (err) {
      mapError(err);
    }
  }

  async deleteMessage(channel: string, ts: string): Promise<void> {
    const token = this.tokenForChannel ? await this.tokenForChannel(channel) : undefined;
    try {
      await this.client.chat.delete({ ...(token ? { token } : {}), channel, ts });
    } catch (err) {
      if ((err as { data?: { error?: string } }).data?.error === "message_not_found") return;
      mapError(err);
    }
  }
}

/** Downloads files shared on Slack messages (needs the files:read scope). */
export class SlackFiles implements FileSource {
  constructor(
    private client: webApi.WebClient,
    private tokenForChannel?: (channel: string) => Promise<string | undefined>,
  ) {}

  async download(ref: FileRef, channel: string): Promise<Buffer> {
    const token = this.tokenForChannel ? await this.tokenForChannel(channel) : this.client.token;
    if (!token) throw new Error(`amend: no Slack token to download ${ref.name}`);
    let url: string | undefined;
    try {
      const info = await this.client.files.info({ token, file: ref.id });
      url = info.file?.url_private_download ?? info.file?.url_private;
    } catch (err) {
      const code = (err as { data?: { error?: string } }).data?.error;
      if (code === "file_not_found" || code === "file_deleted") throw new Error(`${ref.name} was deleted from Slack, so it can't be attached`);
      if (code === "missing_scope") throw new Error("Slack app is missing the files:read scope; reinstall it to attach files");
      mapError(err);
    }
    if (!url) throw new Error(`Slack returned no download link for ${ref.name}`);
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      throw new TransientError(`Slack file download failed: ${(err as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500) throw new TransientError(`Slack file download HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Slack file download HTTP ${res.status} for ${ref.name}`);
    // Without a valid token Slack answers 200 with its sign-in page instead of the file.
    if ((res.headers.get("content-type") ?? "").startsWith("text/html") && !ref.mimeType.startsWith("text/html")) {
      throw new Error(`Slack returned a sign-in page instead of ${ref.name}; check the files:read scope`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`${ref.name} is over Gmail's 25 MB limit`);
    return data;
  }
}
