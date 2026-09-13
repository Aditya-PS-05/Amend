import { App, LogLevel } from "@slack/bolt";
import type { FileRef } from "../adapters/types.js";
import type { SlackWorkspaces } from "../db/slack-installations.js";

/** Bot scopes requested at install time in multi-workspace mode (keep in sync with docs/slack-manifest*.yaml). */
export const SLACK_BOT_SCOPES = ["channels:history", "groups:history", "channels:read", "groups:read", "chat:write", "files:read"];

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  /** Local port of Bolt's installer HTTP server (/slack/install, /slack/oauth_redirect). */
  port: number;
  /** Public HTTPS redirect URL, e.g. https://<tunnel>/slack/oauth_redirect. Optional if the app has exactly one redirect URL configured. */
  redirectUri?: string;
}

/**
 * Multi-workspace mode is enabled only when all three OAuth variables are set;
 * otherwise returns undefined and the app keeps using SLACK_BOT_TOKEN.
 */
export function slackOAuthFromEnv(env: NodeJS.ProcessEnv = process.env): SlackOAuthConfig | undefined {
  const { SLACK_CLIENT_ID: clientId, SLACK_CLIENT_SECRET: clientSecret, SLACK_STATE_SECRET: stateSecret } = env;
  if (!clientId || !clientSecret || !stateSecret) return undefined;
  return {
    clientId,
    clientSecret,
    stateSecret,
    port: Number(env.SLACK_INSTALL_PORT || 3000),
    ...(env.SLACK_REDIRECT_URI ? { redirectUri: env.SLACK_REDIRECT_URI } : {}),
  };
}

/** Pulls the channel id out of an event or interaction payload. */
function channelOf(body: unknown): string | undefined {
  const b = body as {
    event?: { channel?: string; item?: { channel?: string } };
    channel?: { id?: string };
    container?: { channel_id?: string };
  };
  return b?.event?.channel ?? b?.event?.item?.channel ?? b?.channel?.id ?? b?.container?.channel_id;
}

export interface SlackHandlers {
  /** Every candidate message; the engine decides which instruction it belongs to. */
  onMessage(input: {
    channel: string;
    ts: string;
    threadTs?: string;
    text: string;
    mentioned: boolean;
    edited: boolean;
    channelMode: boolean;
    userId?: string;
    eventId?: string;
    files?: FileRef[];
  }): Promise<void>;
  onConflictChoice(input: {
    threadKey: string;
    conflictId: string;
    choice: "keep_human" | "apply_new";
    userId: string;
  }): Promise<void>;
  onSendApproval(input: { threadKey: string; draftId: string; bodyToken: string; userId: string }): Promise<void>;
}

const MENTION_PREFIX = /^\s*<@[A-Z0-9]+(?:\|[^>]*)?>[\s:,]*/i;

export interface RawMessage {
  type?: string;
  subtype?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  edited?: { user?: string; ts?: string };
  files?: Array<{ id?: string; name?: string; title?: string; mimetype?: string; size?: number; mode?: string }>;
  message?: RawMessage;
  previous_message?: RawMessage;
}

function isBot(m: RawMessage | undefined): boolean {
  return !!m && (!!m.bot_id || m.subtype === "bot_message");
}

export function isThreadReply(m: RawMessage | undefined): boolean {
  return !!m && !!m.thread_ts && m.thread_ts !== m.ts;
}

/**
 * Which message (if any) a Slack `message` event is really about: the message itself, the new text of an
 * edit, or nothing at all (bots, tombstones, other subtypes, empty text, edits that changed no text).
 */
export function selectMessage(ev: RawMessage): { msg: RawMessage & { ts: string; text: string }; edited: boolean } | null {
  let msg: RawMessage;
  let edited = false;
  if (ev.subtype === undefined || ev.subtype === "thread_broadcast" || ev.subtype === "file_share") {
    msg = ev;
  } else if (ev.subtype === "message_changed") {
    if (!ev.message || ev.message.subtype === "tombstone") return null;
    msg = ev.message;
    if (ev.previous_message && ev.message.text === ev.previous_message.text) return null;
    edited = true;
  } else {
    return null;
  }
  if (isBot(msg) || isBot(ev) || !msg.ts || (!msg.text?.trim() && !messageFiles(msg).length)) return null;
  return { msg: { ...msg, text: msg.text ?? "" } as RawMessage & { ts: string; text: string }, edited };
}

/** Real files on a message (not tombstones of deleted files or external links without content). */
export function messageFiles(m: RawMessage): FileRef[] {
  return (m.files ?? [])
    .filter((f) => f.id && f.mode !== "tombstone" && f.mode !== "external" && typeof f.size === "number")
    .map((f) => ({ id: f.id!, name: f.name || f.title || f.id!, mimeType: f.mimetype || "application/octet-stream", size: f.size! }));
}

/** Removes every mention of the bot (and a leading mention of anyone else) and says whether one was there. */
export function stripMention(text: string, botUserId: string): { mentioned: boolean; text: string } {
  const mention = new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g");
  const mentioned = mention.test(text);
  // MENTION_PREFIX exists precisely to eat the separator after a leading mention ("@Amend: ..." ->
  // "..."), but it only matches when the mention is still there — remove that separator in the same
  // replace as the mention itself, or a colon/comma left over from "@Amend: ..." survives into text.
  const withSeparator = new RegExp(`<@${botUserId}(?:\\|[^>]*)?>[\\s:,]*`, "g");
  return { mentioned, text: text.replace(withSeparator, "").replace(mention, "").replace(MENTION_PREFIX, "").trim() };
}

export function createSlackApp(
  opts: {
    appToken: string;
    channelId?: string;
    handlers: SlackHandlers;
  } & (
    | { botToken: string; oauth?: undefined }
    | { botToken?: undefined; oauth: SlackOAuthConfig & { workspaces: SlackWorkspaces } }
  ),
): App {
  const oauth = opts.oauth;
  const app = oauth
    ? new App({
        appToken: opts.appToken,
        socketMode: true,
        logLevel: LogLevel.INFO,
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        stateSecret: oauth.stateSecret,
        scopes: SLACK_BOT_SCOPES,
        installationStore: oauth.workspaces,
        ...(oauth.redirectUri ? { redirectUri: oauth.redirectUri } : {}),
        installerOptions: {
          port: oauth.port,
          installPath: "/slack/install",
          redirectUriPath: "/slack/oauth_redirect",
          directInstall: true,
        },
      })
    : new App({
        token: opts.botToken,
        appToken: opts.appToken,
        socketMode: true,
        logLevel: LogLevel.INFO,
      });

  let botUserId: string | undefined;
  const getBotUserId = async () => (botUserId ??= (await app.client.auth.test()).user_id as string);

  if (oauth) {
    // Remember which workspace owns each channel so SlackChat can pick the right bot token later.
    app.use(async ({ body, context, next, logger }) => {
      const channel = channelOf(body);
      if (channel && (context.teamId || context.enterpriseId)) {
        oauth.workspaces
          .rememberChannel(channel, {
            ...(context.teamId ? { teamId: context.teamId } : {}),
            ...(context.enterpriseId ? { enterpriseId: context.enterpriseId } : {}),
          })
          .catch((err) => logger.error("amend: failed to record channel workspace", err));
      }
      await next();
    });

    app.event("app_uninstalled", async ({ context, logger }) => {
      try {
        await oauth.workspaces.deleteInstallation?.({
          teamId: context.teamId,
          enterpriseId: context.enterpriseId,
          isEnterpriseInstall: !!context.isEnterpriseInstall,
        });
        logger.info(`amend: removed installation team=${context.teamId} enterprise=${context.enterpriseId}`);
      } catch (err) {
        logger.error("amend: failed to delete installation", err);
      }
    });
  }

  /**
   * Usage model:
   *  - `@Amend <instruction>` starts a tracked instruction, or updates an existing deal it names.
   *  - `@Amend <correction>` as a thread reply adds an overriding update.
   *  - Editing any tracked message re-runs reconciliation, even if the edit drops the mention.
   */
  app.event("message", async ({ event, body, context, logger }) => {
    const ev = event as unknown as RawMessage;
    const eventId = (body as { event_id?: string })?.event_id;
    try {
      const channel = ev.channel;
      if (!channel) return;
      if (opts.channelId && channel !== opts.channelId) return;

      const selected = selectMessage(ev);
      if (!selected) return;
      const { msg, edited } = selected;

      // OAuth mode: app.client has no token, so use the per-workspace bot user id from authorize.
      const bot = oauth ? context.botUserId! : await getBotUserId();
      const { mentioned, text } = stripMention(msg.text, bot);
      const files = messageFiles(msg);
      if (!text && !files.length) return;

      await opts.handlers.onMessage({
        channel,
        ts: msg.ts,
        ...(isThreadReply(msg) ? { threadTs: msg.thread_ts } : {}),
        text,
        mentioned,
        edited,
        channelMode: !!opts.channelId,
        ...(msg.edited?.user ?? msg.user ? { userId: (msg.edited?.user ?? msg.user)! } : {}),
        ...(eventId ? { eventId } : {}),
        ...(files.length ? { files } : {}),
      });
    } catch (err) {
      logger.error("amend: onMessage failed", err);
    }
  });

  // Matches "amend_conflict" and suffixed ids like "amend_conflict_keep" (action_ids must be unique per block).
  app.action(/^amend_conflict/, async ({ ack, body, action, logger }) => {
    await ack();
    try {
      const value = (action as { value?: string }).value;
      if (!value) return;
      const parsed = JSON.parse(value) as { threadKey: string; conflictId: string; choice: string };
      if (parsed.choice !== "keep_human" && parsed.choice !== "apply_new") {
        logger.warn(`amend: unknown conflict choice ${parsed.choice}`);
        return;
      }
      await opts.handlers.onConflictChoice({
        threadKey: parsed.threadKey,
        conflictId: parsed.conflictId,
        choice: parsed.choice,
        userId: (body as { user?: { id?: string } }).user?.id ?? "",
      });
    } catch (err) {
      logger.error("amend: onConflictChoice failed", err);
    }
  });

  app.action("amend_send", async ({ ack, body, action, logger }) => {
    await ack();
    try {
      const value = JSON.parse((action as { value?: string }).value ?? "{}") as { threadKey: string; draftId: string; bodyToken: string };
      await opts.handlers.onSendApproval({ ...value, userId: (body as { user?: { id?: string } }).user?.id ?? "" });
    } catch (err) {
      logger.error("amend: onSendApproval failed", err);
    }
  });

  // Link button; Slack still sends an action that must be acknowledged.
  app.action("amend_open_gmail", async ({ ack }) => {
    await ack();
  });

  app.error(async (err) => {
    console.error("amend: slack app error", err);
  });

  return app;
}
