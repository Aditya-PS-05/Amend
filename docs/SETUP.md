# Amend credential setup

Start with `cp .env.example .env` and fill values in as you go.

## Slack

1. Go to https://api.slack.com/apps, click **Create New App**, choose **From scratch**, then pick your workspace.
2. **Socket Mode**: turn it on. When asked, create an app-level token with scope `connections:write` and copy the `xapp-...` value into `SLACK_APP_TOKEN`.
3. **OAuth & Permissions > Bot Token Scopes**: add `channels:history`, `groups:history`, `chat:write`, `files:read` (files shared on an @Amend message are attached to the email).
4. **Event Subscriptions**: turn it on. Under **Subscribe to bot events**, add `message.channels` (and `message.groups` for private channels).
5. **Interactivity & Shortcuts**: turn it on. Socket Mode means you don't need a request URL.
6. **Install App**: install it to the workspace and copy the `xoxb-...` Bot User OAuth Token into `SLACK_BOT_TOKEN`.
7. In Slack, run `/invite @YourApp` in the channel you want to use.
8. Optional: copy the channel ID (channel name > About > Channel ID, `C...`) into `SLACK_CHANNEL_ID`. With it set, every top-level message in that channel counts as an instruction. Without it, Amend responds to @Amend mentions in any channel it has been invited to (plus edits and @Amend thread replies on tracked messages).

## HubSpot

1. In HubSpot, open **Settings (gear) > Integrations > Private Apps > Create a private app**. On newer portals this lives under **Development > Legacy apps > Create private app**.
2. On the **Scopes** tab, add `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.schemas.deals.read`, `crm.schemas.deals.write`.
3. Create the app and copy the access token (`pat-...`) into `HUBSPOT_TOKEN`.
4. Create the custom deal property `amend_thread_key`:
   ```bash
   pnpm setup:hubspot
   ```

## Gmail

1. Go to https://console.cloud.google.com/ and create or select a project.
2. Open **APIs & Services > Library**, search for **Gmail API**, and click **Enable**.
3. Open **APIs & Services > OAuth consent screen** (or **Google Auth Platform**):
   - User type: **External**. Fill in the app name and emails.
   - Scopes: add `https://www.googleapis.com/auth/gmail.modify`.
   - **Test users**: add the Gmail address you will use.
4. Open **APIs & Services > Credentials > Create credentials > OAuth client ID**, application type **Desktop app**. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Get a refresh token:
   ```bash
   pnpm setup:gmail
   ```
   Open the printed URL and approve. The app is unverified, so click **Advanced > Go to app**. Paste the printed `GOOGLE_REFRESH_TOKEN=...` line into `.env`.
6. Optional: set `GMAIL_FROM` (for example `Jane Doe <jane@example.com>`).

Refresh tokens for apps in "Testing" status expire after 7 days. If you see `invalid_grant`, run `pnpm setup:gmail` again.

## Everything else

- `ANTHROPIC_API_KEY`: get one at https://console.anthropic.com/settings/keys.
- `DATABASE_URL`: any Postgres URL. Then run `pnpm db:migrate`.
- `AMEND_MODEL`: defaults to `claude-opus-5`.

## Multi-workspace install (optional)

By default Amend runs in single-workspace mode with `SLACK_BOT_TOKEN`. Setting all three of `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_STATE_SECRET` switches it to OAuth mode: any workspace can install Amend, and each reply is posted with the bot token of the workspace that owns the channel. Events still arrive over Socket Mode, so `SLACK_APP_TOKEN` is still required. `SLACK_BOT_TOKEN` is ignored in this mode.

1. Create the app from `docs/slack-manifest.multi-workspace.yaml`, or update your existing app to match it (it adds `oauth_config.redirect_urls` and the `app_uninstalled` event).
2. **Redirect URL**: Slack requires redirect URLs to use **HTTPS** ([docs](https://docs.slack.dev/authentication/installing-with-oauth/)), so `http://localhost` won't work. Start a tunnel to the installer port, for example `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`. Then add `https://<tunnel-host>/slack/oauth_redirect` under **OAuth & Permissions > Redirect URLs**.
3. **Manage Distribution**: finish the checklist (remove hard-coded tokens and so on) and click **Activate Public Distribution**.
4. **Basic Information > App Credentials**: copy the Client ID and Client Secret into `.env`:
   ```
   SLACK_CLIENT_ID=...
   SLACK_CLIENT_SECRET=...
   SLACK_STATE_SECRET=<any long random string, e.g. openssl rand -hex 32>
   SLACK_INSTALL_PORT=3000
   SLACK_REDIRECT_URI=https://<tunnel-host>/slack/oauth_redirect
   ```
5. Start Amend and open **`https://<tunnel-host>/slack/install`** in a browser. You get the same page at `http://localhost:<SLACK_INSTALL_PORT>/slack/install`, but the OAuth state cookie is tied to the host you start from. Start from the tunnel host so the callback's state check passes. Approve the install, then `/invite @Amend` in a channel of that workspace.
6. Installations are stored in `amend_slack_installations` and the channel-to-workspace map in `amend_slack_channels`. Both tables are created automatically when `DATABASE_URL` is set. Without `DATABASE_URL`, both live in memory and are lost on restart, so every workspace would need to reinstall.

Amend learns a channel's workspace from the first event it receives there. Replies only go to channels that have sent at least one event since install.
