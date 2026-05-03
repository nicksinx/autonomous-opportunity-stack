// Layer 2 score node — inlined into wf_score_and_cluster (do not run standalone).
// Expects: $('2. Read canonical_signals (ready)'), $('1.5 Begin scoring_run'), $('3. Read score_weights (enabled)').
// Env: LAYER2_SCORING_VERSION, LAYER2_APPROVE_THRESHOLD (default 75), LAYER2_REVIEW_THRESHOLD (default 55)

function uuidFromSeed(seed) {
  let h = 2166136261;
  const x = String(seed);
  for (let i = 0; i < x.length; i++) {
    h ^= x.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hex = Math.abs(h).toString(16).padStart(8, "0") + Math.abs(h ^ 0x9e3779b9).toString(16).padStart(8, "0");
  const p = (hex + hex).slice(0, 32);
  return `${p.slice(0, 8)}-${p.slice(8, 12)}-5${p.slice(13, 16)}-a${p.slice(17, 20)}-${p.slice(20, 32)}`;
}

const str = (v) => String(v == null ? "" : v).trim();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const arr = (v) => (Array.isArray(v) ? v : []);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;
const round4 = (v) => Math.round(v * 10000) / 10000;

const IDENTITY_WORDS = ["mom", "dad", "teacher", "nurse", "dog", "cat", "wife", "husband", "grandma", "grandpa", "auntie", "uncle", "sister", "brother", "friend", "girl", "guy", "queen", "king", "boss", "lover", "fan", "nerd", "geek", "pro", "hero", "rebel", "doctor", "lawyer", "chef", "baker", "runner", "hiker", "gamer", "reader", "gardener", "crafter"];
const OCCASION_WORDS = ["birthday", "christmas", "halloween", "valentine", "mother", "father", "wedding", "anniversary", "graduation", "baby", "shower", "new year", "easter", "thanksgiving", "holiday", "party"];
const BRAND_CELEB_RISK_WORDS = ["disney", "marvel", "nfl", "nba", "mlb", "nhl", "taylor", "swift", "beyonce", "kardashian", "trump", "biden", "harry", "styles", "billie", "eilish", "pokemon", "minecraft", "roblox", "fortnite", "barbie", "nike", "adidas", "supreme", "gucci", "nasa", "ncaa"];
const NEWS_EVENT_RISK_WORDS = ["election", "war", "shooting", "flood", "earthquake", "covid", "pandemic", "terrorist", "riot", "protest", "hostage"];
const VELOCITY_RANK = { low: 1, medium: 2, high: 3 };

function tokenize(h) {
  return String(h || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}
function firstMatch(h, terms) {
  const tk = new Set(tokenize(h));
  for (const t of terms) {
    if (tk.has(String(t).toLowerCase())) return t;
  }
  return "";
}
function hasAny(h, terms) {
  return !!firstMatch(h, terms);
}
function parseDate(v) {
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}
function daysSince(v) {
  const d = parseDate(v);
  if (!d) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}
function deriveRiskFromKeyword(k) {
  const tk = new Set(tokenize(k));
  const flags = [];
  for (const t of BRAND_CELEB_RISK_WORDS) {
    if (tk.has(String(t).toLowerCase())) flags.push(t);
  }
  if (flags.length) return { level: "high", flags: [...new Set(flags)] };
  for (const t of NEWS_EVENT_RISK_WORDS) {
    if (tk.has(String(t).toLowerCase())) flags.push(t);
  }
  if (flags.length) return { level: "moderate", flags: [...new Set(flags)] };
  return { level: "low", flags: [] };
}

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch (_e) {
    return fallback;
  }
}

function buildSyntheticFromCanonical(cs) {
  const lineage = parseJson(cs.lineage, {});
  const canonId = str(lineage.normalized_term_id || cs.canonical_ref || "");
  const keyword = str(cs.normalized_topic || "");
  const k = keyword.toLowerCase();
  const riskJson = parseJson(cs.risk_flags, {});
  const comp = parseJson(cs.competition_metrics, {}) || {};
  const evidenceRows = [];
  const ec = num(comp.evidence_rows || comp.evidence_rows_7d);
  if (ec > 0) {
    evidenceRows.push({ source: "aggregated", phrase: "", canonical_id: canonId });
  }
  const rawIds = arr(lineage.raw_signal_ids);
  const signalRows = rawIds.slice(0, 50).map(() => ({
    source: str(cs.source_name),
    velocity_hint: "medium",
    date_collected: cs.observed_at || cs.ingested_at,
    related_term: "",
    related_terms: "",
  }));
  const risk =
    riskJson && riskJson.level
      ? riskJson
      : deriveRiskFromKeyword(k);
  const target = firstMatch(k, IDENTITY_WORDS) || "general";
  const hasIdentity = target !== "general";
  const hasOccasion = hasAny(k, OCCASION_WORDS);
  const product_formats = ["tshirt", "mug", "sticker"];
  if (hasOccasion) product_formats.push("tote_bag");
  if (hasIdentity) product_formats.push("sweatshirt");
  const etsyRows = ec > 3 ? [1, 2, 3] : [];
  return {
    canonical_id: canonId,
    niche_keyword: keyword,
    target_audience: target,
    theme: str(cs.normalized_niche || "unknown"),
    source_count: Math.max(1, rawIds.length || 1),
    etsy_phrase_count: etsyRows.length,
    amazon_signal: num(comp.distinct_sources) > 1,
    google_signal: str(cs.source_type) === "search",
    pinterest_signal: false,
    social_signal: str(cs.source_type) === "social",
    alias_count: 0,
    seasonality_flag: hasOccasion ? "seasonal" : "unknown",
    seasonality_window: "unknown",
    product_formats,
    phrase_length_words: keyword.split(/\s+/).filter(Boolean).length,
    has_identity_word: hasIdentity,
    has_occasion_word: hasOccasion,
    compliance_risk: risk.level === "high" ? "high" : risk.level === "moderate" ? "moderate" : "low",
    risk_flags: risk.flags || [],
    velocity_hint: "medium",
    days_since_first_seen: daysSince(cs.observed_at || cs.ingested_at),
    days_since_last_seen: daysSince(cs.ingested_at),
    persistence_windows: Math.min(7, rawIds.length || 1),
    top_etsy_phrases: [],
    related_terms: [],
  };
}

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

function normalizeWeights(w) {
  const out = { ...DEFAULT_WEIGHTS };
  const src = w && typeof w === "object" ? w : {};
  for (const k of Object.keys(out)) {
    const n = num(src[k]);
    if (n > 0) out[k] = n;
  }
  return out;
}

function riskNorm(v) {
  const x = str(v).toLowerCase();
  return ["low", "moderate", "high"].includes(x) ? x : "low";
}

function fin(s, w) {
  const raw = clamp(round1(s), 0, 10);
  return { raw, weighted: round4((raw / 10) * w * 100) };
}

function scoreDimensions(c, weights) {
  const w = normalizeWeights(weights);
  const comp = [];
  const oppSeed = str(c.canonical_id);
  const runDate = new Date().toISOString().slice(0, 10);
  const addComp = (dim, name, raw, pts, wt, notes) => {
    comp.push({
      factor_name: dim,
      raw_value: round4(raw),
      weight: round4(wt),
      factor_value: round4(pts),
      factor_reason: notes || "",
      evidence: null,
    });
    return pts;
  };
  let dPts = 0;
  dPts += addComp("demand_strength", "base", 3, 3, w.demand_strength, "");
  if (c.google_signal) dPts += addComp("demand_strength", "google", 1, 2, w.demand_strength, "");
  if (c.social_signal) dPts += addComp("demand_strength", "social", 1, 1.5, w.demand_strength, "");
  const d = fin(dPts, w.demand_strength);
  let cpPts = 5;
  cpPts += addComp("competition_gap", "base", 5, 0, w.competition_gap, "");
  if (riskNorm(c.compliance_risk) === "low") cpPts += addComp("competition_gap", "low_risk", 5, 2, w.competition_gap, "");
  const cp = fin(cpPts, w.competition_gap);
  let cvPts = 0;
  if (c.has_identity_word) cvPts += addComp("conversion_potential", "id", 1, 3, w.conversion_potential, "");
  if (c.has_occasion_word) cvPts += addComp("conversion_potential", "occ", 1, 2, w.conversion_potential, "");
  const cv = fin(cvPts, w.conversion_potential);
  const cr = fin(5, w.creative_diff);
  const mg = fin(5, w.margin_potential);
  const op = fin(4, w.ops_feasibility);
  const cf = fin(5, w.catalog_fit);
  const rp = fin(3, w.repeatability);
  const ss = fin(4, w.seasonality_timing);
  const raw_weighted_sum = round1(
    d.weighted + cp.weighted + cv.weighted + cr.weighted + mg.weighted + op.weighted + cf.weighted + rp.weighted + ss.weighted,
  );
  let risk_penalty = 0;
  const rr = riskNorm(c.compliance_risk);
  if (rr === "high") risk_penalty += 10;
  else if (rr === "moderate") risk_penalty += 5;
  risk_penalty = Math.min(25, risk_penalty);
  const opportunity_score = clamp(round1(raw_weighted_sum - risk_penalty), 0, 100);
  const tier = opportunity_score >= 75 ? "A" : opportunity_score >= 55 ? "B" : opportunity_score >= 35 ? "C" : "reject";
  return {
    dimensions: comp,
    totals: {
      demand_score: d.raw,
      competition_score: cp.raw,
      conversion_score: cv.raw,
      creative_score: cr.raw,
      margin_score: mg.raw,
      ops_score: op.raw,
      catalog_score: cf.raw,
      repeat_score: rp.raw,
      season_score: ss.raw,
      raw_weighted_sum,
      risk_penalty,
      opportunity_score,
      tier,
    },
  };
}

function computeConfidence(c, factorRows) {
  const div = Math.min(1, num(c.source_count) / 5);
  const completeness = 0.7;
  const freshness = Math.max(0, 1 - Math.min(30, num(c.days_since_first_seen)) / 30);
  return clamp(round1((div + completeness + freshness) / 3 * 10), 0, 10);
}

const scoringRunRow = $("2. Begin scoring_run").first().json || {};
const scoring_run_id = scoringRunRow.scoring_run_id;
const weightRows = $("4. Read score_weights (enabled)")
  .all()
  .map((i) => i.json || {});
const weights = { ...DEFAULT_WEIGHTS };
for (const r of weightRows) {
  const d = str(r.dimension);
  if (!(d in weights)) continue;
  if (!(r.enabled === true || str(r.enabled).toLowerCase() === "true")) continue;
  const w = num(r.weight);
  if (w > 0) weights[d] = w;
}

const canonicalRows = $("3. Read canonical_signals (ready)")
  .all()
  .map((i) => i.json || {})
  .filter((r) => str(r.signal_id) && str(r.status).toLowerCase() === "ready");

const run_id = "run_wf_score_and_cluster_" + Date.now();
const run_started = new Date().toISOString();
const runDate = run_started.slice(0, 10);
function envOr(key, fallback) {
  // n8n blocks `$env` access by default (NodeOperationError: access to env vars
  // denied). Reading any property on `$env` throws even when the variable
  // exists, so wrap the lookup and fall back to the documented production
  // defaults from the `confidence_threshold` decision in LAYER2_DECISIONS.md.
  try {
    if (typeof $env !== "undefined" && $env[key]) return $env[key];
  } catch (_e) { /* env access denied — use fallback */ }
  return fallback;
}
const scorerVersion = str(envOr("LAYER2_SCORING_VERSION", "1.0.0")) || "1.0.0";
const approveTh = num(envOr("LAYER2_APPROVE_THRESHOLD", 75));
const reviewTh = num(envOr("LAYER2_REVIEW_THRESHOLD", 55));

const opportunity_candidate_upsert = [];
const opportunity_score_rows = [];
const opportunity_score_factor_rows = [];
const workflow_outbox_rows = [];
const normalized_terms_updates = [];
const scored_rows = [];

let tier_A_count = 0;
let tier_B_count = 0;
let tier_C_count = 0;
let rejected_count = 0;
let scoreSum = 0;
let topScore = -1;
let topKeyword = "";

for (const cs of canonicalRows) {
  const lineage = parseJson(cs.lineage, {});
  const canonical_id = str(lineage.normalized_term_id);
  if (!canonical_id) continue;
  const cand = buildSyntheticFromCanonical(cs);
  const scored = scoreDimensions(cand, weights);
  const opportunity_id = uuidFromSeed("opp|" + canonical_id);
  const score_id = uuidFromSeed("score|" + canonical_id + "|" + scoring_run_id);
  const conf = computeConfidence(cand, scored.dimensions);
  const total = scored.totals.opportunity_score;

  let readiness_status = "scored";
  let recommendation = "review";
  const riskFlags = parseJson(cs.risk_flags, {});
  if (riskFlags.has_high_risk || riskNorm(cand.compliance_risk) === "high") {
    readiness_status = "rejected";
    recommendation = "reject";
    rejected_count++;
  } else if (conf < reviewTh) {
    readiness_status = "needs_review";
    recommendation = "review";
  } else if (total >= approveTh) {
    readiness_status = "approved_for_creative";
    recommendation = "approve";
  } else {
    readiness_status = "scored";
    recommendation = "hold";
  }

  const tier = scored.totals.tier;
  if (tier === "A") tier_A_count++;
  else if (tier === "B") tier_B_count++;
  else if (tier === "C") tier_C_count++;
  else if (readiness_status !== "rejected") rejected_count++;

  scoreSum += total;
  if (total > topScore) {
    topScore = total;
    topKeyword = cand.niche_keyword;
  }

  scored_rows.push({
    tier,
    canonical_id,
    niche_keyword: cand.niche_keyword,
    opportunity_id,
    total_score: total,
  });

  opportunity_candidate_upsert.push({
    opportunity_id,
    candidate_version: scorerVersion,
    cluster_id: null,
    title: cand.niche_keyword,
    primary_niche: cand.theme,
    sub_niche: null,
    target_audience: JSON.stringify({ primary: cand.target_audience }),
    product_type_candidates: JSON.stringify(cand.product_formats),
    commercial_hypothesis: "",
    creative_hypotheses: JSON.stringify([]),
    market_context: JSON.stringify({ seasonality_flag: cand.seasonality_flag, tier }),
    risk_level: riskNorm(cand.compliance_risk) === "high" ? "high" : "medium",
    readiness_status,
    latest_score_id: score_id,
    latest_score: total,
    latest_confidence: conf,
    score_version: scorerVersion,
    canonical_id,
  });

  opportunity_score_rows.push({
    score_id,
    opportunity_id,
    scoring_run_id,
    score_version: scorerVersion,
    total_score: total,
    confidence_score: conf,
    recommendation,
    summary_reason: "layer2_inline_scorer",
    positive_drivers: { tier },
    negative_drivers: { risk_penalty: scored.totals.risk_penalty },
    evidence_refs: { canonical_signal_id: cs.signal_id },
  });

  for (const f of scored.dimensions) {
    opportunity_score_factor_rows.push({
      factor_id: uuidFromSeed("fac|" + score_id + "|" + f.factor_name + "|" + f.factor_reason),
      score_id,
      factor_name: f.factor_name,
      raw_value: f.raw_value,
      weight: f.weight,
      factor_value: f.factor_value,
      factor_reason: f.factor_reason,
      evidence: null,
    });
  }

  workflow_outbox_rows.push({
    aggregate_type: "opportunity",
    aggregate_id: opportunity_id,
    event_type: "opportunity_scored",
    payload: { score_id, canonical_id, total_score: total },
    schema_version: "v1",
  });
  if (readiness_status === "needs_review") {
    workflow_outbox_rows.push({
      aggregate_type: "opportunity",
      aggregate_id: opportunity_id,
      event_type: "opportunity_needs_review",
      payload: { score_id },
      schema_version: "v1",
    });
  }
  if (readiness_status === "approved_for_creative") {
    workflow_outbox_rows.push({
      aggregate_type: "opportunity",
      aggregate_id: opportunity_id,
      event_type: "opportunity_approved_for_creative",
      payload: { score_id },
      schema_version: "v1",
    });
  }
  if (readiness_status === "rejected") {
    workflow_outbox_rows.push({
      aggregate_type: "opportunity",
      aggregate_id: opportunity_id,
      event_type: "opportunity_rejected",
      payload: { score_id },
      schema_version: "v1",
    });
  }

  normalized_terms_updates.push({
    canonical_id,
    canonical_term: cand.niche_keyword,
    last_scored_at: run_started,
    latest_opp_id: opportunity_id,
    latest_opportunity_score: total,
    latest_tier: tier,
  });
}

const candidates_evaluated = opportunity_candidate_upsert.length;
const audit_row = {
  audit_id: "aud_" + runDate + "_" + run_id,
  run_date: runDate,
  run_id,
  candidates_evaluated,
  // Lowercase keys: jsonb_to_recordset matches by Postgres-folded identifier
  // names. The columns in scoring_audit_log are case-insensitively
  // tier_a_count/tier_b_count/tier_c_count (DDL uses tier_A_count but Postgres
  // folds unquoted identifiers to lower case), so the JSON keys must follow.
  tier_a_count: tier_A_count,
  tier_b_count: tier_B_count,
  tier_c_count: tier_C_count,
  rejected_count,
  avg_opportunity_score: candidates_evaluated ? round1(scoreSum / candidates_evaluated) : 0,
  top_opportunity: topKeyword,
  scorer_version: scorerVersion,
  notes: "layer2",
};

return [
  {
    json: {
      run_id,
      run_started,
      scoring_run_id,
      opportunity_candidate_upsert,
      opportunity_score_rows,
      opportunity_score_factor_rows,
      workflow_outbox_rows,
      normalized_terms_updates,
      audit_row,
      scoring_metrics: {
        candidates_evaluated,
        scoring_run_id,
      },
      scored_rows,
    },
  },
];
