import { readFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { FACT_KEYS, type Extraction } from "../core/facts.js";
import type { ConflictRecord, LedgerEntry, Store, ThreadRecord, VersionRecord } from "../db/store.js";

/**
 * Read-only ledger viewer. Plain node:http, server-rendered HTML; the thread
 * page polls the JSON API and swaps in a fresh fragment when anything changes.
 */
export function startViewer(opts: { store: Store; port: number; log?: (m: string) => void }): http.Server {
  const { store, port } = opts;
  const log = opts.log ?? (() => undefined);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "method not allowed");
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      let m: RegExpMatchArray | null;

      if (path === "/") return send(res, 200, "text/html", await threadsPage(store));
      if ((m = path.match(/^\/thread\/([^/]+)\/?$/))) {
        const key = safeDecode(m[1]);
        if (key === null) return send(res, 404, "text/html", layout("Not found", `<h1>404</h1><p class="muted">Malformed thread reference.</p>`));
        const data = await loadThread(store, key);
        if (!data) return send(res, 404, "text/html", layout("Not found", `<h1>Thread not found</h1><p class="muted">${esc(key)}</p>`));
        if (url.searchParams.has("fragment")) return send(res, 200, "text/html", threadBody(data));
        return send(res, 200, "text/html", threadPage(data));
      }
      if ((m = path.match(/^\/api\/thread\/([^/]+)\/?$/))) {
        const key = safeDecode(m[1]);
        if (key === null) return send(res, 404, "application/json", JSON.stringify({ error: "not found" }));
        const data = await loadThread(store, key);
        if (!data) return send(res, 404, "application/json", JSON.stringify({ error: "not found" }));
        return send(res, 200, "application/json", JSON.stringify(data));
      }
      if (path === "/scoreboard") return send(res, 200, "text/html", await scoreboardPage());
      return send(res, 404, "text/html", layout("Not found", `<h1>404</h1><p class="muted">No route for ${esc(path)}</p>`));
    } catch (e) {
      // Full detail is logged server-side only; the response never echoes exception internals to the client.
      log(`viewer error on ${req.url}: ${(e as Error).stack ?? (e as Error).message}`);
      if (!res.headersSent) {
        const asJson = (req.url ?? "").startsWith("/api/");
        send(res, 500, asJson ? "application/json" : "text/plain", asJson ? JSON.stringify({ error: "internal error" }) : "500 internal error");
      } else res.end();
    }
  });
  /** Decodes a path segment, or null if it isn't valid percent-encoding — never lets a malformed URL 500. */
  function safeDecode(segment: string): string | null {
    try {
      return decodeURIComponent(segment);
    } catch {
      return null;
    }
  }

  server.on("error", (e) => log(`viewer failed to start on port ${port}: ${e.message}`));
  server.listen(port, () => log(`ledger viewer at http://localhost:${port}`));
  return server;
}

function send(res: http.ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(body);
}

// ------------------------------------------------------------------ data

interface ThreadData {
  thread: ThreadRecord;
  versions: VersionRecord[];
  ledger: LedgerEntry[];
  conflicts: ConflictRecord[];
}

async function loadThread(store: Store, key: string): Promise<ThreadData | null> {
  const thread = await store.getThread(key);
  if (!thread) return null;
  const [versions, ledger, conflicts] = await Promise.all([store.listVersions(key), store.listLedger(key), store.listConflicts(key)]);
  return { thread, versions, ledger, conflicts };
}

// ------------------------------------------------------------------ pages

async function threadsPage(store: Store): Promise<string> {
  const threads = await store.listThreads(100);
  const rows = await Promise.all(
    threads.map(async (t) => {
      const [latest, conflicts] = await Promise.all([store.latestVersion(t.threadKey), store.listConflicts(t.threadKey)]);
      return { t, latest, open: conflicts.filter((c) => c.status === "open").length };
    }),
  );
  rows.sort((a, b) => (b.latest?.createdAt ?? 0) - (a.latest?.createdAt ?? 0));
  const body = rows.length
    ? `<div class="scroll"><table>
<thead><tr><th>Thread</th><th>Version</th><th>HubSpot deal</th><th>Gmail draft</th><th>Open conflicts</th><th>Updated</th></tr></thead>
<tbody>${rows
        .map(
          ({ t, latest, open }) => `<tr>
<td><a href="/thread/${encodeURIComponent(t.threadKey)}" class="mono">${esc(t.threadKey)}</a></td>
<td>${latest ? `v${latest.version}` : "—"}</td>
<td class="mono">${esc(t.dealId ?? "—")}</td>
<td class="mono">${esc(t.draftId ?? "—")}</td>
<td>${open ? `<span class="badge failed">${open} open</span>` : `<span class="muted">0</span>`}</td>
<td class="muted nowrap">${latest ? fmtTime(latest.createdAt) : "—"}</td>
</tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="empty">No threads yet. Post an instruction in Slack, or run <code>pnpm viewer:demo</code>.</p>`;
  return layout("Threads", `<h1>Threads</h1><p class="muted">${rows.length} thread${rows.length === 1 ? "" : "s"} in the ledger, newest first.</p>${body}`, `<meta http-equiv="refresh" content="5">`);
}

function threadPage(d: ThreadData): string {
  const key = d.thread.threadKey;
  const script = `<script>
(() => {
  const key = ${JSON.stringify(encodeURIComponent(key))};
  let last = null;
  async function tick() {
    try {
      const r = await fetch('/api/thread/' + key, { cache: 'no-store' });
      if (!r.ok) return;
      const sig = await r.text();
      if (last !== null && sig !== last) {
        const f = await fetch('/thread/' + key + '?fragment=1', { cache: 'no-store' });
        if (f.ok) {
          const y = window.scrollY;
          document.getElementById('thread').innerHTML = await f.text();
          window.scrollTo(0, y);
        }
      }
      last = sig;
      document.getElementById('live').textContent = 'live · ' + new Date().toLocaleTimeString();
    } catch { document.getElementById('live').textContent = 'offline'; }
  }
  tick();
  setInterval(tick, 3000);
})();
</script>`;
  return layout(`Thread ${key}`, `<div id="thread">${threadBody(d)}</div>${script}`);
}

function threadBody(d: ThreadData): string {
  const t = d.thread;
  const open = d.conflicts.filter((c) => c.status === "open").length;
  const header = `<header class="thread-head">
<div class="eyebrow">Thread <span id="live" class="live">live</span></div>
<h1 class="mono">${esc(t.threadKey)}</h1>
<dl class="meta">
  <div><dt>HubSpot deal</dt><dd class="mono">${esc(t.dealId ?? "—")}</dd></div>
  <div><dt>Gmail draft</dt><dd class="mono">${esc(t.draftId ?? "—")}</dd></div>
  <div><dt>Sent drafts</dt><dd class="mono">${t.sentDraftIds.length ? t.sentDraftIds.map(esc).join(", ") : "—"}</dd></div>
  <div><dt>Versions</dt><dd>${d.versions.length}</dd></div>
  <div><dt>Ledger entries</dt><dd>${d.ledger.length}</dd></div>
  <div><dt>Open conflicts</dt><dd>${open ? `<span class="badge failed">${open}</span>` : "0"}</dd></div>
</dl></header>`;

  const versions = d.versions
    .map((v, i) => {
      const prev = d.versions[i - 1];
      return `<article class="version">
<div class="vhead"><span class="vnum">v${v.version}</span><span class="muted">${fmtTime(v.createdAt)}</span>${prev ? `<span class="muted small">changes vs v${prev.version} highlighted</span>` : ""}</div>
<blockquote>${prev ? wordDiff(prev.text, v.text) : esc(v.text)}</blockquote>
${factsBlock(v.extraction, prev?.extraction)}
</article>`;
    })
    .join("");

  const ledger = d.ledger.length
    ? `<div class="scroll"><table>
<thead><tr><th>Ver</th><th>Resource</th><th>Field</th><th>Action</th><th>Status</th><th>Value</th><th>Idempotency key</th><th>Time</th></tr></thead>
<tbody>${d.ledger
        .map(
          (e) => `<tr>
<td>v${e.version}</td>
<td>${esc(e.resource)}</td>
<td class="mono">${esc(e.field)}</td>
<td>${esc(e.action)}</td>
<td><span class="badge ${esc(e.status)}">${esc(e.status)}</span>${e.error ? `<div class="err" title="${esc(e.error)}">${esc(trunc(e.error, 60))}</div>` : ""}</td>
<td class="val" title="${esc(e.value ?? "")}">${e.value === null ? `<span class="muted">null</span>` : esc(trunc(oneLine(e.value), 80))}</td>
<td class="mono small nowrap" title="${esc(e.idempotencyKey)}">${esc(trunc(e.idempotencyKey.split(t.threadKey).join("…"), 40))}</td>
<td class="muted nowrap">${fmtTime(e.at)}</td>
</tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="empty">No ledger entries.</p>`;

  const conflicts = d.conflicts.length
    ? `<div class="scroll"><table>
<thead><tr><th>Ver</th><th>Field</th><th>Base</th><th>Human</th><th>Desired</th><th>Changed by</th><th>Status</th><th>Choice</th><th>Resolved by</th></tr></thead>
<tbody>${d.conflicts
        .map(
          (c) => `<tr>
<td>v${c.version}</td>
<td class="mono">${esc(c.resource)}.${esc(c.field)}</td>
<td class="val" title="${esc(c.base ?? "")}">${cell(c.base)}</td>
<td class="val human" title="${esc(c.human ?? "")}">${cell(c.human)}</td>
<td class="val desired" title="${esc(c.desired ?? "")}">${cell(c.desired)}</td>
<td>${esc(c.changedBy ?? "—")}</td>
<td><span class="badge ${c.status === "open" ? "failed" : "applied"}">${esc(c.status)}</span></td>
<td>${esc(c.choice ?? "—")}</td>
<td>${esc(c.resolvedBy ?? "—")}</td>
</tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="empty">No conflicts on this thread.</p>`;

  return `${header}
<section><h2>Instruction versions</h2>${versions || `<p class="empty">No versions.</p>`}</section>
<section><h2>Ledger <span class="muted small">oldest first</span></h2>${ledger}</section>
<section><h2>Conflicts</h2>${conflicts}</section>`;
}

function factsBlock(x: Extraction | undefined, prev: Extraction | undefined): string {
  if (!x) return `<p class="muted small">No extraction recorded.</p>`;
  const keys = FACT_KEYS.filter((k) => x.facts[k]);
  const removed = prev ? FACT_KEYS.filter((k) => prev.facts[k] && !x.facts[k]) : [];
  const rows = keys
    .map((k) => {
      const f = x.facts[k]!;
      const changed = prev && prev.facts[k]?.value !== f.value;
      return `<tr${changed ? ` class="changed"` : ""}><td class="mono">${esc(k)}</td><td class="fv">${esc(f.value)}${changed ? ` <span class="was">was ${esc(prev.facts[k]?.value ?? "unset")}</span>` : ""}</td><td class="quote">${f.source ? `“${esc(f.source)}”` : `<span class="muted">—</span>`}</td></tr>`;
    })
    .concat(removed.map((k) => `<tr class="changed"><td class="mono">${esc(k)}</td><td class="fv"><span class="muted">removed</span> <span class="was">was ${esc(prev!.facts[k]!.value)}</span></td><td></td></tr>`))
    .join("");
  const facts = rows
    ? `<div class="scroll"><table class="facts"><thead><tr><th>Fact</th><th>Value</th><th>Source quote</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted small">No facts extracted.</p>`;
  const list = (title: string, cls: string, items: string[]) =>
    items.length ? `<div class="note ${cls}"><strong>${title}</strong><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>` : "";
  return facts + list("Rejected instructions", "rejected", x.rejected) + list("Clarifications", "clarify", x.clarifications);
}

async function scoreboardPage(): Promise<string> {
  let md: string;
  try {
    md = await readFile(join(process.cwd(), "evals/out/scoreboard.md"), "utf8");
  } catch {
    return layout("Scoreboard", `<h1>Scoreboard</h1><p class="empty">No scoreboard yet: run <code>pnpm eval</code>.</p>`);
  }
  return layout("Scoreboard", `<div class="md">${renderMarkdown(md)}</div>`);
}

// ------------------------------------------------------------------ helpers

function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
function cell(v: string | null): string {
  return v === null ? `<span class="muted">null</span>` : esc(trunc(oneLine(v), 60));
}
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Word-level LCS diff; words in `next` that are not in the common subsequence are highlighted. */
function wordDiff(prev: string, next: string): string {
  const a = prev.split(/(\s+)/).filter((w) => w !== "");
  const b = next.split(/(\s+)/).filter((w) => w !== "");
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) return esc(next);
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let removed: string[] = [];
  const flushRemoved = () => {
    const words = removed.filter((w) => !/^\s+$/.test(w));
    if (words.length) out.push(`<del>${esc(words.join(" "))}</del>`);
    removed = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flushRemoved();
      out.push(esc(b[j]));
      i++;
      j++;
    } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      removed.push(a[i]);
      i++;
    } else {
      flushRemoved();
      out.push(/^\s+$/.test(b[j]) ? esc(b[j]) : `<ins>${esc(b[j])}</ins>`);
      j++;
    }
  }
  flushRemoved();
  return out.join("");
}

/** Tiny markdown renderer: headings, pipe tables, fences, bullets, `code`, **bold**, paragraphs. */
export function renderMarkdown(md: string): string {
  // U+E000 is used below as an internal placeholder for extracted code spans. Strip it from the
  // source first so text that happens to contain it can never collide with that placeholder and
  // get replaced by an out-of-range array lookup (rendering the literal string "undefined").
  const lines = md.replace(/\uE000/g, "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const inline = (s: string) => {
    const codes: string[] = [];
    let h = s.replace(/`([^`]+)`/g, (_, c: string) => `\uE000${codes.push(`<code>${esc(c)}</code>`) - 1}\uE000`);
    h = esc(h).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    return h.replace(/\uE000(\d+)\uE000/g, (_, n: string) => codes[Number(n)]);
  };
  const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
    } else if (/^#{1,3}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ""))}</h${level}>`);
      i++;
    } else if (/^\s*\|/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const hasHead = rows.length > 1 && /^\s*\|?\s*:?-{2,}/.test(rows[1]);
      const head = hasHead ? `<thead><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` : "";
      const bodyRows = hasHead ? rows.slice(2) : rows;
      out.push(
        `<div class="scroll"><table>${head}<tbody>${bodyRows.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
    } else if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      out.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`);
    } else if (line.trim() === "") {
      i++;
    } else {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^(```|#{1,3}\s|\s*\||\s*[-*]\s+)/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

function layout(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Amend</title>${head}
<style>${CSS}</style></head>
<body><nav><a class="brand" href="/">Amend <span>ledger</span></a><div class="links"><a href="/">Threads</a><span>·</span><a href="/scoreboard">Scoreboard</a></div></nav>
<main>${body}</main></body></html>`;
}

const CSS = `
:root{--bg:#f7f7f5;--panel:#fff;--text:#1c1c1a;--muted:#6b6b66;--line:#e4e4df;--accent:#3a5bd9;--code:#f0f0ec;
--g-bg:#e3f3e6;--g:#1d6b34;--b-bg:#e3ecfb;--b:#2449a8;--x-bg:#ececea;--x:#55554f;--r-bg:#fbe5e3;--r:#a3261b;--a-bg:#fbf0d9;--a:#8a5a00;
--ins:#fff0a8;--ins-t:#4a3b00;--del:#9a9a93}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1c1c1b;--text:#ececea;--muted:#9a9a93;--line:#2e2e2c;--accent:#8ea6ff;--code:#262624;
--g-bg:#17351f;--g:#8fdca3;--b-bg:#1a2744;--b:#9db8ff;--x-bg:#2a2a28;--x:#b5b5ae;--r-bg:#40201d;--r:#ffa399;--a-bg:#3b2d10;--a:#f2c46b;
--ins:#5c4a00;--ins-t:#fff3c2;--del:#77776f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
nav{display:flex;align-items:center;justify-content:space-between;padding:12px 32px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
.brand{font-weight:700;color:var(--text);font-size:15px}.brand span{color:var(--muted);font-weight:400}
.links{display:flex;gap:10px;color:var(--muted)}
main{max-width:1200px;margin:0 auto;padding:24px 32px 64px}
h1{font-size:22px;margin:0 0 4px;word-break:break-all}h2{font-size:16px;margin:32px 0 12px}h3{font-size:14px;margin:20px 0 8px}
.mono,code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
code{background:var(--code);padding:1px 5px;border-radius:4px}
pre{background:var(--code);padding:12px;border-radius:6px;overflow-x:auto}pre code{padding:0;background:none}
.muted{color:var(--muted)}.small{font-size:12px;font-weight:400}.nowrap{white-space:nowrap}
.empty{color:var(--muted);padding:16px;border:1px dashed var(--line);border-radius:8px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600;background:var(--bg);white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
td.val{max-width:360px}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.badge.applied{background:var(--g-bg);color:var(--g)}.badge.accepted_human{background:var(--b-bg);color:var(--b)}
.badge.pending{background:var(--x-bg);color:var(--x)}.badge.failed{background:var(--r-bg);color:var(--r)}.badge.superseded{background:var(--a-bg);color:var(--a)}
.err{color:var(--r);font-size:11.5px}
.thread-head{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 20px}
.eyebrow{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);display:flex;gap:10px;align-items:center}
.live{text-transform:none;letter-spacing:0;color:var(--g)}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:14px 0 0}
.meta dt{font-size:11.5px;color:var(--muted)}.meta dd{margin:0;font-weight:600;word-break:break-all}
.version{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin-bottom:12px}
.vhead{display:flex;gap:12px;align-items:baseline;margin-bottom:8px}
.vnum{font-weight:700;background:var(--text);color:var(--bg);border-radius:6px;padding:0 8px}
blockquote{margin:0 0 12px;padding:8px 14px;border-left:3px solid var(--accent);font-size:15px;line-height:1.6;background:var(--bg);border-radius:0 6px 6px 0;white-space:pre-wrap}
ins{background:var(--ins);color:var(--ins-t);text-decoration:none;border-radius:3px;padding:0 2px;font-weight:600}
del{color:var(--del);margin:0 2px}
table.facts td{padding:5px 12px}table.facts .fv{font-weight:600}
table.facts tr.changed td{background:var(--a-bg)}
.was{font-weight:400;color:var(--muted);font-size:12px;text-decoration:line-through}
.quote{color:var(--muted);font-style:italic}
.note{margin-top:10px;padding:8px 14px;border-radius:6px;font-size:13px}.note ul{margin:4px 0 0;padding-left:18px}
.note.rejected{background:var(--r-bg);color:var(--r)}.note.clarify{background:var(--b-bg);color:var(--b)}
td.human{color:var(--b)}td.desired{color:var(--g)}
.md h1{font-size:24px}.md table{margin:0}.md .scroll{margin:12px 0 20px}
@media (max-width:700px){nav,main{padding-left:16px;padding-right:16px}}
`;
