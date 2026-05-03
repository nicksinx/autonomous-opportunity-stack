#!/usr/bin/env node
/**
 * Verify Postgres tables include every column defined in migrations/0001_init.sql.
 *
 * Loads env like check-postgres-credentials.mjs (.env → .env.postgres keys fill gaps).
 *
 * Usage:
 *   node db/check-schema-columns.mjs
 *   node db/check-schema-columns.mjs --json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/** Expected columns per table — must match db/migrations/0001_init.sql */
const EXPECTED = {
  sources_config: [
    "source_name", "enabled", "market", "weight", "pull_frequency", "notes",
  ],
  raw_signals: [
    "signal_id", "date_collected", "source", "market", "term", "related_term",
    "category", "signal_type", "velocity_hint", "url", "raw_payload_json",
  ],
  normalized_terms: [
    "canonical_id", "date_first_seen", "date_last_seen", "canonical_term",
    "aliases", "language", "market", "primary_category", "status",
    "last_scored_at", "latest_opp_id", "latest_opportunity_score", "latest_tier",
    "created_at", "updated_at",
  ],
  marketplace_evidence: [
    "evidence_id", "canonical_id", "source", "phrase", "product_type",
    "intent_type", "evidence_strength", "captured_at",
  ],
  trend_scores: [
    "score_id", "canonical_id", "run_date", "momentum_score", "pod_fit_score",
    "buyer_intent_score", "range_depth_score", "novelty_score", "risk_score",
    "total_score", "decision",
  ],
  theme_clusters: [
    "cluster_id", "run_date", "theme_name", "theme_slug", "parent_theme",
    "theme_summary", "audience", "occasion_type", "seasonality", "product_fit",
    "style_fit", "risk_level", "cluster_score", "term_count", "status",
    "review_notes", "created_at", "updated_at",
  ],
  range_briefs: [
    "brief_id", "cluster_id", "run_date", "range_title", "hero_angle",
    "best_products", "design_directions", "phrase_concepts", "audiences",
    "ip_risk", "status",
  ],
  phrase_bank: [
    "phrase_id", "brief_id", "bucket", "phrase", "target_products",
    "style_hint", "created_at",
  ],
  watchlist: [
    "watch_id", "canonical_id", "reason", "review_after", "notes", "created_at",
  ],
  workflow_runs: [
    "run_id", "run_started", "run_finished", "job_name", "rows_added",
    "rows_updated", "status", "error_log", "sources_summary_json", "stage_log_root_id",
  ],
  opportunity_scores: [
    "opp_id", "canonical_id", "run_date", "niche_keyword", "target_audience",
    "theme", "seasonality_flag", "product_formats", "compliance_risk",
    "demand_score", "competition_score", "conversion_score", "creative_score",
    "margin_score", "ops_score", "catalog_score", "repeat_score", "season_score",
    "raw_weighted_sum", "risk_penalty", "opportunity_score", "tier", "action",
    "scorer_version", "score_notes",
  ],
  score_components: [
    "component_id", "opp_id", "run_date", "dimension", "component_name",
    "raw_value", "normalized_value", "weight", "weighted_contribution", "notes",
  ],
  score_weights: [
    "dimension", "weight", "enabled", "last_updated", "notes", "updated_at",
  ],
  performance_feedback: [
    "feedback_id", "opp_id", "brief_id", "product_sku", "feedback_date",
    "units_sold_30d", "revenue_30d", "gross_margin_pct", "return_rate_pct",
    "ctr_pct", "conversion_rate_pct", "feedback_notes",
  ],
  scoring_audit_log: [
    "audit_id", "run_date", "run_id", "candidates_evaluated", "tier_a_count",
    "tier_b_count", "tier_c_count", "rejected_count", "avg_opportunity_score",
    "top_opportunity", "scorer_version", "notes",
  ],
  normalization_log: [
    "log_id", "run_id", "run_date", "canonical_id", "input_term", "decision_type",
    "confidence", "merged_into", "reason", "created_at",
  ],
  publishing_queue: [
    "queue_id", "idempotency_key", "run_id", "run_week", "cluster_id", "brief_id",
    "status", "attempt_count", "first_enqueued_at", "last_seen_at",
    "source_run_id", "priority", "review_notes", "updated_at",
  ],
  stage_run_logs: [
    "log_id", "run_id", "workflow_name", "stage_name", "event_type",
    "started_at", "ended_at", "duration_ms", "rows_in", "rows_out",
    "error_count", "status", "error_summary", "attempt_number", "parent_log_id",
    "metadata_json",
  ],
  source_health: [
    "health_id", "run_id", "run_date", "source_name", "status", "rows_in",
    "rows_valid", "rows_rejected", "duration_ms", "last_error", "http_status_codes",
    "consecutive_failures", "updated_at",
  ],
  pipeline_locks: [
    "lock_id", "lock_owner", "workflow_name", "stage_name", "target_resource",
    "acquired_at", "lock_expires_at", "released_at", "status", "metadata_json",
  ],
};

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  const fromFile = new Map();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    fromFile.set(key, val);
  }
  for (const [key, val] of fromFile) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

async function main() {
  const jsonOut = process.argv.includes("--json");
  loadDotEnv(path.join(repoRoot, ".env"));
  loadDotEnv(path.join(repoRoot, ".env.postgres"));

  const uri = (process.env.DATABASE_URI_ADMIN || process.env.DATABASE_URI || "").trim();
  if (!uri) {
    console.error("DATABASE_URI or DATABASE_URI_ADMIN must be set");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: uri, max: 2 });
  const tables = Object.keys(EXPECTED);
  const report = { ok: true, database: null, tables: [] };

  try {
    const dbRes = await pool.query("SELECT current_database() AS db");
    report.database = dbRes.rows[0]?.db;

    for (const table of tables) {
      const expected = new Set(EXPECTED[table]);
      const colRes = await pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const actual = new Set(colRes.rows.map((r) => r.column_name));
      const missing = [...expected].filter((c) => !actual.has(c));
      const extra = [...actual].filter((c) => !expected.has(c));
      const ok = missing.length === 0 && actual.size > 0;
      if (!ok) report.ok = false;
      report.tables.push({
        table,
        ok,
        expectedCount: expected.size,
        actualCount: actual.size,
        missing,
        extraBaselineColumns: extra,
      });
    }
  } finally {
    await pool.end();
  }

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  console.log(`Schema column check — database: ${report.database}`);
  console.log("");
  for (const t of report.tables) {
    if (t.ok && t.extraBaselineColumns.length === 0) {
      console.log(`[OK] ${t.table}: ${t.actualCount} columns (matches baseline ${t.expectedCount})`);
      continue;
    }
    if (!t.actualCount) {
      console.log(`[FAIL] ${t.table}: table missing or has no columns`);
      continue;
    }
    if (t.missing.length) {
      console.log(`[FAIL] ${t.table}: missing columns (${t.missing.length}): ${t.missing.join(", ")}`);
    }
    if (t.extraBaselineColumns.length) {
      console.log(`[INFO] ${t.table}: columns beyond 0001_init baseline (${t.extraBaselineColumns.length}): ${t.extraBaselineColumns.join(", ")}`);
    }
  }
  console.log("");
  console.log(report.ok ? "OVERALL: all required columns present." : "OVERALL: FAIL — fix migrations or drift.");
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
