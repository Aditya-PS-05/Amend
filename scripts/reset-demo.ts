/**
 * Wipes Amend's demo state so a recording starts clean:
 * archives HubSpot deals Amend created (those with amend_thread_key), deletes Amend's unsent Gmail drafts,
 * and truncates the ledger tables. Sent emails are never touched.
 *   pnpm reset:demo --yes
 */
import "dotenv/config";
import { Client } from "@hubspot/api-client";
import { GmailMail } from "../src/adapters/gmail/real.js";
import { THREAD_KEY_PROPERTY } from "../src/adapters/hubspot/real.js";
import { PgStore } from "../src/db/pg-store.js";

if (!process.argv.includes("--yes")) {
  console.log("This archives every HubSpot deal Amend created, deletes Amend's unsent drafts, and clears the ledger.\nRe-run with --yes to proceed.");
  process.exit(1);
}

const hs = new Client({ accessToken: process.env.HUBSPOT_TOKEN! });
let archived = 0;
for (;;) {
  const page = await hs.crm.deals.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: THREAD_KEY_PROPERTY, operator: "HAS_PROPERTY" as never }] }],
    properties: ["dealname"],
    limit: 100,
  });
  if (!page.results.length) break;
  for (const d of page.results) {
    await hs.crm.deals.basicApi.archive(d.id);
    console.log(`archived deal ${d.id} (${d.properties.dealname})`);
    archived++;
  }
  // Search is eventually consistent; stop once a page only returns already-archived ids.
  if (page.results.length < 100) break;
}

const pg = new PgStore(process.env.DATABASE_URL!);
await pg.migrate();
const mail = new GmailMail({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET!, refreshToken: process.env.GOOGLE_REFRESH_TOKEN! });
let drafts = 0;
for (const t of await pg.listThreads(1000)) {
  if (t.draftId && !t.sentDraftIds.includes(t.draftId)) {
    await mail.deleteDraft(t.draftId);
    drafts++;
  }
}
await pg.sql`truncate amend_ledger, amend_versions, amend_conflicts, amend_threads, amend_links, amend_events`;
await pg.close();
console.log(`\nArchived ${archived} deal(s), deleted ${drafts} draft(s), cleared the ledger.`);
