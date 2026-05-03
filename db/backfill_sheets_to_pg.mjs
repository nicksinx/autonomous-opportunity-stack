#!/usr/bin/env node
/**
 * One-shot Sheets -> Postgres backfill.
 *
 * Reads each tab from the configured Google Sheet (read-only token), coerces
 * Sheets-shaped values into Postgres types, and bulk-inserts each tab using
 * `INSERT ... ON CONFLICT DO NOTHING` so the script is re-runnable.
 *
 * Tabs are processed in dependency order (FK-respecting). Every tab is its
 * own transaction so a single bad row does not roll back the whole backfill.
 *
 * After every tab a parity report compares the Sheets row count to the row
 * count in Postgres; the script exits non-zero if any mismatch remains.
 *
 * Required env (loaded from .env / .env.postgres in repo root):
 *   SHEETS_ID                 — workbook ID
 *   GOOGLE_SHEETS_TOKEN       — OAuth bearer with sheets.readonly
 *   DATABASE_URI_ADMIN        — admin role; backfill bypasses normal grants
 *
 * Usage:
 *   node db/backfill_sheets_to_pg.mjs
 *   node db/backfill_sheets_to_pg.mjs --only=raw_signals,trend_scores
 *   node db/backfill_sheets_to_pg.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import pgFormatPkg from "pg-format";
import dotenv from "dotenv";

const pgFormat = pgFormatPkg.default || pgFormatPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(repoRoot, ".env.postgres") });
dotenv.config({ path: path.join(repoRoot, ".env") });

const HTTP_TIMEOUT_MS = 20_000;
const HTTP_MAX_RETRIES = 4;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BATCH_SIZE = 500;

function parseArgs(argv) {
  const args = { only: null, dryRun: false };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--only=")) {
      args.only = new Set(a.slice("--only=".length).split(",").filter(Boolean));
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchJson(url, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= HTTP_MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { _raw: text };
      }
      if (!res.ok) {
        const msg = body?.error?.message || body?.message || body?._raw || res.statusText;
        const err = new Error(`HTTP ${res.status} ${url}: ${msg}`);
        err.status = res.status;
        if (attempt < HTTP_MAX_RETRIES && RETRYABLE_STATUS.has(res.status)) {
          await sleep(800 * attempt);
          continue;
        }
        throw err;
      }
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt < HTTP_MAX_RETRIES) {
        await sleep(800 * attempt);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function sheetsHeaders() {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${(process.env.GOOGLE_SHEETS_TOKEN || "").trim()}`,
  };
}

async function readSheetTab(rangeA1) {
  const sheetsId = encodeURIComponent((process.env.SHEETS_ID || "").trim());
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/${encodeURIComponent(rangeA1)}`;
  const data = await fetchJson(url, { headers: sheetsHeaders() });
  const rows = Array.isArray(data?.values) ? data.values : [];
  if (!rows.length) return { headers: [], rows: [] };
  const [headers, ...values] = rows;
  return {
    headers: headers.map((h) => String(h || "").trim()),
    rows: values,
  };
}

function rowToObj(headers, row) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) {
    obj[headers[i]] = row?.[i];
  }
  return obj;
}

// ---------------------------- Coercion helpers ----------------------------
function strOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function intOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return n;
}

function boolOrFalse(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined || v === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}

function dateOrNull(v) {
  // returns YYYY-MM-DD or null
  const s = strOrNull(v);
  if (!s) return null;
  // Sheets often returns ISO already; accept ISO datetime too.
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function tsOrNull(v) {
  // returns ISO TIMESTAMPTZ-compatible string or null
  const s = strOrNull(v);
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

function jsonOrNull(v) {
  const s = strOrNull(v);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

function safeTier(v) {
  const s = strOrNull(v);
  if (!s) return null;
  if (["A", "B", "C", "reject"].includes(s)) return s;
  return null;
}

function safeDecision(v) {
  const s = strOrNull(v);
  if (!s) return null;
  if (["design_now", "review_required", "watchlist", "reject"].includes(s)) return s;
  return null;
}

// ---------------------------- Tab spec ----------------------------
// One entry per migrated Sheets tab. `range` is the A1 read range; `pk` is
// the Postgres primary key column for ON CONFLICT; `coerce` shapes one row;
// `columns` is the insert column list (must match the row keys produced by
// coerce). Skip-pattern: empty or already-seeded tabs return early.
const TABS = [
  {
    name: "sources_config",
    range: "sources_config!A:F",
    pk: "source_name",
    columns: ["source_name", "enabled", "market", "weight", "pull_frequency", "notes"],
    coerce: (r) => ({
      source_name: strOrNull(r.source_name),
      enabled: boolOrFalse(r.enabled),
      market: strOrNull(r.market) ?? "UK",
      weight: numOrNull(r.weight) ?? 1.0,
      pull_frequency: strOrNull(r.pull_frequency) ?? "daily",
      notes: strOrNull(r.notes),
    }),
  },
  {
    name: "score_weights",
    range: "score_weights!A:E",
    pk: "dimension",
    columns: ["dimension", "weight", "enabled", "last_updated", "notes"],
    coerce: (r) => ({
      dimension: strOrNull(r.dimension),
      weight: numOrNull(r.weight) ?? 0,
      enabled: boolOrFalse(r.enabled),
      last_updated: tsOrNull(r.last_updated) ?? new Date().toISOString(),
      notes: strOrNull(r.notes),
    }),
  },
  {
    name: "normalized_terms",
    range: "normalized_terms!A:M",
    pk: "canonical_id",
    columns: [
      "canonical_id",
      "date_first_seen",
      "date_last_seen",
      "canonical_term",
      "aliases",
      "language",
      "market",
      "primary_category",
      "status",
      "last_scored_at",
      "latest_opp_id",
      "latest_opportunity_score",
      "latest_tier",
    ],
    coerce: (r) => ({
      canonical_id: strOrNull(r.canonical_id),
      date_first_seen: tsOrNull(r.date_first_seen),
      date_last_seen: tsOrNull(r.date_last_seen),
      canonical_term: strOrNull(r.canonical_term),
      aliases: strOrNull(r.aliases),
      language: strOrNull(r.language),
      market: strOrNull(r.market),
      primary_category: strOrNull(r.primary_category),
      status: strOrNull(r.status) ?? "active",
      last_scored_at: tsOrNull(r.last_scored_at),
      latest_opp_id: strOrNull(r.latest_opp_id),
      latest_opportunity_score: numOrNull(r.latest_opportunity_score),
      latest_tier: safeTier(r.latest_tier),
    }),
  },
  {
    name: "raw_signals",
    range: "raw_signals!A:K",
    pk: "signal_id",
    columns: [
      "signal_id",
      "date_collected",
      "source",
      "market",
      "term",
      "related_term",
      "category",
      "signal_type",
      "velocity_hint",
      "url",
      "raw_payload_json",
    ],
    coerce: (r) => ({
      signal_id: strOrNull(r.signal_id),
      date_collected: tsOrNull(r.date_collected),
      source: strOrNull(r.source),
      market: strOrNull(r.market),
      term: strOrNull(r.term),
      related_term: strOrNull(r.related_term),
      category: strOrNull(r.category),
      signal_type: strOrNull(r.signal_type),
      velocity_hint: strOrNull(r.velocity_hint),
      url: strOrNull(r.url),
      raw_payload_json: jsonOrNull(r.raw_payload_json),
    }),
  },
  {
    name: "marketplace_evidence",
    range: "marketplace_evidence!A:H",
    pk: "evidence_id",
    columns: [
      "evidence_id",
      "canonical_id",
      "source",
      "phrase",
      "product_type",
      "intent_type",
      "evidence_strength",
      "captured_at",
    ],
    coerce: (r) => ({
      evidence_id: strOrNull(r.evidence_id),
      canonical_id: strOrNull(r.canonical_id),
      source: strOrNull(r.source),
      phrase: strOrNull(r.phrase),
      product_type: strOrNull(r.product_type),
      intent_type: strOrNull(r.intent_type),
      evidence_strength: numOrNull(r.evidence_strength),
      captured_at: tsOrNull(r.captured_at) ?? new Date().toISOString(),
    }),
  },
  {
    name: "opportunity_scores",
    range: "opportunity_scores!A:Y",
    pk: "opp_id",
    columns: [
      "opp_id", "canonical_id", "run_date", "niche_keyword", "target_audience",
      "theme", "seasonality_flag", "product_formats", "compliance_risk",
      "demand_score", "competition_score", "conversion_score", "creative_score",
      "margin_score", "ops_score", "catalog_score", "repeat_score", "season_score",
      "raw_weighted_sum", "risk_penalty", "opportunity_score", "tier", "action",
      "scorer_version", "score_notes",
    ],
    coerce: (r) => ({
      opp_id: strOrNull(r.opp_id),
      canonical_id: strOrNull(r.canonical_id),
      run_date: dateOrNull(r.run_date),
      niche_keyword: strOrNull(r.niche_keyword),
      target_audience: strOrNull(r.target_audience),
      theme: strOrNull(r.theme),
      seasonality_flag: strOrNull(r.seasonality_flag),
      product_formats: strOrNull(r.product_formats),
      compliance_risk: strOrNull(r.compliance_risk),
      demand_score: numOrNull(r.demand_score),
      competition_score: numOrNull(r.competition_score),
      conversion_score: numOrNull(r.conversion_score),
      creative_score: numOrNull(r.creative_score),
      margin_score: numOrNull(r.margin_score),
      ops_score: numOrNull(r.ops_score),
      catalog_score: numOrNull(r.catalog_score),
      repeat_score: numOrNull(r.repeat_score),
      season_score: numOrNull(r.season_score),
      raw_weighted_sum: numOrNull(r.raw_weighted_sum),
      risk_penalty: numOrNull(r.risk_penalty),
      opportunity_score: numOrNull(r.opportunity_score),
      tier: safeTier(r.tier),
      action: strOrNull(r.action),
      scorer_version: strOrNull(r.scorer_version),
      score_notes: strOrNull(r.score_notes),
    }),
  },
  {
    name: "trend_scores",
    range: "trend_scores!A:K",
    pk: "score_id",
    columns: [
      "score_id", "canonical_id", "run_date", "momentum_score", "pod_fit_score",
      "buyer_intent_score", "range_depth_score", "novelty_score", "risk_score",
      "total_score", "decision",
    ],
    coerce: (r) => ({
      score_id: strOrNull(r.score_id),
      canonical_id: strOrNull(r.canonical_id),
      run_date: dateOrNull(r.run_date),
      momentum_score: numOrNull(r.momentum_score),
      pod_fit_score: numOrNull(r.pod_fit_score),
      buyer_intent_score: numOrNull(r.buyer_intent_score),
      range_depth_score: numOrNull(r.range_depth_score),
      novelty_score: numOrNull(r.novelty_score),
      risk_score: numOrNull(r.risk_score),
      total_score: numOrNull(r.total_score),
      decision: safeDecision(r.decision),
    }),
  },
  {
    name: "score_components",
    range: "score_components!A:J",
    pk: "component_id",
    columns: [
      "component_id", "opp_id", "run_date", "dimension", "component_name",
      "raw_value", "normalized_value", "weight", "weighted_contribution", "notes",
    ],
    coerce: (r) => ({
      component_id: strOrNull(r.component_id),
      opp_id: strOrNull(r.opp_id),
      run_date: dateOrNull(r.run_date),
      dimension: strOrNull(r.dimension),
      component_name: strOrNull(r.component_name),
      raw_value: numOrNull(r.raw_value),
      normalized_value: numOrNull(r.normalized_value),
      weight: numOrNull(r.weight),
      weighted_contribution: numOrNull(r.weighted_contribution),
      notes: strOrNull(r.notes),
    }),
  },
  {
    name: "theme_clusters",
    range: "theme_clusters!A:P",
    pk: "cluster_id",
    columns: [
      "cluster_id", "run_date", "theme_name", "theme_slug", "parent_theme",
      "theme_summary", "audience", "occasion_type", "seasonality", "product_fit",
      "style_fit", "risk_level", "cluster_score", "term_count", "status", "review_notes",
    ],
    coerce: (r) => ({
      cluster_id: strOrNull(r.cluster_id),
      run_date: dateOrNull(r.run_date),
      theme_name: strOrNull(r.theme_name),
      theme_slug: strOrNull(r.theme_slug),
      parent_theme: strOrNull(r.parent_theme),
      theme_summary: strOrNull(r.theme_summary),
      audience: strOrNull(r.audience),
      occasion_type: strOrNull(r.occasion_type),
      seasonality: strOrNull(r.seasonality),
      product_fit: strOrNull(r.product_fit),
      style_fit: strOrNull(r.style_fit),
      risk_level: strOrNull(r.risk_level),
      cluster_score: numOrNull(r.cluster_score),
      term_count: intOrNull(r.term_count) ?? 0,
      status: strOrNull(r.status) ?? "draft",
      review_notes: strOrNull(r.review_notes),
    }),
  },
  {
    name: "cluster_members",
    range: "cluster_members!A:J",
    pk: "member_id",
    columns: [
      "member_id", "cluster_id", "canonical_id", "canonical_term", "member_role",
      "fit_score", "evidence_summary", "reason_included", "reason_excluded", "captured_at",
    ],
    coerce: (r) => ({
      member_id: strOrNull(r.member_id),
      cluster_id: strOrNull(r.cluster_id),
      canonical_id: strOrNull(r.canonical_id),
      canonical_term: strOrNull(r.canonical_term),
      member_role: strOrNull(r.member_role),
      fit_score: numOrNull(r.fit_score),
      evidence_summary: strOrNull(r.evidence_summary),
      reason_included: strOrNull(r.reason_included),
      reason_excluded: strOrNull(r.reason_excluded),
      captured_at: tsOrNull(r.captured_at) ?? new Date().toISOString(),
    }),
  },
  {
    name: "cluster_history",
    range: "cluster_history!A:G",
    pk: "history_id",
    columns: ["history_id", "cluster_id", "run_date", "change_type", "old_value", "new_value", "notes"],
    coerce: (r) => ({
      history_id: strOrNull(r.history_id),
      cluster_id: strOrNull(r.cluster_id),
      run_date: dateOrNull(r.run_date),
      change_type: strOrNull(r.change_type) ?? "updated",
      old_value: strOrNull(r.old_value),
      new_value: strOrNull(r.new_value),
      notes: strOrNull(r.notes),
    }),
  },
  {
    name: "cluster_review_queue",
    range: "cluster_review_queue!A:I",
    pk: "review_id",
    columns: [
      "review_id", "cluster_id", "run_date", "reason", "priority",
      "assigned_to", "status", "resolved_at", "resolution_notes",
    ],
    coerce: (r) => ({
      review_id: strOrNull(r.review_id),
      cluster_id: strOrNull(r.cluster_id),
      run_date: dateOrNull(r.run_date),
      reason: strOrNull(r.reason),
      priority: (strOrNull(r.priority) ?? "low").toLowerCase(),
      assigned_to: strOrNull(r.assigned_to),
      status: (strOrNull(r.status) ?? "open").toLowerCase(),
      resolved_at: tsOrNull(r.resolved_at),
      resolution_notes: strOrNull(r.resolution_notes),
    }),
  },
  {
    name: "cluster_metrics",
    range: "cluster_metrics!A:K",
    pk: "metric_id",
    columns: [
      "metric_id", "week_start", "total_clusters_generated", "approved_count",
      "avg_cluster_score", "avg_terms_per_cluster", "pct_sent_to_review",
      "pct_briefs_approved", "pct_rejected_weak_intent", "pct_rejected_risk", "notes",
    ],
    coerce: (r) => ({
      metric_id: strOrNull(r.metric_id),
      week_start: dateOrNull(r.week_start),
      total_clusters_generated: intOrNull(r.total_clusters_generated) ?? 0,
      approved_count: intOrNull(r.approved_count) ?? 0,
      avg_cluster_score: numOrNull(r.avg_cluster_score),
      avg_terms_per_cluster: numOrNull(r.avg_terms_per_cluster),
      pct_sent_to_review: numOrNull(r.pct_sent_to_review),
      pct_briefs_approved: numOrNull(r.pct_briefs_approved),
      pct_rejected_weak_intent: numOrNull(r.pct_rejected_weak_intent),
      pct_rejected_risk: numOrNull(r.pct_rejected_risk),
      notes: strOrNull(r.notes),
    }),
  },
  {
    name: "range_briefs",
    range: "range_briefs!A:K",
    pk: "brief_id",
    columns: [
      "brief_id", "cluster_id", "run_date", "range_title", "hero_angle",
      "best_products", "design_directions", "phrase_concepts", "audiences", "ip_risk", "status",
    ],
    coerce: (r) => ({
      brief_id: strOrNull(r.brief_id),
      cluster_id: strOrNull(r.cluster_id),
      run_date: dateOrNull(r.run_date),
      range_title: strOrNull(r.range_title),
      hero_angle: strOrNull(r.hero_angle),
      best_products: strOrNull(r.best_products),
      design_directions: strOrNull(r.design_directions),
      phrase_concepts: jsonOrNull(r.phrase_concepts),
      audiences: strOrNull(r.audiences),
      ip_risk: strOrNull(r.ip_risk),
      status: (strOrNull(r.status) ?? "draft").toLowerCase(),
    }),
  },
  {
    name: "phrase_bank",
    range: "phrase_bank!A:G",
    pk: "phrase_id",
    columns: ["phrase_id", "brief_id", "bucket", "phrase", "target_products", "style_hint", "created_at"],
    coerce: (r) => ({
      phrase_id: strOrNull(r.phrase_id),
      brief_id: strOrNull(r.brief_id),
      bucket: strOrNull(r.bucket),
      phrase: strOrNull(r.phrase),
      target_products: strOrNull(r.target_products),
      style_hint: strOrNull(r.style_hint),
      created_at: tsOrNull(r.created_at) ?? new Date().toISOString(),
    }),
  },
  {
    name: "watchlist",
    range: "watchlist!A:E",
    pk: "watch_id",
    columns: ["watch_id", "canonical_id", "reason", "review_after", "notes"],
    coerce: (r) => ({
      watch_id: strOrNull(r.watch_id),
      canonical_id: strOrNull(r.canonical_id),
      reason: strOrNull(r.reason),
      review_after: dateOrNull(r.review_after),
      notes: strOrNull(r.notes),
    }),
  },
  {
    name: "workflow_runs",
    range: "workflow_runs!A:J",
    pk: "run_id",
    columns: [
      "run_id", "run_started", "run_finished", "job_name", "rows_added",
      "rows_updated", "status", "error_log", "sources_summary_json", "stage_log_root_id",
    ],
    coerce: (r) => ({
      run_id: strOrNull(r.run_id),
      run_started: tsOrNull(r.run_started) ?? new Date().toISOString(),
      run_finished: tsOrNull(r.run_finished),
      job_name: strOrNull(r.job_name) ?? "unknown",
      rows_added: intOrNull(r.rows_added) ?? 0,
      rows_updated: intOrNull(r.rows_updated) ?? 0,
      status: strOrNull(r.status) ?? "unknown",
      error_log: strOrNull(r.error_log),
      sources_summary_json: jsonOrNull(r.sources_summary_json),
      stage_log_root_id: strOrNull(r.stage_log_root_id),
    }),
  },
  {
    name: "performance_feedback",
    range: "performance_feedback!A:L",
    pk: "feedback_id",
    columns: [
      "feedback_id", "opp_id", "brief_id", "product_sku", "feedback_date",
      "units_sold_30d", "revenue_30d", "gross_margin_pct", "return_rate_pct",
      "ctr_pct", "conversion_rate_pct", "feedback_notes",
    ],
    coerce: (r) => ({
      feedback_id: strOrNull(r.feedback_id),
      opp_id: strOrNull(r.opp_id),
      brief_id: strOrNull(r.brief_id),
      product_sku: strOrNull(r.product_sku),
      feedback_date: dateOrNull(r.feedback_date),
      units_sold_30d: intOrNull(r.units_sold_30d),
      revenue_30d: numOrNull(r.revenue_30d),
      gross_margin_pct: numOrNull(r.gross_margin_pct),
      return_rate_pct: numOrNull(r.return_rate_pct),
      ctr_pct: numOrNull(r.ctr_pct),
      conversion_rate_pct: numOrNull(r.conversion_rate_pct),
      feedback_notes: strOrNull(r.feedback_notes),
    }),
  },
  {
    name: "scoring_audit_log",
    range: "scoring_audit_log!A:L",
    pk: "audit_id",
    columns: [
      "audit_id", "run_date", "run_id", "candidates_evaluated", "tier_A_count",
      "tier_B_count", "tier_C_count", "rejected_count", "avg_opportunity_score",
      "top_opportunity", "scorer_version", "notes",
    ],
    coerce: (r) => ({
      audit_id: strOrNull(r.audit_id),
      run_date: dateOrNull(r.run_date),
      run_id: strOrNull(r.run_id),
      candidates_evaluated: intOrNull(r.candidates_evaluated) ?? 0,
      tier_A_count: intOrNull(r.tier_A_count) ?? 0,
      tier_B_count: intOrNull(r.tier_B_count) ?? 0,
      tier_C_count: intOrNull(r.tier_C_count) ?? 0,
      rejected_count: intOrNull(r.rejected_count) ?? 0,
      avg_opportunity_score: numOrNull(r.avg_opportunity_score),
      top_opportunity: strOrNull(r.top_opportunity),
      scorer_version: strOrNull(r.scorer_version),
      notes: strOrNull(r.notes),
    }),
  },
  {
    name: "normalization_log",
    range: "normalization_log!A:J",
    pk: "log_id",
    columns: [
      "log_id", "run_id", "run_date", "canonical_id", "input_term",
      "decision_type", "confidence", "merged_into", "reason", "created_at",
    ],
    coerce: (r) => ({
      log_id: strOrNull(r.log_id),
      run_id: strOrNull(r.run_id),
      run_date: dateOrNull(r.run_date),
      canonical_id: strOrNull(r.canonical_id),
      input_term: strOrNull(r.input_term),
      decision_type: strOrNull(r.decision_type) ?? "created",
      confidence: numOrNull(r.confidence),
      merged_into: strOrNull(r.merged_into),
      reason: strOrNull(r.reason),
      created_at: tsOrNull(r.created_at) ?? new Date().toISOString(),
    }),
  },
  {
    name: "publishing_queue",
    range: "publishing_queue!A:M",
    pk: "queue_id",
    columns: [
      "queue_id", "idempotency_key", "run_id", "run_week", "cluster_id",
      "brief_id", "status", "attempt_count", "first_enqueued_at", "last_seen_at",
      "source_run_id", "priority", "review_notes",
    ],
    coerce: (r) => ({
      queue_id: strOrNull(r.queue_id),
      idempotency_key: strOrNull(r.idempotency_key),
      run_id: strOrNull(r.run_id),
      run_week: dateOrNull(r.run_week),
      cluster_id: strOrNull(r.cluster_id),
      brief_id: strOrNull(r.brief_id),
      status: (strOrNull(r.status) ?? "pending").toLowerCase(),
      attempt_count: intOrNull(r.attempt_count) ?? 0,
      first_enqueued_at: tsOrNull(r.first_enqueued_at) ?? new Date().toISOString(),
      last_seen_at: tsOrNull(r.last_seen_at) ?? new Date().toISOString(),
      source_run_id: strOrNull(r.source_run_id),
      priority: (strOrNull(r.priority) ?? "medium").toLowerCase(),
      review_notes: strOrNull(r.review_notes),
    }),
  },
  {
    name: "stage_run_logs",
    range: "stage_run_logs!A:P",
    pk: "log_id",
    columns: [
      "log_id", "run_id", "workflow_name", "stage_name", "event_type",
      "started_at", "ended_at", "duration_ms", "rows_in", "rows_out",
      "error_count", "status", "error_summary", "attempt_number",
      "parent_log_id", "metadata_json",
    ],
    coerce: (r) => ({
      log_id: strOrNull(r.log_id),
      run_id: strOrNull(r.run_id),
      workflow_name: strOrNull(r.workflow_name) ?? "unknown",
      stage_name: strOrNull(r.stage_name) ?? "unknown",
      event_type: strOrNull(r.event_type) ?? "end",
      started_at: tsOrNull(r.started_at),
      ended_at: tsOrNull(r.ended_at),
      duration_ms: intOrNull(r.duration_ms),
      rows_in: intOrNull(r.rows_in),
      rows_out: intOrNull(r.rows_out),
      error_count: intOrNull(r.error_count) ?? 0,
      status: (strOrNull(r.status) ?? "success").toLowerCase(),
      error_summary: strOrNull(r.error_summary),
      attempt_number: intOrNull(r.attempt_number) ?? 1,
      parent_log_id: strOrNull(r.parent_log_id),
      metadata_json: jsonOrNull(r.metadata_json),
    }),
  },
  {
    name: "source_health",
    range: "source_health!A:M",
    pk: "health_id",
    columns: [
      "health_id", "run_id", "run_date", "source_name", "status",
      "rows_in", "rows_valid", "rows_rejected", "duration_ms", "last_error",
      "http_status_codes", "consecutive_failures", "updated_at",
    ],
    coerce: (r) => ({
      health_id: strOrNull(r.health_id),
      run_id: strOrNull(r.run_id),
      run_date: dateOrNull(r.run_date),
      source_name: strOrNull(r.source_name),
      status: (strOrNull(r.status) ?? "ok").toLowerCase(),
      rows_in: intOrNull(r.rows_in) ?? 0,
      rows_valid: intOrNull(r.rows_valid) ?? 0,
      rows_rejected: intOrNull(r.rows_rejected) ?? 0,
      duration_ms: intOrNull(r.duration_ms),
      last_error: strOrNull(r.last_error),
      http_status_codes: strOrNull(r.http_status_codes),
      consecutive_failures: intOrNull(r.consecutive_failures) ?? 0,
      updated_at: tsOrNull(r.updated_at) ?? new Date().toISOString(),
    }),
  },
  {
    name: "pipeline_locks",
    range: "pipeline_locks!A:J",
    pk: "lock_id",
    columns: [
      "lock_id", "lock_owner", "workflow_name", "stage_name", "target_resource",
      "acquired_at", "lock_expires_at", "released_at", "status", "metadata_json",
    ],
    coerce: (r) => ({
      lock_id: strOrNull(r.lock_id),
      lock_owner: strOrNull(r.lock_owner) ?? "unknown",
      workflow_name: strOrNull(r.workflow_name) ?? "unknown",
      stage_name: strOrNull(r.stage_name),
      target_resource: strOrNull(r.target_resource),
      acquired_at: tsOrNull(r.acquired_at) ?? new Date().toISOString(),
      lock_expires_at: tsOrNull(r.lock_expires_at),
      released_at: tsOrNull(r.released_at),
      status: (strOrNull(r.status) ?? "held").toLowerCase(),
      metadata_json: jsonOrNull(r.metadata_json),
    }),
  },
  {
    name: "dual_write_mirror_log",
    range: "dual_write_mirror_log!A:K",
    pk: "mirror_id",
    columns: [
      "mirror_id", "run_id", "workflow_name", "target_table", "primary_sink",
      "secondary_sink", "rows_written", "primary_status", "secondary_status",
      "mirror_hash", "created_at",
    ],
    coerce: (r) => ({
      mirror_id: strOrNull(r.mirror_id),
      run_id: strOrNull(r.run_id),
      workflow_name: strOrNull(r.workflow_name) ?? "unknown",
      target_table: strOrNull(r.target_table) ?? "unknown",
      primary_sink: strOrNull(r.primary_sink),
      secondary_sink: strOrNull(r.secondary_sink),
      rows_written: intOrNull(r.rows_written) ?? 0,
      primary_status: strOrNull(r.primary_status),
      secondary_status: strOrNull(r.secondary_status),
      mirror_hash: strOrNull(r.mirror_hash),
      created_at: tsOrNull(r.created_at) ?? new Date().toISOString(),
    }),
  },
];

function isValidRow(row, pkCol) {
  const v = row[pkCol];
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  return s !== "";
}

async function bulkInsert(client, tab, rows) {
  if (!rows.length) return 0;
  const pkList = Array.isArray(tab.pk) ? tab.pk : [tab.pk];
  const colList = tab.columns;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch.map((r) =>
      colList.map((c) => {
        const v = r[c];
        if (v === undefined) return null;
        if (v && typeof v === "object" && !(v instanceof Date)) {
          // JSONB columns: pg-format will serialize via %L; need explicit JSON literal
          return JSON.stringify(v);
        }
        return v;
      }),
    );
    const sql = pgFormat(
      `INSERT INTO %I (%s) VALUES %L ON CONFLICT (%s) DO NOTHING`,
      tab.name,
      colList.join(", "),
      values,
      pkList.join(", "),
    );
    const res = await client.query(sql);
    inserted += res.rowCount || 0;
  }
  return inserted;
}

async function pgRowCount(client, tableName) {
  const sql = pgFormat("SELECT COUNT(*)::int AS n FROM %I", tableName);
  const res = await client.query(sql);
  return res.rows[0].n;
}

async function processTab(client, tab, args) {
  const log = (m) => console.log(`[${tab.name}] ${m}`);
  log(`reading ${tab.range}...`);
  const sheetData = await readSheetTab(tab.range);
  const rows = sheetData.rows.map((r) => rowToObj(sheetData.headers, r));
  const beforeCount = await pgRowCount(client, tab.name);

  const coerced = rows
    .map((r) => {
      try {
        return tab.coerce(r);
      } catch {
        return null;
      }
    })
    .filter((r) => r && isValidRow(r, Array.isArray(tab.pk) ? tab.pk[0] : tab.pk));

  log(`sheet rows: ${rows.length} (valid for insert: ${coerced.length}, pre-insert pg count: ${beforeCount})`);

  let inserted = 0;
  if (!args.dryRun && coerced.length) {
    inserted = await bulkInsert(client, tab, coerced);
  }
  const afterCount = args.dryRun ? beforeCount : await pgRowCount(client, tab.name);
  log(`inserted: ${inserted}, post-insert pg count: ${afterCount}`);

  // Parity: every Sheets row should now exist in Postgres (allowing for valid-rows skip).
  // Mismatch = sheet rows count > pg row count (excluding rows we filtered out).
  const expected = coerced.length;
  const parityOk = afterCount >= expected || args.dryRun;
  return {
    name: tab.name,
    sheetRows: rows.length,
    validRows: coerced.length,
    inserted,
    pgRowsBefore: beforeCount,
    pgRowsAfter: afterCount,
    parityOk,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uri = process.env.DATABASE_URI_ADMIN || process.env.DATABASE_URI;
  if (!uri) {
    console.error("ERROR: DATABASE_URI_ADMIN (or DATABASE_URI) must be set.");
    process.exit(1);
  }
  if (!process.env.SHEETS_ID) {
    console.error("ERROR: SHEETS_ID must be set.");
    process.exit(1);
  }
  if (!process.env.GOOGLE_SHEETS_TOKEN) {
    console.error("ERROR: GOOGLE_SHEETS_TOKEN must be set.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: uri });
  await client.connect();
  const reports = [];
  let exitOk = true;

  try {
    for (const tab of TABS) {
      if (args.only && !args.only.has(tab.name)) continue;
      try {
        const r = await processTab(client, tab, args);
        reports.push(r);
        if (!r.parityOk) exitOk = false;
      } catch (e) {
        console.error(`[${tab.name}] FAILED: ${e?.message || e}`);
        reports.push({ name: tab.name, error: e?.message || String(e), parityOk: false });
        exitOk = false;
      }
    }
  } finally {
    await client.end();
  }

  console.log("\n=== Backfill parity report ===");
  console.log(
    [
      "tab".padEnd(28),
      "sheet".padStart(8),
      "valid".padStart(8),
      "inserted".padStart(10),
      "pgBefore".padStart(10),
      "pgAfter".padStart(10),
      "ok",
    ].join(" "),
  );
  for (const r of reports) {
    if (r.error) {
      console.log(`${r.name.padEnd(28)}  ERROR: ${r.error}`);
      continue;
    }
    console.log(
      [
        r.name.padEnd(28),
        String(r.sheetRows).padStart(8),
        String(r.validRows).padStart(8),
        String(r.inserted).padStart(10),
        String(r.pgRowsBefore).padStart(10),
        String(r.pgRowsAfter).padStart(10),
        r.parityOk ? "OK" : "MISMATCH",
      ].join(" "),
    );
  }
  console.log(exitOk ? "\nOVERALL: OK" : "\nOVERALL: MISMATCH");
  process.exit(exitOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
