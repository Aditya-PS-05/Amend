import { Client } from "@hubspot/api-client";
import {
  DEAL_FIELDS,
  TransientError,
  type ChangeSource,
  type CrmAdapter,
  type DealField,
  type DealSnapshot,
} from "../types.js";

export const THREAD_KEY_PROPERTY = "amend_thread_key";

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

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const h = headers as { get?: (k: string) => string | null } & Record<string, unknown>;
  if (typeof h.get === "function") return h.get(name) ?? undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key ? h[key] : undefined;
  return Array.isArray(v) ? String(v[0]) : v == null ? undefined : String(v);
}

export function parseRetryAfter(v: string | undefined): number {
  if (!v) return 0;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

/** HubSpot ApiException has numeric `code` (HTTP status), `body`, `headers`. */
function httpStatus(err: unknown): number | undefined {
  // A DOMException (e.g. a fetch AbortError) has a legacy numeric `.code` (AbortError = 20) that is
  // not an HTTP status; reading it as one hides real aborts/timeouts behind an unrelated status check.
  if (err instanceof DOMException) return undefined;
  const e = err as { code?: unknown; status?: unknown };
  if (typeof e?.code === "number" && e.code >= 100 && e.code <= 599) return e.code;
  if (typeof e?.status === "number") return e.status;
  return undefined;
}

/** Converts 429/5xx/network failures into TransientError; rethrows everything else. */
export function mapError(err: unknown, op: string): never {
  const status = httpStatus(err);
  const e = err as { code?: unknown; name?: string; message?: string; headers?: unknown; cause?: { code?: unknown } };
  if (status === 429 || (status !== undefined && status >= 500)) {
    throw new TransientError(`HubSpot ${op} failed with HTTP ${status}`, parseRetryAfter(headerValue(e.headers, "retry-after")));
  }
  if (status === undefined) {
    const code = typeof e?.code === "string" ? e.code : typeof e?.cause?.code === "string" ? (e.cause.code as string) : "";
    const msg = e?.message ?? "";
    if (
      NETWORK_CODES.has(code) ||
      e?.name === "FetchError" ||
      e?.name === "AbortError" ||
      /fetch failed|socket hang up|network|timeout/i.test(msg)
    ) {
      throw new TransientError(`HubSpot ${op} network error: ${msg || code}`);
    }
  }
  throw err;
}

/**
 * "YYYY-MM-DD" -> midnight UTC epoch ms string (HubSpot datetime property), or null when the
 * string isn't a real calendar date (e.g. "2024-13-45"). `Date.parse` silently returns NaN for
 * those, which used to be written to HubSpot as the literal string "NaN" — never write that.
 */
export function toHubSpotDate(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const ms = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(ms) ? String(ms) : null;
}

export function normalizeCloseDate(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (/^\d+$/.test(v)) return safeIsoDate(Number(v)) ?? v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? (safeIsoDate(t) ?? v) : v;
}

/** `new Date(ms).toISOString()` throws RangeError outside ±8.64e15ms; never let a corrupt stored value crash reconciliation. */
function safeIsoDate(ms: number): string | null {
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

export function normalizeAmount(v: string): string {
  const s = v.trim();
  const m = /^(-?\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return s;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  return frac ? `${m[1]}.${frac}` : m[1];
}

export function normalizeField(field: DealField, raw: string | null | undefined): string | null {
  if (raw == null || raw === "") return null;
  if (field === "closedate") return normalizeCloseDate(raw);
  if (field === "amount") return normalizeAmount(raw);
  return raw;
}

export function toHubSpotProps(fields: Partial<Record<DealField, string>>): Record<string, string> {
  const props: Record<string, string> = {};
  for (const f of DEAL_FIELDS) {
    const v = fields[f];
    if (v === undefined) continue;
    if (f === "closedate" && v) {
      const d = toHubSpotDate(v);
      if (d === null) continue; // an uncalendarable date is dropped, never written as "NaN"
      props[f] = d;
    } else {
      props[f] = v;
    }
  }
  return props;
}

interface HistoryEntry {
  sourceType: string;
  updatedByUserId?: number;
  timestamp: Date | string;
}

export function toSnapshot(obj: {
  id: string;
  properties: Record<string, string | null>;
  propertiesWithHistory?: Record<string, HistoryEntry[]>;
}): DealSnapshot {
  const fields = {} as Record<DealField, string | null>;
  const lastChangedBy: Partial<Record<DealField, ChangeSource>> = {};
  for (const f of DEAL_FIELDS) {
    fields[f] = normalizeField(f, obj.properties?.[f]);
    const hist = obj.propertiesWithHistory?.[f];
    if (hist && hist.length > 0) {
      const newest = [...hist].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
      const src: ChangeSource = { sourceType: newest.sourceType };
      if (newest.updatedByUserId != null) src.userId = String(newest.updatedByUserId);
      if (newest.timestamp) src.at = new Date(newest.timestamp).toISOString();
      lastChangedBy[f] = src;
    }
  }
  return { id: obj.id, fields, lastChangedBy };
}

export class HubSpotCrm implements CrmAdapter {
  private client: Client;

  constructor(opts: { accessToken: string }) {
    this.client = new Client({ accessToken: opts.accessToken });
  }

  async findDealByThreadKey(threadKey: string): Promise<DealSnapshot | null> {
    let res;
    try {
      res = await this.client.crm.deals.searchApi.doSearch({
        filterGroups: [
          {
            filters: [{ propertyName: THREAD_KEY_PROPERTY, operator: "EQ" as never, value: threadKey }],
          },
        ],
        properties: [...DEAL_FIELDS, THREAD_KEY_PROPERTY],
        limit: 1,
      });
    } catch (err) {
      mapError(err, "searchDeals");
    }
    const hit = res.results[0];
    if (!hit) return null;
    // Fetch with history so lastChangedBy is populated.
    return (await this.getDeal(hit.id)) ?? toSnapshot(hit);
  }

  async createDeal(threadKey: string, fields: Partial<Record<DealField, string>>): Promise<DealSnapshot> {
    let res;
    try {
      res = await this.client.crm.deals.basicApi.create({
        properties: { ...toHubSpotProps(fields), [THREAD_KEY_PROPERTY]: threadKey },
        associations: [],
      });
    } catch (err) {
      mapError(err, "createDeal");
    }
    return toSnapshot(res);
  }

  async getDeal(id: string): Promise<DealSnapshot | null> {
    try {
      const res = await this.client.crm.deals.basicApi.getById(id, [...DEAL_FIELDS], [...DEAL_FIELDS]);
      return toSnapshot(res);
    } catch (err) {
      if (httpStatus(err) === 404) return null;
      mapError(err, "getDeal");
    }
  }

  async findChangedSince(sinceMs: number): Promise<Array<DealSnapshot & { threadKey: string }>> {
    let res;
    try {
      res = await this.client.crm.deals.searchApi.doSearch({
        filterGroups: [
          {
            filters: [
              { propertyName: THREAD_KEY_PROPERTY, operator: "HAS_PROPERTY" as never },
              { propertyName: "hs_lastmodifieddate", operator: "GTE" as never, value: String(sinceMs) },
            ],
          },
        ],
        properties: [THREAD_KEY_PROPERTY],
        limit: 100,
      });
    } catch (err) {
      mapError(err, "findChangedSince");
    }
    const out: Array<DealSnapshot & { threadKey: string }> = [];
    for (const hit of res.results) {
      const snap = await this.getDeal(hit.id);
      const threadKey = hit.properties?.[THREAD_KEY_PROPERTY];
      if (snap && threadKey) out.push({ ...snap, threadKey });
    }
    return out;
  }

  async updateDeal(id: string, fields: Partial<Record<DealField, string>>): Promise<void> {
    try {
      await this.client.crm.deals.basicApi.update(id, { properties: toHubSpotProps(fields) });
    } catch (err) {
      mapError(err, "updateDeal");
    }
  }
}

/** Creates the amend_thread_key deal property if missing. Idempotent. */
export async function ensureHubSpotProperties(accessToken: string): Promise<{ created: boolean; name: string }> {
  const client = new Client({ accessToken });
  try {
    await client.crm.properties.coreApi.getByName("deals", THREAD_KEY_PROPERTY);
    return { created: false, name: THREAD_KEY_PROPERTY };
  } catch (err) {
    if (httpStatus(err) !== 404) mapError(err, "getProperty");
  }
  try {
    await client.crm.properties.coreApi.create("deals", {
      name: THREAD_KEY_PROPERTY,
      label: "Amend thread key",
      description: "Slack thread key used by Amend to find the deal it created.",
      groupName: "dealinformation",
      type: "string" as never,
      fieldType: "text" as never,
    });
    return { created: true, name: THREAD_KEY_PROPERTY };
  } catch (err) {
    if (httpStatus(err) === 409) return { created: false, name: THREAD_KEY_PROPERTY };
    mapError(err, "createProperty");
  }
}
