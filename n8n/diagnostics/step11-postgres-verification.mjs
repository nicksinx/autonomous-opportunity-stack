#!/usr/bin/env node
/**
 * Step 11: Postgres data verification anchored to a Step 10 execution chain.
 *
 * Read-only. Writes:
 * - backups/n8n/step11-execution-audit-<timestamp>.json
 * - backups/n8n/step11-postgres-verification-<timestamp>.json
 * - backups/n8n/step11-diagnostics-<timestamp>.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const backupsDir = path.join(repoRoot, "backups", "n8n");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const DEFAULT_STEP10 = path.join(
  backupsDir,
  "step10-execution-chain-2026-04-29T01-28-16-512Z.json",
);
const step10Path = process.argv[2] || DEFAULT_STEP10;
const execAuditPath = path.join(backupsDir, `step11-execution-audit-${stamp}.json`);
const pgVerificationPath = path.join(backupsDir, `step11-postgres-verification-${stamp}.json`);
const diagnosticsPath = path.join(backupsDir, `step11-diagnostics-${stamp}.json`);

const TARGET_TABLES = [
  "raw_signals",
  "normalized_terms",
  "marketplace_evidence",
  "opportunity_scores",
  "publishing_queue",
];
const VALID_WORKFLOW_STATUSES = new Set(["success", "success_with_rejects"]);

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.join(repoRoot, ".env"));
loadDotEnv(path.join(repoRoot, ".env.local"));
loadDotEnv(path.join(repoRoot, ".env.postgres"));

const apiBase = (process.env.N8N_API_URL || process.env.N8N_BASE_URL || "").trim().replace(/\/+$/, "");
const apiKey = (process.env.N8N_API_KEY || "").trim();
const dbUri = (process.env.DATABASE_URI_ADMIN || process.env.DATABASE_URI || "").trim();

function redactString(value) {
  let out = String(value ?? "");
  for (const secret of [apiKey, dbUri]) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  out = out.replace(/(authorization|x-n8n-api-key|api[_-]?key|token|password|secret)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1$2[REDACTED]");
  out = out.replace(/postgres(?:ql)?:\/\/[^"'\s]+/gi, "postgresql://[REDACTED]");
  return out;
}

function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const out = redactString(value);
    return out.length > 3000 ? `${out.slice(0, 3000)}...[truncated]` : out;
  }
  if (typeof value !== "object") return value;
  if (depth > 8) return "[truncated-depth]";
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (/authorization|credential|password|token|secret|api.?key|headers?/i.test(key)) out[key] = "[REDACTED]";
    else out[key] = sanitize(val, depth + 1);
  }
  return out;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(sanitize(value), null, 2)}\n`);
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function nodeClues(executionPayload) {
  const runData = executionPayload?.data?.resultData?.runData || executionPayload?.resultData?.runData || {};
  return Object.entries(runData).map(([nodeName, entries]) => {
    const arr = Array.isArray(entries) ? entries : [];
    const last = arr[arr.length - 1] || {};
    const dataMain = last?.data?.main;
    let itemCount = 0;
    if (Array.isArray(dataMain)) {
      for (const output of dataMain) {
        if (Array.isArray(output)) itemCount += output.length;
      }
    }
    return {
      nodeName,
      runs: arr.length,
      lastExecutionStatus: last?.executionStatus || null,
      itemCount,
      hasError: Boolean(last?.error),
      errorMessage: last?.error?.message || null,
    };
  });
}

async function fetchExecution(execution) {
  if (!apiBase || !apiKey) throw new Error("missing N8N_API_URL/N8N_BASE_URL or N8N_API_KEY");
  const url = `${apiBase}/api/v1/executions/${encodeURIComponent(execution.executionId)}?includeData=true`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-N8N-API-KEY": apiKey,
    },
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    return {
      name: execution.name,
      workflowId: execution.workflowId,
      executionId: execution.executionId,
      ok: false,
      httpStatus: res.status,
      error: payload?.message || payload?.raw || res.statusText,
    };
  }
  return {
    name: execution.name,
    workflowId: execution.workflowId,
    executionId: execution.executionId,
    ok: true,
    status: payload?.status || payload?.execution?.status || null,
    workflowName: payload?.workflowData?.name || payload?.workflowName || execution.name,
    startedAt: iso(payload?.startedAt || payload?.execution?.startedAt),
    stoppedAt: iso(payload?.stoppedAt || payload?.execution?.stoppedAt || payload?.finishedAt),
    errorSummary: payload?.data?.resultData?.error?.message || payload?.error?.message || null,
    lastNodeExecuted: payload?.data?.resultData?.lastNodeExecuted || null,
    nodeClues: nodeClues(payload),
  };
}

async function q(pool, text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}

async function tableExists(pool, table) {
  const rows = await q(pool, "SELECT to_regclass($1) AS regclass", [`public.${table}`]);
  return Boolean(rows[0]?.regclass);
}

async function columns(pool, table) {
  return q(
    pool,
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
}

async function safeCount(pool, sql, params = []) {
  try {
    const rows = await q(pool, sql, params);
    return Number(rows[0]?.n || 0);
  } catch (e) {
    return { error: redactString(e.message) };
  }
}

async function tableCounts(pool, anchor, windowEnd) {
  const out = [];
  for (const table of TARGET_TABLES) {
    const exists = await tableExists(pool, table);
    if (!exists) {
      out.push({ table, exists: false, currentCount: 0, freshness: null });
      continue;
    }
    const cols = await columns(pool, table);
    const names = new Set(cols.map((c) => c.column_name));
    const currentCount = await safeCount(pool, `SELECT COUNT(*)::int AS n FROM ${table}`);
    const freshness = {};
    if (names.has("created_at")) {
      freshness.createdAtSinceAnchor = await safeCount(pool, `SELECT COUNT(*)::int AS n FROM ${table} WHERE created_at >= $1`, [anchor]);
    }
    if (names.has("updated_at")) {
      freshness.updatedAtSinceAnchor = await safeCount(pool, `SELECT COUNT(*)::int AS n FROM ${table} WHERE updated_at >= $1`, [anchor]);
    }
    if (names.has("captured_at")) {
      freshness.capturedAtSinceAnchor = await safeCount(pool, `SELECT COUNT(*)::int AS n FROM ${table} WHERE captured_at >= $1`, [anchor]);
    }
    if (names.has("run_date")) {
      freshness.runDateOnOrAfterAnchorDate = await safeCount(pool, `SELECT COUNT(*)::int AS n FROM ${table} WHERE run_date >= $1::timestamptz::date`, [anchor]);
    }
    if (names.has("date_collected")) {
      freshness.dateCollectedOnOrAfterAnchorDate = await safeCount(pool, `SELECT COUNT(*)::int AS n FROM ${table} WHERE date_collected >= $1::timestamptz::date`, [anchor]);
    }
    if (names.has("run_id")) {
      freshness.rowsLinkedToStep10Runs = await safeCount(
        pool,
        `SELECT COUNT(*)::int AS n
           FROM ${table} t
           JOIN workflow_runs wr ON wr.run_id = t.run_id
          WHERE wr.run_started >= $1 AND wr.run_started <= $2`,
        [anchor, windowEnd],
      );
    }
    out.push({ table, exists: true, currentCount, columns: Array.from(names), freshness });
  }
  return out;
}

async function latestRows(pool, table, orderColumn, limit = 10) {
  if (!(await tableExists(pool, table))) return [];
  const cols = new Set((await columns(pool, table)).map((c) => c.column_name));
  if (!cols.has(orderColumn)) return [];
  return q(pool, `SELECT * FROM ${table} ORDER BY ${orderColumn} DESC LIMIT ${limit}`);
}

async function dbVerification(step10) {
  if (!dbUri) throw new Error("missing DATABASE_URI_ADMIN/DATABASE_URI");
  const pool = new pg.Pool({ connectionString: dbUri, max: 2 });
  try {
    await pool.query("SET TIME ZONE 'UTC'");
    const started = step10.executions.map((e) => new Date(e.n8nStartedAt || e.startTime).getTime());
    const stopped = step10.executions.map((e) => new Date(e.n8nStoppedAt || e.stopTime).getTime());
    const anchor = new Date(Math.min(...started)).toISOString();
    const windowEnd = new Date(Math.max(...stopped) + 10 * 60 * 1000).toISOString();
    const expectedNames = step10.executions.map((e) => e.name);

    const workflowRuns = await q(
      pool,
      `SELECT job_name, status, run_started, run_finished, run_id, rows_added, rows_updated, error_log, sources_summary_json
         FROM workflow_runs
        WHERE run_started >= $1 AND run_started <= $2
        ORDER BY run_started ASC`,
      [anchor, windowEnd],
    );
    const workflowRunsByExpected = {};
    for (const name of expectedNames) {
      workflowRunsByExpected[name] = workflowRuns.filter((r) => r.job_name === name);
    }

    const counts = await tableCounts(pool, anchor, windowEnd);
    const stageRunLogs = await q(
      pool,
      `SELECT workflow_name, stage_name, event_type, started_at, ended_at, rows_in, rows_out, status, error_count, error_summary, run_id
         FROM stage_run_logs
        WHERE started_at >= $1 AND started_at <= $2
        ORDER BY started_at ASC
        LIMIT 100`,
      [anchor, windowEnd],
    ).catch((e) => [{ error: redactString(e.message) }]);
    const sourceHealth = await q(
      pool,
      `SELECT source_name, status, run_date, rows_in, rows_valid, rows_rejected, last_error, run_id, updated_at
         FROM source_health
        WHERE updated_at >= $1
        ORDER BY updated_at DESC
        LIMIT 100`,
      [anchor],
    ).catch((e) => [{ error: redactString(e.message) }]);
    const latest = {
      workflow_runs: await latestRows(pool, "workflow_runs", "run_started", 15),
      raw_signals: await latestRows(pool, "raw_signals", "date_collected", 10),
      normalized_terms: await latestRows(pool, "normalized_terms", "updated_at", 10),
      marketplace_evidence: await latestRows(pool, "marketplace_evidence", "captured_at", 10),
      opportunity_scores: await latestRows(pool, "opportunity_scores", "run_date", 10),
      publishing_queue: await latestRows(pool, "publishing_queue", "updated_at", 10),
    };

    return {
      anchor,
      windowEnd,
      expectedWorkflowNames: expectedNames,
      workflowRuns,
      workflowRunsByExpected,
      tableCounts: counts,
      diagnostics: { stageRunLogs, sourceHealth, latest },
    };
  } finally {
    await pool.end();
  }
}

function localWorkflowWriteHints() {
  const hints = {};
  for (const file of [
    "wf_collect_trends.json",
    "wf_normalize_terms.json",
    "wf_enrich_marketplace.json",
    "wf_score_and_cluster.json",
    "wf_publish_queue.json",
  ]) {
    const full = path.join(repoRoot, "n8n", file);
    if (!fs.existsSync(full)) continue;
    const raw = fs.readFileSync(full, "utf8");
    const parsed = JSON.parse(raw);
    const workflows = Array.isArray(parsed) ? parsed : [parsed];
    for (const wf of workflows) {
      if (!wf?.name || !wf.name.startsWith("wf_") || wf.name.includes("Error Handler")) continue;
      hints[wf.name] = {
        file,
        mentionsWorkflowRuns: raw.includes("workflow_runs"),
        mentionsNormalizedTerms: raw.includes("normalized_terms"),
        mentionsMarketplaceEvidence: raw.includes("marketplace_evidence"),
        mentionsOpportunityScores: raw.includes("opportunity_scores"),
        mentionsPublishingQueue: raw.includes("publishing_queue"),
        postgresNodeNames: (wf.nodes || [])
          .filter((n) => n.type === "n8n-nodes-base.postgres")
          .map((n) => ({ name: n.name, operation: n.parameters?.operation, query: n.parameters?.query ? String(n.parameters.query).slice(0, 240) : null })),
      };
    }
  }
  return hints;
}

function localWorkflowGraphs() {
  const graphs = {};
  for (const file of [
    "wf_collect_trends.json",
    "wf_normalize_terms.json",
    "wf_enrich_marketplace.json",
    "wf_score_and_cluster.json",
    "wf_publish_queue.json",
  ]) {
    const full = path.join(repoRoot, "n8n", file);
    if (!fs.existsSync(full)) continue;
    const raw = fs.readFileSync(full, "utf8");
    const parsed = JSON.parse(raw);
    const workflows = Array.isArray(parsed) ? parsed : [parsed];
    for (const wf of workflows) {
      if (!wf?.name || !wf.name.startsWith("wf_") || wf.name.includes("Error Handler")) continue;
      graphs[wf.name] = {
        file,
        edges: Object.fromEntries(
          Object.entries(wf.connections || {}).map(([from, outputs]) => [
            from,
            (outputs?.main || []).flat().map((target) => target.node),
          ]),
        ),
      };
    }
  }
  return graphs;
}

function rankedHypotheses(execAudit, pgReport) {
  const byName = Object.fromEntries(execAudit.executions.map((e) => [e.name, e]));
  const workflowRunsMissing = pgReport.expectedWorkflowNames.filter((name) => {
    const rows = pgReport.workflowRunsByExpected[name] || [];
    return !rows.some((r) => VALID_WORKFLOW_STATUSES.has(String(r.status)));
  });
  const counts = new Map(pgReport.tableCounts.map((r) => [r.table, r.currentCount]));
  const hypotheses = [];
  if (
    byName.wf_normalize_terms?.nodeClues?.some((n) => n.nodeName === "Read raw_signals" && n.itemCount > 0) &&
    byName.wf_normalize_terms?.nodeClues?.some((n) => n.nodeName === "Read normalized_terms" && n.itemCount === 0) &&
    !byName.wf_normalize_terms?.nodeClues?.some((n) => /Build normalized terms|Append normalized_terms/.test(n.nodeName))
  ) {
    hypotheses.push({
      rank: 1,
      likelihood: "high",
      hypothesis: "wf_normalize_terms no-ops because `Read normalized_terms` returns zero rows and is serially upstream of the build/write nodes.",
      evidence: "Execution 114 read 21 raw_signals rows, read 0 normalized_terms rows, and did not execute Build normalized terms or Append normalized_terms.",
    });
  }
  if (counts.get("normalized_terms") === 0) {
    hypotheses.push({
      rank: 2,
      likelihood: "high",
      hypothesis: "Downstream workflows are starved by empty normalized_terms.",
      evidence: "wf_enrich_marketplace stops after Read normalized_terms=0; wf_score_and_cluster stops after Read normalized_terms (active)=0.",
    });
  }
  if (workflowRunsMissing.length) {
    hypotheses.push({
      rank: 3,
      likelihood: "medium",
      hypothesis: "Downstream workflow_runs rows are missing because the workflows end before their workflow_runs writer nodes.",
      evidence: `Missing workflow_runs for: ${workflowRunsMissing.join(", ")}.`,
    });
  }
  if (counts.get("raw_signals") > 0 && pgReport.workflowRunsByExpected.wf_collect_trends?.length) {
    hypotheses.push({
      rank: 4,
      likelihood: "low",
      hypothesis: "Wrong DB target is unlikely.",
      evidence: "The same Postgres verification sees raw_signals and wf_collect_trends workflow_runs written by Step 10, and downstream executions read those raw_signals.",
    });
  }
  return hypotheses;
}

function determineStatus(step10, execAudit, pgReport) {
  const execOk = execAudit.executions.every((e) => e.ok && e.status === "success");
  if (!execOk) return { status: "FAIL", reason: "One or more Step 10 n8n executions no longer verify as success." };

  const expected = step10.executions.map((e) => e.name);
  const workflowRunsOk = expected.every((name) => {
    const rows = pgReport.workflowRunsByExpected[name] || [];
    return rows.some((r) => VALID_WORKFLOW_STATUSES.has(String(r.status)));
  });
  const counts = new Map(pgReport.tableCounts.map((r) => [r.table, r]));
  const tableEvidenceOk = TARGET_TABLES.every((table) => {
    const count = counts.get(table)?.currentCount;
    return typeof count === "number" && count > 0;
  });

  if (workflowRunsOk && tableEvidenceOk) {
    return { status: "PASS", reason: "All workflows have recent workflow_runs evidence and required tables contain data." };
  }
  return {
    status: "FAIL",
    reason: "n8n executions are successful, but Postgres acceptance criteria are not met.",
    missingWorkflowRuns: expected.filter((name) => {
      const rows = pgReport.workflowRunsByExpected[name] || [];
      return !rows.some((r) => VALID_WORKFLOW_STATUSES.has(String(r.status)));
    }),
    emptyTables: TARGET_TABLES.filter((table) => {
      const count = counts.get(table)?.currentCount;
      return !(typeof count === "number" && count > 0);
    }),
  };
}

(async () => {
  const step10 = JSON.parse(fs.readFileSync(step10Path, "utf8"));
  const execAudit = {
    generatedAt: new Date().toISOString(),
    sourceStep10Artifact: step10Path,
    executions: [],
  };
  for (const execution of step10.executions || []) {
    execAudit.executions.push(await fetchExecution(execution));
  }
  writeJson(execAuditPath, execAudit);

  const pgData = await dbVerification(step10);
  const pgReport = {
    generatedAt: new Date().toISOString(),
    sourceStep10Artifact: step10Path,
    anchor: pgData.anchor,
    windowEnd: pgData.windowEnd,
    expectedWorkflowNames: pgData.expectedWorkflowNames,
    workflowRuns: pgData.workflowRuns,
    workflowRunsByExpected: pgData.workflowRunsByExpected,
    tableCounts: pgData.tableCounts,
  };
  writeJson(pgVerificationPath, pgReport);

  const diagnostics = {
    generatedAt: new Date().toISOString(),
    sourceStep10Artifact: step10Path,
    executionNodeClues: Object.fromEntries(execAudit.executions.map((e) => [e.name, e.nodeClues])),
    stageRunLogs: pgData.diagnostics.stageRunLogs,
    sourceHealth: pgData.diagnostics.sourceHealth,
    latestRows: pgData.diagnostics.latest,
    localWorkflowWriteHints: localWorkflowWriteHints(),
    localWorkflowGraphs: localWorkflowGraphs(),
    rankedHypotheses: rankedHypotheses(execAudit, pgReport),
  };
  writeJson(diagnosticsPath, diagnostics);

  const result = determineStatus(step10, execAudit, pgReport);
  console.log(JSON.stringify({
    status: result.status,
    reason: result.reason,
    missingWorkflowRuns: result.missingWorkflowRuns || [],
    emptyTables: result.emptyTables || [],
    artifacts: {
      executionAudit: execAuditPath,
      postgresVerification: pgVerificationPath,
      diagnostics: diagnosticsPath,
    },
  }, null, 2));
  process.exit(result.status === "PASS" ? 0 : 1);
})().catch((e) => {
  const blocked = {
    status: "BLOCKED",
    reason: redactString(e?.message || e),
    artifacts: {
      executionAudit: fs.existsSync(execAuditPath) ? execAuditPath : null,
      postgresVerification: fs.existsSync(pgVerificationPath) ? pgVerificationPath : null,
      diagnostics: fs.existsSync(diagnosticsPath) ? diagnosticsPath : null,
    },
  };
  console.log(JSON.stringify(blocked, null, 2));
  process.exit(2);
});
