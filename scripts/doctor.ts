/**
 * Checks every credential independently and prints how to fix what's broken.
 *   pnpm preflight
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { webApi } from "@slack/bolt";
import { Client as HubSpot } from "@hubspot/api-client";
import { google } from "googleapis";
import { PgStore } from "../src/db/pg-store.js";
import { THREAD_KEY_PROPERTY } from "../src/adapters/hubspot/real.js";

type Result = { name: string; ok: boolean; detail: string; fix?: string };
const results: Result[] = [];
const env = (k: string) => process.env[k]?.trim() || undefined;

async function check(name: string, fn: () => Promise<string>, fix: string) {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (e) {
    const err = e as { message?: string; data?: { error?: string }; code?: unknown; body?: { message?: string } };
    results.push({ name, ok: false, detail: err.data?.error ?? err.body?.message ?? err.message ?? String(e), fix });
  }
}

function need(...keys: string[]) {
  const missing = keys.filter((k) => !env(k));
  if (missing.length) throw new Error(`missing ${missing.join(", ")} in .env`);
}

await check(
  "Anthropic API",
  async () => {
    const model = env("AMEND_MODEL") ?? "claude-opus-5";
    const m = await new Anthropic().models.retrieve(model);
    return `${m.id} reachable`;
  },
  "Set ANTHROPIC_API_KEY (console.anthropic.com → API keys) or run `ant auth login`.",
);

await check(
  "Slack bot token",
  async () => {
    need("SLACK_BOT_TOKEN");
    const r = await new webApi.WebClient(env("SLACK_BOT_TOKEN")).auth.test();
    return `bot ${r.user} in workspace ${r.team}`;
  },
  "SLACK_BOT_TOKEN must be the xoxb- token from OAuth & Permissions (reinstall the app after adding scopes).",
);

await check(
  "Slack app token (Socket Mode)",
  async () => {
    need("SLACK_APP_TOKEN");
    await new webApi.WebClient(env("SLACK_APP_TOKEN")).apps.connections.open();
    return "Socket Mode connection allowed";
  },
  "SLACK_APP_TOKEN must be an xapp- token with connections:write, and Socket Mode must be ON.",
);

if (env("SLACK_CHANNEL_ID")) {
  await check(
    "Slack channel",
    async () => {
      const r = await new webApi.WebClient(env("SLACK_BOT_TOKEN")).conversations.info({ channel: env("SLACK_CHANNEL_ID")! });
      if (!r.channel?.is_member) throw new Error(`bot is not a member of #${r.channel?.name}`);
      return `#${r.channel?.name}, bot is a member`;
    },
    "Invite the bot: type `/invite @YourBot` in the channel. Needs channels:read (or groups:read for private) to check.",
  );
}

await check(
  "HubSpot token + deal scopes",
  async () => {
    need("HUBSPOT_TOKEN");
    const client = new HubSpot({ accessToken: env("HUBSPOT_TOKEN") });
    await client.crm.deals.basicApi.getPage(1);
    return "can read deals";
  },
  "HUBSPOT_TOKEN must be a private app token with crm.objects.deals.read/write.",
);

await check(
  `HubSpot property ${THREAD_KEY_PROPERTY}`,
  async () => {
    need("HUBSPOT_TOKEN");
    const client = new HubSpot({ accessToken: env("HUBSPOT_TOKEN") });
    await client.crm.properties.coreApi.getByName("deals", THREAD_KEY_PROPERTY);
    return "exists";
  },
  "Run `pnpm setup:hubspot` (needs crm.schemas.deals.write).",
);

await check(
  "Gmail",
  async () => {
    need("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN");
    const auth = new google.auth.OAuth2(env("GOOGLE_CLIENT_ID"), env("GOOGLE_CLIENT_SECRET"));
    auth.setCredentials({ refresh_token: env("GOOGLE_REFRESH_TOKEN") });
    const gmail = google.gmail({ version: "v1", auth });
    const p = await gmail.users.getProfile({ userId: "me" });
    await gmail.users.drafts.list({ userId: "me", maxResults: 1 });
    return `${p.data.emailAddress}, drafts readable`;
  },
  "Run `pnpm setup:gmail` and paste GOOGLE_REFRESH_TOKEN. Ensure the Gmail API is enabled and you are a test user.",
);

await check(
  "Postgres ledger",
  async () => {
    need("DATABASE_URL");
    const store = new PgStore(env("DATABASE_URL")!);
    try {
      await store.migrate();
      const conn = await store.sql.reserve();
      try {
        const [{ ok }] = await conn`select pg_try_advisory_lock(1, hashtext('amend-doctor')) as ok`;
        if (!ok) throw new Error("could not take an advisory lock");
        await conn`select pg_advisory_unlock(1, hashtext('amend-doctor'))`;
      } finally {
        conn.release();
      }
      const [{ threads }] = await store.sql`select count(*)::int as threads from amend_threads`;
      return `schema ready, advisory locks work, ${threads} thread(s)${store.rewrotePooler ? " (using Neon direct endpoint instead of -pooler)" : ""}`;
    } finally {
      await store.close({ timeout: 2 });
    }
  },
  "Set DATABASE_URL (Neon: copy the connection string; pooled or direct both work).",
);

for (const r of results) {
  console.log(`${r.ok ? "✅" : "❌"} ${r.name.padEnd(34)} ${r.detail}`);
  if (!r.ok && r.fix) console.log(`   ↳ ${r.fix}`);
}
const bad = results.filter((r) => !r.ok).length;
console.log(bad ? `\n${bad} check(s) failing.` : "\nAll good. Run `pnpm smoke` then `pnpm start`.");
process.exit(bad ? 1 : 0);
