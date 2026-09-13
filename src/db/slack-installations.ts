/**
 * Multi-workspace Slack support: OAuth installations plus a channel -> workspace map,
 * so outgoing replies (which only know the channel) use the right bot token.
 * Only used when SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_STATE_SECRET are set.
 */
import postgres from "postgres";
import type { Installation, InstallationQuery, InstallationStore } from "@slack/bolt";
import { connectionOptions } from "./pg-store.js";

export const SLACK_SCHEMA = `
create table if not exists amend_slack_installations (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists amend_slack_channels (
  channel text primary key,
  team_id text,
  enterprise_id text
);
`;

export async function migrateSlackInstallations(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(SLACK_SCHEMA);
}

type AnyInstallation = Installation<"v1" | "v2", boolean>;
type AnyQuery = InstallationQuery<boolean>;

export interface ChannelWorkspace {
  teamId?: string;
  enterpriseId?: string;
}

/** Bolt InstallationStore plus the channel map used to pick a token for outgoing posts. */
export interface SlackWorkspaces extends InstallationStore {
  /** Records which workspace a channel belongs to (cache is updated synchronously; persistence is async). */
  rememberChannel(channel: string, ws: ChannelWorkspace): Promise<void>;
  /** Bot token of the installation that owns this channel, or undefined if unknown. */
  botTokenForChannel(channel: string): Promise<string | undefined>;
  close(): Promise<void>;
}

/** Enterprise id for org-wide installs, team id otherwise (same keying as Bolt's MemoryInstallationStore). */
function installationKey(inst: AnyInstallation): string {
  if (inst.isEnterpriseInstall && inst.enterprise?.id) return inst.enterprise.id;
  if (inst.team?.id) return inst.team.id;
  throw new Error("amend: installation has neither team nor enterprise id");
}

function queryKey(q: AnyQuery): string {
  if (q.isEnterpriseInstall && q.enterpriseId) return q.enterpriseId;
  if (q.teamId) return q.teamId;
  if (q.enterpriseId) return q.enterpriseId;
  throw new Error("amend: installation query has neither team nor enterprise id");
}

abstract class BaseWorkspaces implements SlackWorkspaces {
  protected channels = new Map<string, ChannelWorkspace>();

  abstract storeInstallation<AuthVersion extends "v1" | "v2">(installation: Installation<AuthVersion, boolean>): Promise<void>;
  protected abstract load(key: string): Promise<AnyInstallation | undefined>;
  protected abstract remove(key: string): Promise<void>;
  protected abstract persistChannel(channel: string, ws: ChannelWorkspace): Promise<void>;
  protected abstract loadChannel(channel: string): Promise<ChannelWorkspace | undefined>;
  abstract close(): Promise<void>;

  fetchInstallation = async (query: AnyQuery): Promise<AnyInstallation> => {
    // A workspace inside an Enterprise Grid may be covered by an org-wide install.
    const inst = (await this.load(queryKey(query))) ?? (query.enterpriseId ? await this.load(query.enterpriseId) : undefined);
    if (!inst) throw new Error(`amend: no Slack installation for team=${query.teamId ?? "-"} enterprise=${query.enterpriseId ?? "-"}`);
    return inst;
  };

  deleteInstallation = async (query: AnyQuery): Promise<void> => {
    await this.remove(queryKey(query));
  };

  async rememberChannel(channel: string, ws: ChannelWorkspace): Promise<void> {
    if (!ws.teamId && !ws.enterpriseId) return;
    const prev = this.channels.get(channel);
    if (prev && prev.teamId === ws.teamId && prev.enterpriseId === ws.enterpriseId) return;
    this.channels.set(channel, ws);
    await this.persistChannel(channel, ws);
  }

  async botTokenForChannel(channel: string): Promise<string | undefined> {
    let ws = this.channels.get(channel);
    if (!ws) {
      ws = await this.loadChannel(channel);
      if (ws) this.channels.set(channel, ws);
    }
    if (!ws) return undefined;
    const inst =
      (ws.teamId ? await this.load(ws.teamId) : undefined) ?? (ws.enterpriseId ? await this.load(ws.enterpriseId) : undefined);
    return inst?.bot?.token;
  }
}

export class MemorySlackWorkspaces extends BaseWorkspaces {
  private installs = new Map<string, AnyInstallation>();
  async storeInstallation<AuthVersion extends "v1" | "v2">(installation: Installation<AuthVersion, boolean>) {
    const inst = installation as AnyInstallation;
    this.installs.set(installationKey(inst), inst);
  }
  protected async load(key: string) {
    return this.installs.get(key);
  }
  protected async remove(key: string) {
    this.installs.delete(key);
  }
  protected async persistChannel() {}
  protected async loadChannel() {
    return undefined;
  }
  async close() {}
}

export class PgSlackWorkspaces extends BaseWorkspaces {
  constructor(public sql: postgres.Sql) {
    super();
  }
  async storeInstallation<AuthVersion extends "v1" | "v2">(installation: Installation<AuthVersion, boolean>) {
    const inst = installation as AnyInstallation;
    const data = JSON.parse(JSON.stringify(inst));
    await this.sql`
      insert into amend_slack_installations (id, data, updated_at)
      values (${installationKey(inst)}, ${this.sql.json(data)}, now())
      on conflict (id) do update set data = excluded.data, updated_at = now()`;
  }
  protected async load(key: string) {
    const [r] = await this.sql`select data from amend_slack_installations where id = ${key}`;
    return r ? (r.data as AnyInstallation) : undefined;
  }
  protected async remove(key: string) {
    await this.sql`delete from amend_slack_installations where id = ${key}`;
  }
  protected async persistChannel(channel: string, ws: ChannelWorkspace) {
    await this.sql`
      insert into amend_slack_channels (channel, team_id, enterprise_id)
      values (${channel}, ${ws.teamId ?? null}, ${ws.enterpriseId ?? null})
      on conflict (channel) do update set team_id = excluded.team_id, enterprise_id = excluded.enterprise_id`;
  }
  protected async loadChannel(channel: string) {
    const [r] = await this.sql`select team_id, enterprise_id from amend_slack_channels where channel = ${channel}`;
    if (!r) return undefined;
    return { ...(r.team_id ? { teamId: r.team_id as string } : {}), ...(r.enterprise_id ? { enterpriseId: r.enterprise_id as string } : {}) };
  }
  async close() {
    await this.sql.end({ timeout: 5 });
  }
}

/** Postgres-backed when a URL is given (tables are created), in-memory otherwise. */
export async function createSlackWorkspaces(databaseUrl?: string): Promise<SlackWorkspaces> {
  if (!databaseUrl) return new MemorySlackWorkspaces();
  const opts = connectionOptions(databaseUrl);
  const sql = postgres(opts.url, { max: 3, ssl: opts.ssl, onnotice: () => {}, connect_timeout: 15 });
  await migrateSlackInstallations(sql);
  return new PgSlackWorkspaces(sql);
}
