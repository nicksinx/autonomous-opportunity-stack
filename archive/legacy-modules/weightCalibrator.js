/**
 * Weight calibration utilities for opportunity scoring.
 * Pure JavaScript, no external dependencies.
 */

/** @type {Record<string, number>} */
const DEFAULT_WEIGHTS = {
  demand_strength: 0.2,
  competition_gap: 0.15,
  conversion_potential: 0.2,
  creative_diff: 0.1,
  margin_potential: 0.1,
  ops_feasibility: 0.1,
  catalog_fit: 0.05,
  repeatability: 0.05,
  seasonality_timing: 0.05,
};

/** @type {Array<{dimension:string, scoreField:string}>} */
const DIMENSIONS = [
  { dimension: "demand_strength", scoreField: "demand_score" },
  { dimension: "competition_gap", scoreField: "competition_score" },
  { dimension: "conversion_potential", scoreField: "conversion_score" },
  { dimension: "creative_diff", scoreField: "creative_score" },
  { dimension: "margin_potential", scoreField: "margin_score" },
  { dimension: "ops_feasibility", scoreField: "ops_score" },
  { dimension: "catalog_fit", scoreField: "catalog_score" },
  { dimension: "repeatability", scoreField: "repeat_score" },
  { dimension: "seasonality_timing", scoreField: "season_score" },
];

/**
 * Analyze scoring signal quality and propose calibrated weights.
 *
 * @param {Array<Object<string, any>>} feedbackRows performance_feedback rows
 * @param {Array<Object<string, any>>} scoreRows opportunity_scores rows
 * @returns {{
 *   sample_size: number,
 *   hit_rate: number,
 *   dimension_correlations: Array<{dimension:string, pearson_r:number, predictive:boolean}>,
 *   suggested_weights: Record<string, number> & { __sample_size?: number },
 *   notes: string[]
 * }}
 */
function analyzeWeightAccuracy(feedbackRows, scoreRows) {
  const fb = Array.isArray(feedbackRows) ? feedbackRows : [];
  const sc = Array.isArray(scoreRows) ? scoreRows : [];
  const notes = [];

  const scoreByOpp = new Map();
  for (const row of sc) {
    const oppId = str(row.opp_id);
    if (!oppId) continue;
    scoreByOpp.set(oppId, row);
  }

  const joined = [];
  for (const f of fb) {
    const oppId = str(f.opp_id);
    if (!oppId) continue;
    const s = scoreByOpp.get(oppId);
    if (!s) continue;
    const units = num(f.units_sold_30d);
    const margin = num(f.gross_margin_pct);
    const label = performanceLabel(units, margin);
    joined.push({ feedback: f, score: s, units, margin, label });
  }

  const sampleSize = joined.length;
  const hits = joined.filter((x) => x.label === "hit").length;
  const hitRate = sampleSize ? round1((hits / sampleSize) * 100) : 0;

  const dimensionCorrelations = DIMENSIONS.map(({ dimension, scoreField }) => {
    const x = [];
    const y = [];
    for (const row of joined) {
      x.push(num(row.score[scoreField]));
      y.push(num(row.units));
    }
    const r = round4(pearsonCorrelation(x, y));
    return { dimension, pearson_r: r, predictive: Math.abs(r) >= 0.3 };
  });

  if (sampleSize < 10) {
    notes.push("Insufficient sample for calibration (need 10+)");
    notes.push(`Joined ${sampleSize} feedback rows to scored opportunities`);
    return {
      sample_size: sampleSize,
      hit_rate: hitRate,
      dimension_correlations: dimensionCorrelations,
      suggested_weights: { ...DEFAULT_WEIGHTS, __sample_size: sampleSize },
      notes,
    };
  }

  const corrByDim = new Map(dimensionCorrelations.map((d) => [d.dimension, d.pearson_r]));
  const adjusted = {};
  for (const [dim, baseWeight] of Object.entries(DEFAULT_WEIGHTS)) {
    const r = num(corrByDim.get(dim));
    let multiplier = 1.0;
    if (r < 0.1) multiplier = 0.8;
    else if (r >= 0.5) multiplier = 1.2;

    // Requirement: cap any single adjustment at +/-30%.
    multiplier = clamp(multiplier, 0.7, 1.3);
    adjusted[dim] = baseWeight * multiplier;
  }

  const suggested = renormalizeWeights(adjusted);
  suggested.__sample_size = sampleSize;

  const predictiveDims = dimensionCorrelations
    .filter((d) => d.predictive)
    .map((d) => `${d.dimension} (${d.pearson_r})`);
  if (predictiveDims.length) {
    notes.push(`Predictive dimensions (|r| >= 0.3): ${predictiveDims.join(", ")}`);
  } else {
    notes.push("No strongly predictive dimensions yet (|r| >= 0.3)");
  }
  notes.push(`Hit rate: ${hitRate}% across ${sampleSize} joined rows`);

  return {
    sample_size: sampleSize,
    hit_rate: hitRate,
    dimension_correlations: dimensionCorrelations,
    suggested_weights: suggested,
    notes,
  };
}

/**
 * Build score_weights upsert rows from suggested weights.
 *
 * @param {Record<string, number> & { __sample_size?: number }} suggestedWeights calibrated weights object
 * @returns {Array<{dimension:string, weight:number, enabled:true, last_updated:string, notes:string}>}
 */
function generateWeightUpdateRows(suggestedWeights) {
  const w = suggestedWeights && typeof suggestedWeights === "object" ? suggestedWeights : {};
  const sampleSize = Number.isFinite(Number(w.__sample_size)) ? Number(w.__sample_size) : 0;
  const today = new Date().toISOString().slice(0, 10);
  const note = `auto-calibrated from ${sampleSize} feedback rows`;

  return DIMENSIONS.map(({ dimension }) => ({
    dimension,
    weight: round4(num(w[dimension])),
    enabled: true,
    last_updated: today,
    notes: note,
  }));
}

function performanceLabel(unitsSold30d, grossMarginPct) {
  if (unitsSold30d >= 10 && grossMarginPct >= 30) return "hit";
  if (unitsSold30d >= 3 && grossMarginPct >= 20) return "partial";
  return "miss";
}

/**
 * Pearson correlation r(X,Y), computed from scratch.
 *
 * @param {number[]} x
 * @param {number[]} y
 * @returns {number}
 */
function pearsonCorrelation(x, y) {
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.length < 2) return 0;
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let numSum = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = num(x[i]) - meanX;
    const dy = num(y[i]) - meanY;
    numSum += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (!Number.isFinite(den) || den === 0) return 0;
  return numSum / den;
}

function renormalizeWeights(weights) {
  const out = {};
  const keys = Object.keys(DEFAULT_WEIGHTS);
  const sum = keys.reduce((a, k) => a + Math.max(0, num(weights[k])), 0);
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  for (const k of keys) out[k] = round6(Math.max(0, num(weights[k])) / sum);
  return out;
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

function round6(v) {
  return Math.round(v * 1_000_000) / 1_000_000;
}

/**
 * Synthetic example with 15 rows.
 */
function runExample() {
  const feedbackRows = [];
  const scoreRows = [];

  for (let i = 1; i <= 15; i++) {
    const oppId = `opp_can_${i}_2026-04-28`;
    const demand = 2 + (i % 9);
    const conversion = 1 + ((i * 2) % 9);
    const margin = 3 + (i % 6);
    const units = Math.max(0, Math.round(demand * 1.3 + conversion * 0.8 + (i % 3) - 4));
    const gm = Math.max(10, Math.min(55, 16 + margin * 3 + (i % 4)));

    feedbackRows.push({
      feedback_id: `fb_${i}`,
      opp_id: oppId,
      units_sold_30d: units,
      gross_margin_pct: gm,
      conversion_rate_pct: 1 + (i % 8),
    });

    scoreRows.push({
      opp_id: oppId,
      demand_score: demand,
      competition_score: 4 + (i % 5),
      conversion_score: conversion,
      creative_score: 3 + (i % 6),
      margin_score: margin,
      ops_score: 4 + (i % 6),
      catalog_score: 3 + (i % 5),
      repeat_score: 2 + (i % 7),
      season_score: 2 + (i % 8),
      opportunity_score: 35 + i * 2,
    });
  }

  const analysis = analyzeWeightAccuracy(feedbackRows, scoreRows);
  const updateRows = generateWeightUpdateRows(analysis.suggested_weights);

  // eslint-disable-next-line no-console
  console.log("=== weightCalibrator runExample ===");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(analysis, null, 2));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(updateRows, null, 2));
}

module.exports = {
  analyzeWeightAccuracy,
  generateWeightUpdateRows,
};

if (require.main === module) {
  runExample();
}
