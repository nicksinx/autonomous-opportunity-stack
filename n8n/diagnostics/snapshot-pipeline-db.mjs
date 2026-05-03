#!/usr/bin/env node
/**
 * One-shot counts for practical pipeline verification (stdout JSON).
 * Usage: node n8n/diagnostics/snapshot-pipeline-db.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

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

loadDotEnv(path.join(repoRoot, ".env.postgres"));
loadDotEnv(path.join(repoRoot, ".env"));

const uri = (process.env.DATABASE_URI_ADMIN || process.env.DATABASE_URI || "").trim();
if (!uri) {
  console.error(JSON.stringify({ error: "DATABASE_URI not set" }));
  process.exit(1);
}

const QUERIES = [
  ["raw_signals", "SELECT COUNT(*)::int AS n FROM raw_signals"],
  ["normalized_terms", "SELECT COUNT(*)::int AS n FROM normalized_terms"],
  ["canonical_signals", "SELECT COUNT(*)::int AS n FROM canonical_signals"],
  ["marketplace_evidence", "SELECT COUNT(*)::int AS n FROM marketplace_evidence"],
  ["trend_scores", "SELECT COUNT(*)::int AS n FROM trend_scores"],
  ["opportunity_candidate", "SELECT COUNT(*)::int AS n FROM opportunity_candidate"],
  ["trend_cluster_v2", "SELECT COUNT(*)::int AS n FROM trend_cluster_v2"],
  ["range_briefs", "SELECT COUNT(*)::int AS n FROM range_briefs"],
  ["publishing_queue", "SELECT COUNT(*)::int AS n FROM publishing_queue"],
  ["workflow_runs", "SELECT COUNT(*)::int AS n FROM workflow_runs"],
  [
    "latest_workflow_runs",
    `SELECT job_name, status, rows_added, run_started
     FROM workflow_runs
     ORDER BY run_started DESC
     LIMIT 8`,
  ],
  [
    "raw_signals_by_source_24h",
    `SELECT source, COUNT(*)::int AS n
     FROM raw_signals
     WHERE date_collected >= NOW() - INTERVAL '24 hours'
     GROUP BY source
     ORDER BY n DESC`,
  ],
];

const pool = new pg.Pool({ connectionString: uri, max: 2 });
const out = { at: new Date().toISOString(), counts: {}, latest_workflow_runs: null, raw_signals_by_source_24h: null };

try {
  for (const [key, sql] of QUERIES) {
    const r = await pool.query(sql);
    if (key === "latest_workflow_runs") out.latest_workflow_runs = r.rows;
    else if (key === "raw_signals_by_source_24h") out.raw_signals_by_source_24h = r.rows;
    else out.counts[key] = r.rows[0]?.n ?? r.rows;
  }
  console.log(JSON.stringify(out, null, 2));
} finally {
  await pool.end();
}
