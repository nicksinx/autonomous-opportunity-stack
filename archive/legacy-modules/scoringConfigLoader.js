/**
 * Scoring config loader (Item 4 of pipeline hardening plan).
 *
 * Loads the score_weights tab into a runtime config used by scoringEngine.js,
 * validates ranges/sums, falls back to defaults on invalid configs, computes
 * a content hash for the scoring_audit_log row, and produces score_components
 * rows for explainability.
 *
 * Pure JavaScript. Designed to be inlined into n8n Code nodes.
 */

/**
 * Default weights mirror the seed rows in extend_scoring_schema.gs.
 * Treated as the immutable fallback when score_weights is unreadable
 * or fails validation.
 */
const DEFAULT_WEIGHTS = Object.freeze({
  demand_strength: 0.2,
  competition_gap: 0.15,
  conversion_potential: 0.2,
  creative_diff: 0.1,
  margin_potential: 0.1,
  ops_feasibility: 0.1,
  catalog_fit: 0.05,
  repeatability: 0.05,
  seasonality_timing: 0.05,
});

const DIMENSION_KEYS = Object.keys(DEFAULT_WEIGHTS);

/**
 * Load and validate weights from raw score_weights rows.
 *
 * @param {Array<Object<string, any>>} weightRows Rows from score_weights tab.
 * @returns {{
 *   weights: Record<string, number>,
 *   enabled: Record<string, boolean>,
 *   issues: string[],
 *   used_fallback: boolean,
 *   config_hash: string,
 *   config_version: string,
 * }}
 */
function loadScoreWeights(weightRows) {
  const rows = Array.isArray(weightRows) ? weightRows : [];
  const issues = [];
  const weights = { ...DEFAULT_WEIGHTS };
  const enabled = {};
  for (const k of DIMENSION_KEYS) enabled[k] = true;

  let usedFallback = false;

  if (!rows.length) {
    issues.push("score_weights_empty_or_unreadable");
    usedFallback = true;
  } else {
    for (const row of rows) {
      const dim = str(row.dimension);
      if (!dim || !(dim in DEFAULT_WEIGHTS)) {
        if (dim) issues.push(`unknown_dimension:${dim}`);
        continue;
      }
      const w = num(row.weight);
      if (!Number.isFinite(w) || w < 0 || w > 1) {
        issues.push(`invalid_weight:${dim}=${row.weight}`);
        continue;
      }
      weights[dim] = w;
      enabled[dim] = parseEnabled(row.enabled);
    }

    const sum = DIMENSION_KEYS.reduce((a, k) => a + (enabled[k] ? weights[k] : 0), 0);
    if (sum <= 0) {
      issues.push(`weight_sum_zero:${sum.toFixed(3)}`);
      usedFallback = true;
    } else if (sum < 0.95 || sum > 1.05) {
      issues.push(`weight_sum_out_of_range:${sum.toFixed(3)}`);
    }
  }

  if (usedFallback) {
    for (const k of DIMENSION_KEYS) {
      weights[k] = DEFAULT_WEIGHTS[k];
      enabled[k] = true;
    }
  }

  const configHash = computeConfigHash(weights, enabled);
  return {
    weights,
    enabled,
    issues,
    used_fallback: usedFallback,
    config_hash: configHash,
    config_version: `weights_${configHash.slice(0, 8)}`,
  };
}

/**
 * Build a scoring_audit_log row summarising one scoring run.
 *
 * @param {{
 *   run_id: string,
 *   run_date?: string,
 *   scoredOpportunities: Array<Object<string, any>>,
 *   rejectedCount?: number,
 *   topOpportunity?: string,
 *   scorerVersion?: string,
 *   weightsResult: ReturnType<typeof loadScoreWeights>,
 * }} input
 * @returns {Object<string, any>}
 */
function buildScoringAuditRow(input) {
  const i = input || {};
  const scored = Array.isArray(i.scoredOpportunities) ? i.scoredOpportunities : [];
  const tierA = scored.filter((s) => str(s.tier).toUpperCase() === "A").length;
  const tierB = scored.filter((s) => str(s.tier).toUpperCase() === "B").length;
  const tierC = scored.filter((s) => str(s.tier).toUpperCase() === "C").length;
  const avgOpp = scored.length
    ? round1(scored.reduce((a, s) => a + num(s.opportunity_score), 0) / scored.length)
    : 0;

  const w = i.weightsResult || {};
  return {
    audit_id: `audit_${str(i.run_id) || Date.now()}`,
    run_date: str(i.run_date) || new Date().toISOString().slice(0, 10),
    run_id: str(i.run_id),
    candidates_evaluated: scored.length + num(i.rejectedCount),
    tier_A_count: tierA,
    tier_B_count: tierB,
    tier_C_count: tierC,
    rejected_count: num(i.rejectedCount),
    avg_opportunity_score: avgOpp,
    top_opportunity: str(i.topOpportunity),
    scorer_version: str(i.scorerVersion) || str(w.config_version),
    notes: w.used_fallback
      ? `fallback_weights:${(w.issues || []).join("|")}`
      : (w.issues && w.issues.length ? `warnings:${w.issues.join("|")}` : "ok"),
  };
}

/**
 * Build score_components rows for one scored opportunity.
 *
 * @param {{
 *   opp_id: string,
 *   run_date: string,
 *   raw_values: Record<string, number>,
 *   normalized_values?: Record<string, number>,
 * }} opp
 * @param {{ weights: Record<string, number>, enabled: Record<string, boolean> }} config
 * @returns {Array<Object<string, any>>}
 */
function buildScoreComponentsRows(opp, config) {
  const o = opp || {};
  const c = config || { weights: DEFAULT_WEIGHTS, enabled: {} };
  const raws = o.raw_values || {};
  const norms = o.normalized_values || raws;
  const out = [];

  for (const dim of DIMENSION_KEYS) {
    const w = num(c.weights[dim]);
    const enabled = c.enabled[dim] !== false;
    const raw = num(raws[dim]);
    const normalized = num(norms[dim]);
    const contribution = enabled ? round2(normalized * w) : 0;

    out.push({
      component_id: `cmp_${str(o.opp_id)}_${dim}`,
      opp_id: str(o.opp_id),
      run_date: str(o.run_date),
      dimension: dim,
      component_name: dim,
      raw_value: round2(raw),
      normalized_value: round2(normalized),
      weight: round2(w),
      weighted_contribution: contribution,
      notes: enabled ? "" : "weight_disabled",
    });
  }

  return out;
}

function parseEnabled(value) {
  if (value === false) return false;
  if (value === true) return true;
  const s = str(value).toLowerCase();
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  if (s === "" || s === "true" || s === "1" || s === "yes" || s === "on") return true;
  return true;
}

function computeConfigHash(weights, enabled) {
  const parts = DIMENSION_KEYS.map((k) =>
    `${k}=${num(weights[k]).toFixed(4)}|${enabled[k] === false ? "0" : "1"}`
  );
  return hashString(parts.join("&"));
}

function hashString(s) {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const out = (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
  return out;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_WEIGHTS,
    DIMENSION_KEYS,
    loadScoreWeights,
    buildScoringAuditRow,
    buildScoreComponentsRows,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  const seedRows = [
    { dimension: "demand_strength", weight: 0.25, enabled: true },
    { dimension: "competition_gap", weight: 0.15, enabled: true },
    { dimension: "conversion_potential", weight: 0.2, enabled: true },
    { dimension: "creative_diff", weight: 0.1, enabled: true },
    { dimension: "margin_potential", weight: 0.1, enabled: true },
    { dimension: "ops_feasibility", weight: 0.05, enabled: true },
    { dimension: "catalog_fit", weight: 0.05, enabled: true },
    { dimension: "repeatability", weight: 0.05, enabled: true },
    { dimension: "seasonality_timing", weight: 0.05, enabled: true },
  ];
  const config = loadScoreWeights(seedRows);
  // eslint-disable-next-line no-console
  console.log("Config:", config);

  const components = buildScoreComponentsRows(
    {
      opp_id: "opp_demo_1",
      run_date: "2026-04-28",
      raw_values: {
        demand_strength: 80,
        competition_gap: 60,
        conversion_potential: 75,
        creative_diff: 70,
        margin_potential: 65,
        ops_feasibility: 90,
        catalog_fit: 80,
        repeatability: 70,
        seasonality_timing: 60,
      },
    },
    config
  );
  // eslint-disable-next-line no-console
  console.log("Components:", JSON.stringify(components, null, 2));

  const audit = buildScoringAuditRow({
    run_id: "run_score_demo",
    run_date: "2026-04-28",
    scoredOpportunities: [
      { tier: "A", opportunity_score: 82 },
      { tier: "B", opportunity_score: 65 },
      { tier: "C", opportunity_score: 50 },
    ],
    rejectedCount: 1,
    topOpportunity: "pickleball_mom",
    weightsResult: config,
  });
  // eslint-disable-next-line no-console
  console.log("Audit row:", audit);
}
