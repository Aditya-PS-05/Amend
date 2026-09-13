import "dotenv/config";
import { GmailMail } from "./adapters/gmail/real.js";
import { HubSpotCrm } from "./adapters/hubspot/real.js";
import { SlackChat, SlackFiles } from "./adapters/slack/real.js";
import { MemoryStore, type Store } from "./db/store.js";
import { PgStore } from "./db/pg-store.js";
import { Engine } from "./engine/engine.js";
import { ClaudeWriter } from "./llm/draft-email.js";
import { ClaudeExtractor } from "./llm/extract.js";
import { ClaudeRouter } from "./llm/route.js";
import { createSlackApp, slackOAuthFromEnv } from "./slack-app/app.js";
import { createSlackWorkspaces } from "./db/slack-installations.js";
import { initTelemetry, shutdownTelemetry, traced } from "./telemetry.js";
import { startViewer } from "./web/viewer.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} (see .env.example and docs/SETUP.md)`);
  return v;
}

const log = (msg: string, data?: unknown) => console.log(`[amend] ${msg}`, data ?? "");

await initTelemetry();

let store: Store;
if (process.env.DATABASE_URL) {
  const pg = new PgStore(process.env.DATABASE_URL);
  await pg.migrate();
  store = pg;
  log("using Postgres ledger");
} else {
  store = new MemoryStore();
  log("DATABASE_URL not set: using in-memory ledger (state is lost on restart)");
}

startViewer({ store, port: Number(process.env.VIEWER_PORT ?? 4000), log });

// Multi-workspace (OAuth install) mode only when SLACK_CLIENT_ID/SECRET/STATE_SECRET are all set.
const oauth = slackOAuthFromEnv();
const workspaces = oauth ? await createSlackWorkspaces(process.env.DATABASE_URL) : undefined;
if (oauth) log(`multi-workspace mode: install at http://localhost:${oauth.port}/slack/install (or your HTTPS tunnel)`);

let engine: Engine;
const handlers: Parameters<typeof createSlackApp>[0]["handlers"] = {
    async onMessage(input) {
      const r = await engine.track(
        traced("amend.slack_message", { "amend.channel": input.channel, "amend.edited": input.edited, "amend.mentioned": input.mentioned }, () => engine.handleSlackMessage(input)),
      );
      if (r) log(`${input.channel}:${input.ts} → ${r.threadKey} v${r.version} ${r.status}: ${r.writes} writes, checks ${r.checks.filter((c) => c.ok).length}/${r.checks.length}${r.email ? `, email ${r.email.state}/${r.email.decision}` : ""}`);
    },
    async onSendApproval(input) {
      log(`send approval ${input.threadKey} by ${input.userId}`);
      const r = await engine.track(engine.approveSend(input));
      log(`send ${r.ok ? "done" : "refused"}: ${r.message}`);
    },
    async onConflictChoice(input) {
      log(`conflict ${input.conflictId} -> ${input.choice} by ${input.userId}`);
      const r = await engine.track(engine.resolveConflict(input));
      log(`v${r.version} ${r.status} after resolution`);
    },
};
const app = oauth && workspaces
  ? createSlackApp({ appToken: env("SLACK_APP_TOKEN"), channelId: process.env.SLACK_CHANNEL_ID || undefined, handlers, oauth: { ...oauth, workspaces } })
  : createSlackApp({ botToken: env("SLACK_BOT_TOKEN"), appToken: env("SLACK_APP_TOKEN"), channelId: process.env.SLACK_CHANNEL_ID || undefined, handlers });

engine = new Engine({
  store,
  crm: new HubSpotCrm({ accessToken: env("HUBSPOT_TOKEN") }),
  mail: new GmailMail({
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    refreshToken: env("GOOGLE_REFRESH_TOKEN"),
    from: process.env.GMAIL_FROM || undefined,
  }),
  chat: new SlackChat(app.client, workspaces ? (channel) => workspaces.botTokenForChannel(channel) : undefined),
  files: new SlackFiles(app.client, workspaces ? (channel) => workspaces.botTokenForChannel(channel) : undefined),
  extractor: new ClaudeExtractor(),
  writer: new ClaudeWriter(),
  router: new ClaudeRouter(),
  log,
});

await app.start();
log("Amend is listening on Slack (Socket Mode)");

let stopping = false;

// Resume anything a previous restart interrupted (idempotent: completed writes are not repeated).
engine
  .track(engine.recover())
  .then((rs) => rs.length && log(`recovered ${rs.length} interrupted run(s): ${rs.map((r) => `${r.threadKey} v${r.version} ${r.status}`).join(", ")}`))
  .catch((e) => log("recovery failed", e));

// Retry failed runs with backoff (quiet until they succeed, need a person, or give up).
setInterval(() => {
  if (!stopping) engine.track(engine.recover()).catch((e) => log("retry sweep failed", e));
}, 15_000).unref();

// Watch HubSpot and Gmail for changes people make outside Slack, and report them in the thread.
const watchMs = Number(process.env.WATCH_INTERVAL_MS ?? 20_000);
if (watchMs > 0) {
  setInterval(() => {
    if (!stopping) engine.track(engine.watchOnce()).then((n) => n && log(`watcher reported ${n} outside change(s)`)).catch((e) => log("watch failed", e));
  }, watchMs).unref();
}

// Finish in-flight runs before exiting so a restart never leaves a half-applied instruction.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log(`${signal}: finishing in-flight work before exit`);
    await app.stop().catch(() => {});
    const drained = await engine.drain(30_000);
    log(drained ? "all runs finished; exiting" : "timed out waiting for runs; they will resume on next start");
    await shutdownTelemetry().catch(() => {});
    await workspaces?.close().catch(() => {});
    process.exit(0);
  });
}
