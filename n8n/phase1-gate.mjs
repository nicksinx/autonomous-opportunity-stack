#!/usr/bin/env node
/**
 * Phase 1 gate for the POD Trend Research project (Postgres-backed).
 *
 * Verifies, end-to-end, that:
 *   Gate 1 — Postgres migrations applied (derived from gates 2 + 3)
 *   Gate 2 — required tables exist with at least the expected column count
 *   Gate 3 — sources_config has the 6 seed rows
 *   Gate 4 — required workflows are imported and active in n8n
 *   Gate 5 — POST triggers each main workflow (public API execute, else REST /rest/.../run,
 *            else MCP execute_workflow when N8N_MCP_URL + N8N_MCP_TOKEN are set) and checks workflow_runs
 *   Gate 6 — Phase 3 data acceptance criteria
 *
 * Usage:
 *   node n8n/phase1-gate.mjs
 *   node n8n/phase1-gate.mjs --skip-trigger
 *   node n8n/phase1-gate.mjs --skip-phase3   # skip Gate 6 (empty DB until pipelines run)
 *   node n8n/phase1-gate.mjs --gate9        # optional Gate 9 — Layer 2 API (needs api:start + LAYER2_API_TOKEN)
 *   node n8n/phase1-gate.mjs --json
 *
 * Required env (loaded from .env / .env.postgres in repo root):
 *   N8N_BASE_URL or N8N_API_URL (or N8N_MCP_URL if those are unset — same host as MCP / Editor)
 *   N8N_API_KEY            (n8n Settings → API; needs workflow:execute for POST .../execute)
 *   DATABASE_URI           (postgres app role; SELECT is sufficient)
 *
 * Optional (Gate 5 only, when POST /api/v1/workflows/{id}/execute is missing on your n8n):
 *   N8N_MCP_URL + N8N_MCP_TOKEN — instance MCP HTTP endpoint + bearer (Settings → MCP access).
 *     Used for tools/call execute_workflow when public execute returns 405 and REST /run is 401.
 *   N8N_SESSION_COOKIE     full Cookie header from a logged-in browser session, e.g. n8n-auth=...
 *   N8N_BROWSER_ID         required with session JWT — must match browser-id on POST /rest/workflows/.../run
 *   N8N_MCP_BROWSER_ID     alias for N8N_BROWSER_ID
 *   N8N_AUTH_COOKIE        JWT only; gate sends Cookie: n8n-auth=<value>
 *
 * Exit code: 0 if every gate PASSED, 1 otherwise.
 */

import fs from "fs";
import http from "node:http";
import https from "node:https";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const MCP_HTTP_TIMEOUT_MS = 30_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Per-table minimum column counts (mirror db/migrations/0001_init.sql).
// Phase 1 gate accepts >= because future migrations may add columns.
const REQUIRED_TABLES = [
  { name: "sources_config", minColumns: 7 },
  { name: "raw_signals", minColumns: 12 },
  { name: "normalized_terms", minColumns: 14 },
  { name: "marketplace_evidence", minColumns: 8 },
  { name: "canonical_signals", minColumns: 22 },
  { name: "workflow_outbox", minColumns: 10 },
  { name: "scoring_runs", minColumns: 9 },
  { name: "opportunity_candidate", minColumns: 18 },
  { name: "opportunity_score", minColumns: 11 },
  { name: "opportunity_score_factor", minColumns: 8 },
  { name: "trend_cluster_v2", minColumns: 12 },
  { name: "cluster_members_v2", minColumns: 6 },
  { name: "trend_scores", minColumns: 11 },
  { name: "theme_clusters", minColumns: 16 },
  { name: "range_briefs", minColumns: 11 },
  { name: "phrase_bank", minColumns: 7 },
  { name: "watchlist", minColumns: 6 },
  { name: "workflow_runs", minColumns: 10 },
  { name: "opportunity_scores", minColumns: 25 },
  { name: "score_components", minColumns: 9 },
  { name: "score_weights", minColumns: 6 },
  { name: "performance_feedback", minColumns: 12 },
  { name: "scoring_audit_log", minColumns: 11 },
  { name: "normalization_log", minColumns: 10 },
  { name: "publishing_queue", minColumns: 14 },
  { name: "stage_run_logs", minColumns: 16 },
  { name: "source_health", minColumns: 13 },
  { name: "pipeline_locks", minColumns: 10 },
];

const EXPECTED_SOURCE_NAMES = [
  "google_trends",
  "pinterest_trends",
  "tiktok_creative",
  "etsy_autocomplete",
  "amazon_movers",
  "google_kw_planner",
];

const REQUIRED_WORKFLOWS = [
  "wf_collect_trends",
  "wf_normalize_terms",
  "wf_score_and_cluster",
  "wf_enrich_marketplace",
  "wf_generate_range_briefs",
  "wf_publish_queue",
];
const APP_SCHEMAS = ["intake", "scoring", "workflow", "analytics", "public"];

const EXEC_POLL_INTERVAL_MS = 2000;
const EXEC_POLL_TIMEOUT_MS = 90_000;
const HTTP_TIMEOUT_MS = 20_000;
const HTTP_MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function parseArgs(argv) {
  return {
    skipTrigger: argv.includes("--skip-trigger"),
    skipPhase3: argv.includes("--skip-phase3"),
    json: argv.includes("--json"),
    gate9: argv.includes("--gate9"),
  };
}

function n8nBase() {
  return (process.env.N8N_API_URL || process.env.N8N_BASE_URL || process.env.N8N_MCP_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

async function fetchJson(url, opts = {}) {
  const maxRetries = HTTP_MAX_RETRIES;
  const timeoutMs = HTTP_TIMEOUT_MS;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : null; }
      catch { body = { _raw: text }; }
      if (!res.ok) {
        const msg = body?.message || body?.error?.message || body?._raw || res.statusText;
        const err = new Error(`HTTP ${res.status} ${url}: ${msg}`);
        err.status = res.status;
        if (attempt < maxRetries && RETRYABLE_STATUS.has(res.status)) {
          await sleep(500 * attempt);
          continue;
        }
        throw err;
      }
      return body;
    } catch (e) {
      lastErr = e;
      const isAbort = e?.name === "AbortError";
      const status = e?.status;
      const retryable = isAbort || RETRYABLE_STATUS.has(status);
      if (attempt < maxRetries && retryable) {
        await sleep(500 * attempt);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`Request failed: ${url}`);
}

function n8nHeaders() {
  return {
    Accept: "application/json",
    "X-N8N-API-KEY": (process.env.N8N_API_KEY || "").trim(),
  };
}

function n8nHeadersJson() {
  return { ...n8nHeaders(), "Content-Type": "application/json" };
}

/**
 * Headers for POST /rest/workflows/:id/run (Editor path).
 * When using a session Cookie, omit X-N8N-API-KEY — mixing API-key and cookie auth can confuse some setups.
 */
function n8nRestRunHeaders() {
  const session = (process.env.N8N_SESSION_COOKIE || "").trim();
  const authOnly = (process.env.N8N_AUTH_COOKIE || "").trim();
  const mcpToken = (process.env.N8N_MCP_TOKEN || "").trim();
  const hasCookie = !!(session || authOnly || mcpToken);

  const h = hasCookie
    ? { Accept: "application/json", "Content-Type": "application/json" }
    : n8nHeadersJson();

  if (session) {
    h.Cookie = session;
  } else if (authOnly) {
    h.Cookie = authOnly.includes("=") ? authOnly : `n8n-auth=${authOnly}`;
  } else if (mcpToken) {
    h.Cookie = mcpToken.includes("=") ? mcpToken : `n8n-auth=${mcpToken}`;
  }

  const browserId = (process.env.N8N_BROWSER_ID || process.env.N8N_MCP_BROWSER_ID || "").trim();
  if (browserId) h["browser-id"] = browserId;
  return h;
}

function parseMcpSse(body) {
  const lines = String(body || "").split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (!payload) continue;
    try {
      return JSON.parse(payload);
    } catch {
      return { raw: payload };
    }
  }
  return { raw: String(body || "") };
}

/** MCP tools/call (same wire format as n8n/simulate-scheduled-runs.mjs). */
async function mcpToolsCall(name, args = {}) {
  const url = (process.env.N8N_MCP_URL || "").trim();
  const token = (process.env.N8N_MCP_TOKEN || "").trim();
  if (!url || !token) throw new Error("N8N_MCP_URL and N8N_MCP_TOKEN required");

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name, arguments: args },
  });

  const parsedUrl = new URL(url);
  const requestImpl = parsedUrl.protocol === "http:" ? http.request : https.request;
  const body = await new Promise((resolve, reject) => {
    const req = requestImpl(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: "POST",
        timeout: MCP_HTTP_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("MCP request timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  const parsed = parseMcpSse(body.text);
  if (body.statusCode >= 400) {
    const msg = parsed?.error?.message || parsed?.raw || "request failed";
    throw new Error(`${body.statusCode} ${url}: ${msg}`);
  }
  if (parsed.error) {
    throw new Error(`${name} error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  }
  return parsed.result?.structuredContent ?? parsed.result ?? parsed;
}

// ---------------- Postgres connection ----------------
function makePool() {
  const uri = (process.env.DATABASE_URI_ADMIN || process.env.DATABASE_URI || "").trim();
  if (!uri) throw new Error("DATABASE_URI not set");
  return new pg.Pool({ connectionString: uri, max: 4 });
}

// ---------------- Gate 2 ----------------
async function gate2CheckSchema(pool) {
  const errors = [];
  const tabReports = [];
  const sql = `
    SELECT table_name, MAX(column_count)::int AS column_count
    FROM (
      SELECT table_schema, table_name, COUNT(*)::int AS column_count
        FROM information_schema.columns
       WHERE table_schema = ANY($2::text[])
         AND table_name = ANY($1::text[])
    GROUP BY table_schema, table_name
    ) s
   GROUP BY table_name`;
  const names = REQUIRED_TABLES.map((t) => t.name);
  const res = await pool.query(sql, [names, APP_SCHEMAS]);
  const colCounts = new Map(res.rows.map((r) => [r.table_name, Number(r.column_count)]));
  for (const tab of REQUIRED_TABLES) {
    const have = colCounts.get(tab.name) ?? 0;
    if (!have) {
      errors.push(`table missing: ${tab.name}`);
      tabReports.push({ name: tab.name, ok: false, columnCount: 0, expectedAtLeast: tab.minColumns, reason: "missing" });
      continue;
    }
    const ok = have >= tab.minColumns;
    if (!ok) errors.push(`table "${tab.name}" has ${have} columns, expected ≥ ${tab.minColumns}`);
    tabReports.push({ name: tab.name, ok, columnCount: have, expectedAtLeast: tab.minColumns });
  }
  return { ok: errors.length === 0, errors, details: { tabs: tabReports } };
}

// ---------------- Gate 3 ----------------
async function gate3CheckSourcesSeed(pool) {
  const errors = [];
  const res = await pool.query(
    "SELECT source_name FROM sources_config WHERE source_name = ANY($1::text[]) ORDER BY source_name",
    [EXPECTED_SOURCE_NAMES],
  );
  const have = res.rows.map((r) => String(r.source_name));
  const haveSet = new Set(have);
  const missing = EXPECTED_SOURCE_NAMES.filter((n) => !haveSet.has(n));
  if (missing.length) errors.push(`sources_config missing seed source_name(s): ${missing.join(", ")}`);
  const totalRes = await pool.query("SELECT COUNT(*)::int AS n FROM sources_config");
  const rowCount = Number(totalRes.rows[0]?.n ?? 0);
  if (rowCount < 6) errors.push(`sources_config has ${rowCount} rows; expected ≥ 6`);
  return {
    ok: errors.length === 0,
    errors,
    details: { rowCount, sourceNames: have, missing },
  };
}

// ---------------- Gate 6 ----------------
async function gate6CheckPhase3(pool) {
  const errors = [];
  const details = {};
  try {
    const dupRes = await pool.query(
      "SELECT canonical_id, COUNT(*)::int AS n FROM normalized_terms GROUP BY canonical_id HAVING COUNT(*) > 1",
    );
    if (dupRes.rows.length) {
      errors.push(`normalized_terms has ${dupRes.rows.length} duplicate canonical_id values`);
    }
    const ntCount = await pool.query("SELECT COUNT(*)::int AS n FROM normalized_terms");
    details.normalized_terms = {
      rows: Number(ntCount.rows[0].n),
      duplicateCanonicalIds: dupRes.rows.length,
    };

    const evidenceCount = await pool.query("SELECT COUNT(*)::int AS n FROM marketplace_evidence");
    const etsyCount = await pool.query(
      "SELECT COUNT(*)::int AS n FROM marketplace_evidence WHERE source = 'etsy_autocomplete'",
    );
    if (Number(etsyCount.rows[0].n) < 1) {
      errors.push("marketplace_evidence has no rows with source=etsy_autocomplete");
    }
    details.marketplace_evidence = {
      rows: Number(evidenceCount.rows[0].n),
      etsyRows: Number(etsyCount.rows[0].n),
    };

    const trendCount = await pool.query("SELECT COUNT(*)::int AS n FROM trend_scores");
    const trendRows = Number(trendCount.rows[0].n);
    if (!trendRows) {
      errors.push("trend_scores has no data rows");
      details.trend_scores = { rows: 0 };
    } else {
      const latestRes = await pool.query(
        "SELECT TO_CHAR((SELECT MAX(run_date) FROM trend_scores), 'YYYY-MM-DD') AS latest",
      );
      const latestRunDate = String(latestRes.rows[0]?.latest || "").trim();

      const decisionRes = await pool.query(
        "SELECT COUNT(*)::int AS n FROM trend_scores WHERE run_date = $1::date AND decision IN ('design_now','review_required','watchlist')",
        [latestRunDate],
      );
      const decisionHits = Number(decisionRes.rows[0].n);
      if (decisionHits < 1) {
        errors.push(
          `trend_scores latest run (${latestRunDate}) has no decision in {design_now, review_required, watchlist}`,
        );
      }

      const layer2ScoreRes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM opportunity_score WHERE scoring_run_id IN (
           SELECT scoring_run_id FROM scoring_runs
            WHERE status = 'success' AND finished_at >= NOW() - INTERVAL '2 days'
         )`,
      );
      const layer2Scores = Number(layer2ScoreRes.rows[0]?.n || 0);
      if (layer2Scores < 1) {
        errors.push(
          "Layer 2: no opportunity_score rows linked to a successful scoring_run in the last 2 days",
        );
      }
      const latestRowsRes = await pool.query(
        "SELECT COUNT(*)::int AS n FROM trend_scores WHERE run_date = $1::date",
        [latestRunDate],
      );
      const latestRows = Number(latestRowsRes.rows[0].n);
      if (!latestRows) errors.push(`trend_scores has no rows for latest run_date ${latestRunDate}`);
      details.trend_scores = {
        rows: trendRows,
        latestRunDate,
        latestRows,
        decisionHits,
        layer2ScoresLast2d: layer2Scores,
      };
    }

    const watchRes = await pool.query("SELECT COUNT(*)::int AS n FROM watchlist");
    const watchRows = Number(watchRes.rows[0].n);
    const watchScoreRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM trend_scores
        WHERE run_date = (SELECT MAX(run_date) FROM trend_scores) AND decision = 'watchlist'`,
    );
    const watchlistDecisions = Number(watchScoreRes.rows[0].n);
    const watchlistConfigured = watchRows > 0 || watchlistDecisions > 0;
    details.watchlist = {
      rows: watchRows,
      trendScoresWatchlistDecisions: watchlistDecisions,
      configured: watchlistConfigured,
    };
    if (!watchlistConfigured) {
      details.watchlist.warning =
        "watchlist inactive (0 rows and no trend_scores watchlist decisions on latest run)";
    }
  } catch (e) {
    errors.push(`Phase 3 gate check failed: ${e.message}`);
  }
  return { ok: errors.length === 0, errors, details };
}

// ---------------- Gate 7 / 8 (Layer 2 infra) ----------------
async function gate7CheckOutboxHealth(pool) {
  const errors = [];
  const details = {};
  try {
    const dl = await pool.query(
      "SELECT COUNT(*)::int AS n FROM workflow_outbox WHERE status = 'deadletter'",
    );
    details.deadletter = Number(dl.rows[0]?.n || 0);
    if (details.deadletter > 500) {
      errors.push(`workflow_outbox deadletter count ${details.deadletter} exceeds threshold`);
    }
    const oldProc = await pool.query(
      `SELECT COUNT(*)::int AS n FROM workflow_outbox WHERE status = 'processing' AND scheduled_at < NOW() - INTERVAL '30 minutes'`,
    );
    details.staleProcessing = Number(oldProc.rows[0]?.n || 0);
    if (details.staleProcessing > 0) {
      errors.push(`workflow_outbox has ${details.staleProcessing} stale processing rows (>30m)`);
    }
  } catch (e) {
    errors.push(`Gate 7 failed: ${e.message}`);
  }
  return { ok: errors.length === 0, errors, details };
}

async function gate8CheckCanonicalSignalContract(pool) {
  const errors = [];
  const details = {};
  try {
    const { validateCanonicalSignal } = await import(path.join(repoRoot, "db", "contract_validator.mjs"));
    const sample = await pool.query("SELECT * FROM canonical_signals LIMIT 50");
    let bad = 0;
    for (const row of sample.rows) {
      const r = validateCanonicalSignal(row);
      if (!r.ok) bad++;
    }
    details.sampled = sample.rows.length;
    details.invalid = bad;
    if (sample.rows.length && bad === sample.rows.length) {
      errors.push("canonical_signals sample failed contract validation (all rows)");
    }
  } catch (e) {
    if (!String(e.message || e).includes("does not exist")) {
      errors.push(`Gate 8 failed: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors, details };
}

/** Optional — GET /opportunities against local Layer 2 API (requires api running). */
async function gate9CheckLayer2Api() {
  const errors = [];
  const details = {};
  const token = (process.env.LAYER2_API_TOKEN || "").trim();
  const port = Number(process.env.LAYER2_API_PORT || 3847);
  if (!token) {
    return { ok: true, skipped: true, errors: [], details: { reason: "LAYER2_API_TOKEN unset" } };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/opportunities?status=approved_for_creative`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    details.status = res.status;
    if (!res.ok) {
      errors.push(`Gate 9: Layer 2 API returned HTTP ${res.status} (is api:start running on ${port}?)`);
    }
  } catch (e) {
    errors.push(`Gate 9: ${e.message}`);
  }
  return { ok: errors.length === 0, errors, details };
}

// ---------------- Gate 4 ----------------
async function listAllWorkflows(base) {
  const out = [];
  let cursor = null;
  for (;;) {
    const q = new URLSearchParams({ limit: "250" });
    if (cursor) q.set("cursor", cursor);
    const data = await fetchJson(`${base}/api/v1/workflows?${q}`, { headers: n8nHeaders() });
    const batch = data?.data ?? data;
    if (!Array.isArray(batch)) break;
    out.push(...batch);
    if (!data?.nextCursor) break;
    cursor = data.nextCursor;
  }
  return out;
}

function pickWorkflowByName(workflows, name) {
  const matches = workflows.filter((w) => w?.name === name);
  if (matches.length === 0) return { wf: null, warning: null };
  if (matches.length === 1) return { wf: matches[0], warning: null };
  const sorted = [...matches].sort((a, b) => (b.nodes?.length || 0) - (a.nodes?.length || 0));
  return {
    wf: sorted[0],
    warning: `multiple workflows named "${name}"; using id ${sorted[0].id} (${sorted[0].nodes?.length || 0} nodes)`,
  };
}

async function gate4CheckWorkflowsActive(base) {
  const errors = [];
  const warnings = [];
  let workflows;
  try {
    workflows = await listAllWorkflows(base);
  } catch (e) {
    return { ok: false, errors: [`n8n API call failed: ${e.message}`], details: {}, workflowMap: new Map() };
  }
  const map = new Map();
  const reports = [];
  for (const name of REQUIRED_WORKFLOWS) {
    const { wf, warning } = pickWorkflowByName(workflows, name);
    if (warning) warnings.push(warning);
    if (!wf) {
      errors.push(`workflow not found on instance: ${name}`);
      reports.push({ name, ok: false, reason: "not found" });
      continue;
    }
    map.set(name, wf);
    if (!wf.active) errors.push(`workflow "${name}" is not active`);
    reports.push({ name, id: wf.id, active: !!wf.active, nodeCount: wf.nodes?.length || 0 });
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    details: { workflows: reports, total: workflows.length },
    workflowMap: map,
  };
}

// ---------------- Gate 5 ----------------
async function getWorkflowRunsRowCount(pool) {
  const res = await pool.query("SELECT COUNT(*)::int AS n FROM workflow_runs");
  return Number(res.rows[0].n);
}

async function executeWorkflow(base, id) {
  const executeUrl = `${base}/api/v1/workflows/${encodeURIComponent(id)}/execute`;
  const restUrl = `${base}/rest/workflows/${encodeURIComponent(id)}/run`;
  const bodyRest = JSON.stringify({ workflowId: id });

  /**
   * 1) POST /api/v1/workflows/{id}/execute — public API (API key + workflow:execute).
   * 2) POST /rest/workflows/{id}/run — Editor route; needs session cookie (+ often browser-id), not API key alone.
   * Do not use POST /api/v1/workflows/{id}/run (not in OpenAPI; typically 405).
   */
  let executeErr;
  try {
    return await fetchJson(executeUrl, {
      method: "POST",
      body: "{}",
      headers: n8nHeadersJson(),
    });
  } catch (e) {
    executeErr = e;
    const st = e.status;
    if (st === 401 || st === 403) throw e;
    if (st !== 404 && st !== 405) throw e;
  }

  try {
    return await fetchJson(restUrl, {
      method: "POST",
      body: bodyRest,
      headers: n8nRestRunHeaders(),
    });
  } catch (restErr) {
    const exSt = executeErr?.status;
    const restSt = restErr.status;
    const mcpUrl = (process.env.N8N_MCP_URL || "").trim();
    const mcpTok = (process.env.N8N_MCP_TOKEN || "").trim();
    if (mcpUrl && mcpTok) {
      try {
        const mcpOut = await mcpToolsCall("execute_workflow", {
          workflowId: id,
          executionMode: "manual",
        });
        if (mcpOut && typeof mcpOut === "object" && mcpOut.status === "error") {
          throw new Error(String(mcpOut.error || "MCP execute_workflow reported status error"));
        }
        return mcpOut;
      } catch (mcpErr) {
        throw new Error(
          `Gate 5 execute: public POST .../execute → HTTP ${exSt ?? "?"}. `
            + `REST .../run → HTTP ${restSt ?? "?"}. `
            + `MCP execute_workflow → ${mcpErr.message}`,
        );
      }
    }

    const hasRestSession =
      !!(process.env.N8N_SESSION_COOKIE || "").trim()
      || !!(process.env.N8N_AUTH_COOKIE || "").trim();
    const hasBrowserId =
      !!(process.env.N8N_BROWSER_ID || "").trim()
      || !!(process.env.N8N_MCP_BROWSER_ID || "").trim();
    const msg =
      `Gate 5 execute: public POST /api/v1/workflows/{id}/execute → HTTP ${exSt ?? "?"}. `
      + `Fallback POST /rest/workflows/{id}/run → HTTP ${restSt ?? "?"}. `
      + "The public execute endpoint is missing or blocked on this n8n build, and REST run "
      + "requires the Editor session Cookie plus matching browser-id header (not the public API key). "
      + (hasRestSession && !hasBrowserId
        ? "Set N8N_BROWSER_ID or N8N_MCP_BROWSER_ID to the browser-id header value from DevTools → Network on POST …/rest/workflows/…/run (same click as Execute workflow). "
        : hasRestSession
          ? "Session-related env is set but request still failed — re-copy a fresh n8n-auth value and matching browser-id after logging in again. "
          : "Set N8N_MCP_URL and N8N_MCP_TOKEN for MCP execute_workflow, or add N8N_AUTH_COOKIE (n8n-auth JWT) and N8N_BROWSER_ID from DevTools → Network, "
            + "or upgrade n8n to a version with POST /api/v1/workflows/{id}/execute. ")
      + "Or run: npm run n8n:phase1-gate -- --skip-trigger";
    throw new Error(`${msg} (${restErr.message})`);
  }
}

async function pollExecution(base, executionId) {
  const url = `${base}/api/v1/executions/${encodeURIComponent(executionId)}?includeData=false`;
  const start = Date.now();
  while (Date.now() - start < EXEC_POLL_TIMEOUT_MS) {
    let data;
    try { data = await fetchJson(url, { headers: n8nHeaders() }); }
    catch (_e) { await sleep(EXEC_POLL_INTERVAL_MS); continue; }
    if (data?.finished === true || data?.stoppedAt || data?.status) {
      const status = data?.status || (data?.finished ? "success" : "unknown");
      const finished = !!(data?.finished || data?.stoppedAt);
      if (finished) return { ok: status === "success", status, raw: data };
    }
    await sleep(EXEC_POLL_INTERVAL_MS);
  }
  return { ok: false, status: "timeout", raw: null };
}

async function gate5TriggerAndVerify(base, workflowMap, pool) {
  const errors = [];
  const perWorkflow = [];

  for (const name of REQUIRED_WORKFLOWS) {
    const wf = workflowMap.get(name);
    if (!wf) {
      errors.push(`skip "${name}" — not present (gate 4 failure)`);
      perWorkflow.push({ name, ok: false, reason: "not present on instance" });
      continue;
    }

    let beforeCount;
    try { beforeCount = await getWorkflowRunsRowCount(pool); }
    catch (e) {
      errors.push(`workflow_runs read (before) failed for "${name}": ${e.message}`);
      perWorkflow.push({ name, ok: false, reason: `pre-read failed: ${e.message}` });
      continue;
    }

    let exec;
    try { exec = await executeWorkflow(base, wf.id); }
    catch (e) {
      errors.push(`execute failed for "${name}": ${e.message}`);
      perWorkflow.push({ name, ok: false, reason: `execute: ${e.message}`, beforeCount });
      continue;
    }
    const executionId = exec?.executionId ?? exec?.data?.executionId ?? exec?.id;
    if (!executionId) {
      errors.push(`no executionId returned for "${name}"`);
      perWorkflow.push({ name, ok: false, reason: "no executionId in response", beforeCount });
      continue;
    }

    const polled = await pollExecution(base, executionId);
    if (!polled.ok) {
      errors.push(`execution for "${name}" did not finish successfully (status=${polled.status})`);
    }

    let afterCount;
    try { afterCount = await getWorkflowRunsRowCount(pool); }
    catch (e) {
      errors.push(`workflow_runs read (after) failed for "${name}": ${e.message}`);
      perWorkflow.push({
        name, ok: false, reason: `post-read failed: ${e.message}`,
        beforeCount, executionId, executionStatus: polled.status,
      });
      continue;
    }

    const delta = afterCount - beforeCount;
    const okRow = delta >= 1;
    if (!okRow) {
      errors.push(`workflow_runs did not grow after triggering "${name}" (before=${beforeCount}, after=${afterCount})`);
    }

    perWorkflow.push({
      name, ok: okRow && polled.ok, executionId, executionStatus: polled.status,
      beforeCount, afterCount, delta,
    });
  }

  return { ok: errors.length === 0, errors, details: { perWorkflow } };
}

// ---------------- Reporting ----------------
function summarizeHuman(report) {
  const lines = [];
  lines.push(`Phase 1 gate — instance: ${report.env.N8N_BASE_URL}, db: ${report.env.DATABASE}`);
  lines.push("");
  for (const g of report.gates) {
    const head = g.ok ? `[PASS] Gate ${g.id}: ${g.name}` : `[FAIL] Gate ${g.id}: ${g.name}`;
    lines.push(head);
    if (g.skipped) lines.push("  skipped");
    for (const e of g.errors || []) lines.push(`  ERROR: ${e}`);
    for (const w of g.warnings || []) lines.push(`  WARN:  ${w}`);
    if (g.details?.tabs) {
      for (const t of g.details.tabs) {
        const status = t.ok ? "ok" : "fail";
        lines.push(`    - ${t.name}: ${status} (columns=${t.columnCount}/${t.expectedAtLeast})`);
      }
    }
    if (g.details?.workflows) {
      for (const w of g.details.workflows) {
        const a = w.active === true ? "active" : w.active === false ? "inactive" : "missing";
        lines.push(`    - ${w.name}: ${a}${w.id ? ` (id=${w.id}, nodes=${w.nodeCount})` : ""}`);
      }
    }
    if (g.details?.perWorkflow) {
      for (const w of g.details.perWorkflow) {
        if (w.ok) {
          lines.push(`    - ${w.name}: PASS (exec=${w.executionId} status=${w.executionStatus}, rows ${w.beforeCount} → ${w.afterCount})`);
        } else {
          lines.push(`    - ${w.name}: FAIL (${w.reason || `status=${w.executionStatus}, rows ${w.beforeCount} → ${w.afterCount}`})`);
        }
      }
    }
    if (g.details?.sourceNames) {
      lines.push(`    sources_config rows: ${g.details.rowCount}`);
      if (g.details.missing?.length) lines.push(`    missing: ${g.details.missing.join(", ")}`);
    }
    if (g.details?.normalized_terms) {
      lines.push(`    normalized_terms rows: ${g.details.normalized_terms.rows}, duplicate canonical_id: ${g.details.normalized_terms.duplicateCanonicalIds}`);
    }
    if (g.details?.marketplace_evidence) {
      lines.push(`    marketplace_evidence rows: ${g.details.marketplace_evidence.rows}, etsy rows: ${g.details.marketplace_evidence.etsyRows}`);
    }
    if (g.details?.trend_scores) {
      const t = g.details.trend_scores;
      lines.push(
        `    trend_scores rows: ${t.rows}${t.latestRunDate ? `, latest=${t.latestRunDate}, decision hits=${t.decisionHits}, parity=${t.parityCompared - t.parityMismatches}/${t.parityCompared}` : ""}`,
      );
    }
    if (g.details?.watchlist) lines.push(`    watchlist rows: ${g.details.watchlist.rows}`);
    lines.push("");
  }
  lines.push(report.ok ? "OVERALL: PASS" : "OVERALL: FAIL");
  return lines.join("\n");
}

// ---------------- Main ----------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(path.join(repoRoot, ".env"));
  loadDotEnv(path.join(repoRoot, ".env.postgres"));

  const base = n8nBase();
  const apiKey = (process.env.N8N_API_KEY || "").trim();
  const dbUri = (process.env.DATABASE_URI_ADMIN || process.env.DATABASE_URI || "").trim();

  const envErrors = [];
  if (!base) envErrors.push("missing N8N_BASE_URL or N8N_API_URL");
  if (!apiKey) envErrors.push("missing N8N_API_KEY");
  if (!dbUri) envErrors.push("missing DATABASE_URI (Postgres app role)");
  if (envErrors.length) {
    const msg = "Phase 1 gate cannot run — environment incomplete:\n  - " + envErrors.join("\n  - ");
    if (args.json) {
      console.log(JSON.stringify({ ok: false, env: { N8N_BASE_URL: base }, errors: envErrors, gates: [] }, null, 2));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  let dbName = "?";
  try {
    const m = dbUri.match(/^postgres(?:ql)?:\/\/[^/]+\/([^?]+)/);
    if (m) dbName = m[1];
  } catch (_e) { /* keep default */ }

  const pool = makePool();
  const report = {
    ok: true,
    env: { N8N_BASE_URL: base, DATABASE: dbName },
    gates: [],
  };

  try {
    const g2 = await gate2CheckSchema(pool);
    report.gates.push({ id: 2, name: "required tables exist with expected column count", ...g2 });

    const g3 = await gate3CheckSourcesSeed(pool);
    report.gates.push({ id: 3, name: "sources_config has 6 seed rows", ...g3 });

    const g1 = {
      ok: g2.ok && g3.ok,
      errors: g2.ok && g3.ok ? [] : ["derived from gates 2 + 3 — see their failures above"],
      details: { derivedFrom: ["gate2", "gate3"] },
    };
    report.gates.push({ id: 1, name: "Postgres migrations applied (derived)", ...g1 });

    const g4 = await gate4CheckWorkflowsActive(base);
    report.gates.push({
      id: 4, name: "required workflows imported and active",
      ok: g4.ok, errors: g4.errors, warnings: g4.warnings, details: g4.details,
    });

    if (args.skipTrigger) {
      report.gates.push({
        id: 5, name: "manual trigger writes a row to workflow_runs",
        ok: true, skipped: true, errors: [], details: {},
      });
    } else if (!g4.ok) {
      report.gates.push({
        id: 5, name: "manual trigger writes a row to workflow_runs",
        ok: false, errors: ["skipped — gate 4 failed; cannot trigger workflows safely"], details: {},
      });
    } else {
      const g5 = await gate5TriggerAndVerify(base, g4.workflowMap, pool);
      report.gates.push({ id: 5, name: "manual trigger writes a row to workflow_runs", ...g5 });
    }

    if (args.skipPhase3) {
      report.gates.push({
        id: 6,
        name: "Phase 3 data acceptance criteria",
        ok: true,
        skipped: true,
        errors: [],
        details: {},
      });
    } else {
      const g6 = await gate6CheckPhase3(pool);
      report.gates.push({ id: 6, name: "Phase 3 data acceptance criteria", ...g6 });
    }

    const g7 = await gate7CheckOutboxHealth(pool);
    report.gates.push({ id: 7, name: "workflow_outbox health", ...g7 });
    const g8 = await gate8CheckCanonicalSignalContract(pool);
    report.gates.push({ id: 8, name: "canonical_signals contract sample", ...g8 });

    if (args.gate9) {
      const g9 = await gate9CheckLayer2Api();
      report.gates.push({ id: 9, name: "Layer 2 HTTP API (optional)", ...g9 });
    }
  } finally {
    await pool.end();
  }

  for (const g of report.gates) {
    if (!g.ok && !g.skipped) report.ok = false;
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(summarizeHuman(report));
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
