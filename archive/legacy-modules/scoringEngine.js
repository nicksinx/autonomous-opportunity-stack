/**
 * Multi-factor Opportunity Scoring engine.
 *
 * Candidate input type is the output shape from opportunityBuilder.js.
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

/**
 * @typedef {Object} ScoreComponent
 * @property {string} component_id
 * @property {string} opp_id
 * @property {string} run_date
 * @property {string} dimension
 * @property {string} component_name
 * @property {number} raw_value
 * @property {number} normalized_value
 * @property {number} weight
 * @property {number} weighted_contribution
 * @property {string} notes
 */

/**
 * Score one opportunity candidate.
 *
 * @param {Object<string, any>} candidate CandidateOpportunity from opportunityBuilder.
 * @param {Object<string, number>} weights Dimension weights keyed by score_weights dimension.
 * @param {{ scorerVersion?: string, runDate?: string }=} options Runtime options.
 * @returns {Object<string, any>}
 */
function scoreOpportunity(candidate, weights, options) {
  const c = candidate || {};
  const runDate = str((options && options.runDate) || isoDay(new Date()));
  const scorerVersion = str((options && options.scorerVersion) || "v1");
  const canonicalId = str(c.canonical_id);
  const oppId = `opp_${canonicalId || "unknown"}_${runDate}`;

  const w = normalizeWeights(weights);
  /** @type {ScoreComponent[]} */
  const components = [];
  /** @type {string[]} */
  const notes = [];

  const demand = scoreDemandStrength(c, oppId, runDate, w.demand_strength, components);
  const competition = scoreCompetitionGap(c, oppId, runDate, w.competition_gap, components, notes);
  const conversion = scoreConversionPotential(
    c,
    oppId,
    runDate,
    w.conversion_potential,
    components
  );
  const creative = scoreCreativeDifferentiation(c, oppId, runDate, w.creative_diff, components);
  const margin = scoreMarginPotential(c, oppId, runDate, w.margin_potential, components);
  const ops = scoreOperationalFeasibility(c, oppId, runDate, w.ops_feasibility, components);
  const catalog = scoreCatalogFit(c, oppId, runDate, w.catalog_fit, components);
  const repeat = scoreRepeatability(c, oppId, runDate, w.repeatability, components);
  const season = scoreSeasonalityTiming(c, oppId, runDate, w.seasonality_timing, components);

  const rawWeightedSum = round1(
    demand.weighted +
      competition.weighted +
      conversion.weighted +
      creative.weighted +
      margin.weighted +
      ops.weighted +
      catalog.weighted +
      repeat.weighted +
      season.weighted
  );

  const riskPenalty = calculateRiskPenalty(c, demand.raw, conversion.raw);
  const opportunityScore = clamp(round1(rawWeightedSum - riskPenalty), 0, 100);
  const tierAction = assignTier(opportunityScore);

  if (str(c.compliance_risk) === "high") notes.push("high_compliance_risk");
  if (str(c.seasonality_flag) === "unknown") notes.push("seasonality_unknown");

  return {
    opp_id: oppId,
    canonical_id: canonicalId,
    run_date: runDate,

    niche_keyword: str(c.niche_keyword),
    target_audience: str(c.target_audience || "general"),
    theme: str(c.theme || "unknown"),
    seasonality_flag: str(c.seasonality_flag || "unknown"),
    product_formats: arr(c.product_formats).join("|"),
    compliance_risk: complianceRisk(c.compliance_risk),

    demand_score: demand.raw,
    competition_score: competition.raw,
    conversion_score: conversion.raw,
    creative_score: creative.raw,
    margin_score: margin.raw,
    ops_score: ops.raw,
    catalog_score: catalog.raw,
    repeat_score: repeat.raw,
    season_score: season.raw,

    raw_weighted_sum: rawWeightedSum,
    risk_penalty: riskPenalty,
    opportunity_score: opportunityScore,
    tier: tierAction.tier,
    action: tierAction.action,
    scorer_version: scorerVersion,
    score_notes: unique(notes).join("|"),
    components,
  };
}

/**
 * Score a batch and sort descending by final score.
 *
 * @param {Array<Object<string, any>>} candidates Array of candidate opportunities.
 * @param {Object<string, number>} weights Dimension weights.
 * @param {{ scorerVersion?: string, runDate?: string }=} options Runtime options.
 * @returns {Array<Object<string, any>>}
 */
function batchScore(candidates, weights, options) {
  const list = Array.isArray(candidates) ? candidates : [];
  const scored = [];
  for (const candidate of list) {
    try {
      scored.push(scoreOpportunity(candidate, weights, options));
    } catch (e) {
      // Keep batch runs resilient: skip only failing records.
      // eslint-disable-next-line no-console
      console.warn(
        `batchScore skipped candidate ${str(candidate?.canonical_id || "unknown")}: ${String(
          e?.message || e,
        )}`,
      );
    }
  }
  return scored.sort((a, b) => b.opportunity_score - a.opportunity_score);
}

/**
 * DEMAND STRENGTH dimension scorer (0-10).
 * @private
 */
function scoreDemandStrength(c, oppId, runDate, weight, components) {
  const dim = "demand_strength";
  let score = 0;
  const vh = str(c.velocity_hint).toLowerCase();
  if (vh === "high") {
    score += addRule(components, oppId, runDate, dim, weight, "velocity_high", 1, 3, "velocity_hint=high");
  } else if (vh === "medium") {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "velocity_medium",
      1,
      2,
      "velocity_hint=medium"
    );
  } else {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "velocity_low_or_unknown",
      1,
      1,
      "velocity_hint low/unknown"
    );
  }
  if (toBool(c.google_signal)) {
    score += addRule(components, oppId, runDate, dim, weight, "google_signal", 1, 2, "google_trends present");
  } else {
    addRule(components, oppId, runDate, dim, weight, "google_signal", 0, 0, "google_trends absent");
  }
  if (toBool(c.social_signal)) {
    score += addRule(components, oppId, runDate, dim, weight, "social_signal", 1, 1.5, "tiktok_creative present");
  } else {
    addRule(components, oppId, runDate, dim, weight, "social_signal", 0, 0, "tiktok_creative absent");
  }
  if (toBool(c.pinterest_signal)) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "pinterest_signal",
      1,
      1,
      "pinterest_trends present"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "pinterest_signal",
      0,
      0,
      "pinterest_trends absent"
    );
  }
  if (num(c.persistence_windows) >= 2) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "persistence_windows_ge_2",
      num(c.persistence_windows),
      1.5,
      "trend persists across days"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "persistence_windows_ge_2",
      num(c.persistence_windows),
      0,
      "trend persistence not met"
    );
  }
  if (num(c.days_since_first_seen) <= 3) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "freshness_le_3_days",
      num(c.days_since_first_seen),
      1,
      "very fresh trend"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "freshness_le_3_days",
      num(c.days_since_first_seen),
      0,
      "not very fresh"
    );
  }
  return finalizeDimension(score, weight);
}

/**
 * COMPETITION GAP dimension scorer (0-10).
 * @private
 */
function scoreCompetitionGap(c, oppId, runDate, weight, components, notes) {
  const dim = "competition_gap";
  let score = addRule(components, oppId, runDate, dim, weight, "base_neutral", 5, 5, "neutral baseline");

  if (complianceRisk(c.compliance_risk) === "low") {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "low_compliance_risk_bonus",
      1,
      2,
      "lower legal caution pressure"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "low_compliance_risk_bonus",
      0,
      0,
      "bonus condition not met"
    );
  }
  if (num(c.alias_count) <= 2) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "alias_count_le_2",
      num(c.alias_count),
      1.5,
      "narrow term suggests lower direct competition"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "alias_count_le_2",
      num(c.alias_count),
      0,
      "condition not met"
    );
  }
  if (num(c.source_count) >= 3) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "source_count_ge_3",
      num(c.source_count),
      1.5,
      "validated across multiple sources"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "source_count_ge_3",
      num(c.source_count),
      0,
      "condition not met"
    );
  }
  if (num(c.etsy_phrase_count) >= 10) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "etsy_phrase_count_ge_10_penalty",
      num(c.etsy_phrase_count),
      -2,
      "many buyer phrases may imply crowded market"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "etsy_phrase_count_ge_10_penalty",
      num(c.etsy_phrase_count),
      0,
      "penalty condition not met"
    );
  }
  notes.push("competition_gap_manual_review");
  return finalizeDimension(score, weight);
}

/**
 * CONVERSION POTENTIAL dimension scorer (0-10).
 * @private
 */
function scoreConversionPotential(c, oppId, runDate, weight, components) {
  const dim = "conversion_potential";
  let score = 0;
  if (toBool(c.has_identity_word)) {
    score += addRule(components, oppId, runDate, dim, weight, "identity_word", 1, 3, "identity resonance");
  } else addRule(components, oppId, runDate, dim, weight, "identity_word", 0, 0, "condition not met");

  if (toBool(c.has_occasion_word)) {
    score += addRule(components, oppId, runDate, dim, weight, "occasion_word", 1, 2, "gift trigger");
  } else addRule(components, oppId, runDate, dim, weight, "occasion_word", 0, 0, "condition not met");

  if (num(c.phrase_length_words) <= 4) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "phrase_length_le_4",
      num(c.phrase_length_words),
      2,
      "thumbnail clarity"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "phrase_length_le_4",
      num(c.phrase_length_words),
      0,
      "condition not met"
    );
  }
  if (num(c.etsy_phrase_count) >= 3) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "etsy_phrase_count_ge_3",
      num(c.etsy_phrase_count),
      1.5,
      "buyer language available"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "etsy_phrase_count_ge_3",
      num(c.etsy_phrase_count),
      0,
      "condition not met"
    );
  }
  if (toBool(c.amazon_signal)) {
    score += addRule(components, oppId, runDate, dim, weight, "amazon_signal", 1, 1, "cross-market purchase intent");
  } else addRule(components, oppId, runDate, dim, weight, "amazon_signal", 0, 0, "condition not met");

  if (arr(c.product_formats).length >= 4) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "product_formats_ge_4",
      arr(c.product_formats).length,
      0.5,
      "mockup flexibility"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "product_formats_ge_4",
      arr(c.product_formats).length,
      0,
      "condition not met"
    );
  }
  return finalizeDimension(score, weight);
}

/**
 * CREATIVE DIFFERENTIATION dimension scorer (0-10).
 * @private
 */
function scoreCreativeDifferentiation(c, oppId, runDate, weight, components) {
  const dim = "creative_diff";
  let score = addRule(components, oppId, runDate, dim, weight, "base", 4, 4, "starting baseline");

  if (num(c.alias_count) >= 5) {
    score += addRule(components, oppId, runDate, dim, weight, "alias_count_ge_5", num(c.alias_count), 2, "phrase variants");
  } else addRule(components, oppId, runDate, dim, weight, "alias_count_ge_5", num(c.alias_count), 0, "condition not met");

  if (arr(c.related_terms).length >= 6) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "related_terms_ge_6",
      arr(c.related_terms).length,
      2,
      "semantic field breadth"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "related_terms_ge_6",
      arr(c.related_terms).length,
      0,
      "condition not met"
    );
  }

  const risk = complianceRisk(c.compliance_risk);
  if (risk === "low") {
    score += addRule(components, oppId, runDate, dim, weight, "low_risk_bonus", 1, 2, "fewer creative constraints");
  } else addRule(components, oppId, runDate, dim, weight, "low_risk_bonus", 0, 0, "condition not met");

  if (risk === "high") {
    score += addRule(components, oppId, runDate, dim, weight, "high_risk_penalty", 1, -2, "legal constraints");
  } else addRule(components, oppId, runDate, dim, weight, "high_risk_penalty", 0, 0, "condition not met");

  if (num(c.days_since_first_seen) > 30) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "old_idea_penalty",
      num(c.days_since_first_seen),
      -1,
      "possible saturation"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "old_idea_penalty",
      num(c.days_since_first_seen),
      0,
      "condition not met"
    );
  }

  return finalizeDimension(score, weight);
}

/**
 * MARGIN POTENTIAL dimension scorer (0-10).
 * @private
 */
function scoreMarginPotential(c, oppId, runDate, weight, components) {
  const dim = "margin_potential";
  let score = addRule(components, oppId, runDate, dim, weight, "base", 5, 5, "default POD margin baseline");
  const formats = arr(c.product_formats).map((x) => str(x).toLowerCase());
  if (formats.includes("sweatshirt")) {
    score += addRule(components, oppId, runDate, dim, weight, "sweatshirt_bonus", 1, 2, "higher AOV format");
  } else addRule(components, oppId, runDate, dim, weight, "sweatshirt_bonus", 0, 0, "condition not met");

  if (formats.includes("tote_bag")) {
    score += addRule(components, oppId, runDate, dim, weight, "tote_bag_bonus", 1, 1, "extra basket value");
  } else addRule(components, oppId, runDate, dim, weight, "tote_bag_bonus", 0, 0, "condition not met");

  if (toBool(c.has_occasion_word)) {
    score += addRule(components, oppId, runDate, dim, weight, "occasion_bonus", 1, 1, "gift premium pricing");
  } else addRule(components, oppId, runDate, dim, weight, "occasion_bonus", 0, 0, "condition not met");

  const risk = complianceRisk(c.compliance_risk);
  if (risk === "high") {
    score += addRule(components, oppId, runDate, dim, weight, "high_risk_penalty", 1, -2, "potential legal/royalty drag");
  } else addRule(components, oppId, runDate, dim, weight, "high_risk_penalty", 0, 0, "condition not met");

  if (risk === "moderate") {
    score += addRule(components, oppId, runDate, dim, weight, "moderate_risk_penalty", 1, -1, "compliance friction");
  } else addRule(components, oppId, runDate, dim, weight, "moderate_risk_penalty", 0, 0, "condition not met");

  return finalizeDimension(score, weight);
}

/**
 * OPERATIONAL FEASIBILITY dimension scorer (0-10).
 * @private
 */
function scoreOperationalFeasibility(c, oppId, runDate, weight, components) {
  const dim = "ops_feasibility";
  let score = 0;
  if (num(c.phrase_length_words) <= 4) {
    score += addRule(components, oppId, runDate, dim, weight, "phrase_length_le_4", num(c.phrase_length_words), 3, "easy typography");
  } else addRule(components, oppId, runDate, dim, weight, "phrase_length_le_4", num(c.phrase_length_words), 0, "condition not met");

  if (toBool(c.has_identity_word)) {
    score += addRule(components, oppId, runDate, dim, weight, "identity_word", 1, 2, "clean noun-based design");
  } else addRule(components, oppId, runDate, dim, weight, "identity_word", 0, 0, "condition not met");

  if (complianceRisk(c.compliance_risk) === "low") {
    score += addRule(components, oppId, runDate, dim, weight, "low_risk_bonus", 1, 2, "low legal complexity");
  } else addRule(components, oppId, runDate, dim, weight, "low_risk_bonus", 0, 0, "condition not met");

  const formats = arr(c.product_formats).map((x) => str(x).toLowerCase());
  if (formats.includes("tshirt") && formats.includes("mug")) {
    score += addRule(components, oppId, runDate, dim, weight, "tshirt_and_mug", 1, 2, "proven print surfaces");
  } else addRule(components, oppId, runDate, dim, weight, "tshirt_and_mug", 0, 0, "condition not met");

  if (num(c.source_count) >= 2) {
    score += addRule(components, oppId, runDate, dim, weight, "source_count_ge_2", num(c.source_count), 1, "validated direction");
  } else addRule(components, oppId, runDate, dim, weight, "source_count_ge_2", num(c.source_count), 0, "condition not met");

  return finalizeDimension(score, weight);
}

/**
 * CATALOG FIT dimension scorer (0-10).
 * @private
 */
function scoreCatalogFit(c, oppId, runDate, weight, components) {
  const dim = "catalog_fit";
  let score = addRule(components, oppId, runDate, dim, weight, "base", 5, 5, "neutral fit baseline");
  if (toBool(c.has_identity_word)) {
    score += addRule(components, oppId, runDate, dim, weight, "identity_word_bonus", 1, 2, "identity store strategy fit");
  } else addRule(components, oppId, runDate, dim, weight, "identity_word_bonus", 0, 0, "condition not met");

  if (toBool(c.has_occasion_word)) {
    score += addRule(components, oppId, runDate, dim, weight, "occasion_word_bonus", 1, 2, "gift catalog fit");
  } else addRule(components, oppId, runDate, dim, weight, "occasion_word_bonus", 0, 0, "condition not met");

  const flag = str(c.seasonality_flag).toLowerCase();
  if (flag === "evergreen") {
    score += addRule(components, oppId, runDate, dim, weight, "evergreen_bonus", 1, 1, "always-on relevance");
  } else addRule(components, oppId, runDate, dim, weight, "evergreen_bonus", 0, 0, "condition not met");

  if (flag === "seasonal" && num(c.days_since_first_seen) > 60) {
    score += addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "stale_seasonal_penalty",
      num(c.days_since_first_seen),
      -2,
      "seasonal timing likely missed"
    );
  } else {
    addRule(
      components,
      oppId,
      runDate,
      dim,
      weight,
      "stale_seasonal_penalty",
      num(c.days_since_first_seen),
      0,
      "condition not met"
    );
  }

  return finalizeDimension(score, weight);
}

/**
 * REPEATABILITY dimension scorer (0-10).
 * @private
 */
function scoreRepeatability(c, oppId, runDate, weight, components) {
  const dim = "repeatability";
  let score = 0;
  if (toBool(c.has_identity_word)) {
    score += addRule(components, oppId, runDate, dim, weight, "identity_word", 1, 3, "role variants available");
  } else addRule(components, oppId, runDate, dim, weight, "identity_word", 0, 0, "condition not met");

  if (toBool(c.has_occasion_word)) {
    score += addRule(components, oppId, runDate, dim, weight, "occasion_word", 1, 2, "annual event loops");
  } else addRule(components, oppId, runDate, dim, weight, "occasion_word", 0, 0, "condition not met");

  if (num(c.alias_count) >= 4) {
    score += addRule(components, oppId, runDate, dim, weight, "alias_count_ge_4", num(c.alias_count), 2, "phrase-family potential");
  } else addRule(components, oppId, runDate, dim, weight, "alias_count_ge_4", num(c.alias_count), 0, "condition not met");

  if (arr(c.related_terms).length >= 8) {
    score += addRule(components, oppId, runDate, dim, weight, "related_terms_ge_8", arr(c.related_terms).length, 2, "sub-niche expansion");
  } else addRule(components, oppId, runDate, dim, weight, "related_terms_ge_8", arr(c.related_terms).length, 0, "condition not met");

  if (str(c.seasonality_flag).toLowerCase() === "evergreen") {
    score += addRule(components, oppId, runDate, dim, weight, "evergreen_bonus", 1, 1, "ongoing repeatability");
  } else addRule(components, oppId, runDate, dim, weight, "evergreen_bonus", 0, 0, "condition not met");

  return finalizeDimension(score, weight);
}

/**
 * SEASONALITY TIMING dimension scorer (0-10).
 * @private
 */
function scoreSeasonalityTiming(c, oppId, runDate, weight, components) {
  const dim = "seasonality_timing";
  let score = 0;
  const flag = str(c.seasonality_flag).toLowerCase();
  const fresh = num(c.days_since_first_seen);
  const hasOccasion = toBool(c.has_occasion_word);

  if (flag === "evergreen") {
    score += addRule(components, oppId, runDate, dim, weight, "evergreen", 1, 6, "always relevant");
  } else addRule(components, oppId, runDate, dim, weight, "evergreen", 0, 0, "condition not met");

  if (hasOccasion && fresh <= 14) {
    score += addRule(components, oppId, runDate, dim, weight, "occasion_early_window", fresh, 8, "early seasonal window");
  } else addRule(components, oppId, runDate, dim, weight, "occasion_early_window", fresh, 0, "condition not met");

  if (hasOccasion && fresh >= 15 && fresh <= 45) {
    score += addRule(components, oppId, runDate, dim, weight, "occasion_mid_window", fresh, 4, "mid seasonal window");
  } else addRule(components, oppId, runDate, dim, weight, "occasion_mid_window", fresh, 0, "condition not met");

  if (hasOccasion && fresh > 45) {
    score += addRule(components, oppId, runDate, dim, weight, "occasion_late_window", fresh, 2, "late seasonal window");
  } else addRule(components, oppId, runDate, dim, weight, "occasion_late_window", fresh, 0, "condition not met");

  if (flag === "unknown") {
    score += addRule(components, oppId, runDate, dim, weight, "unknown_neutral", 1, 4, "neutral seasonal assumption");
  } else addRule(components, oppId, runDate, dim, weight, "unknown_neutral", 0, 0, "condition not met");

  return finalizeDimension(score, weight);
}

/**
 * Calculate final risk penalty points (0-25).
 * @private
 */
function calculateRiskPenalty(c, demandScore, conversionScore) {
  let p = 0;
  const risk = complianceRisk(c.compliance_risk);
  if (risk === "high") p += 10;
  else if (risk === "moderate") p += 5;
  if (demandScore <= 2) p += 5;
  if (conversionScore <= 2) p += 5;
  return Math.min(25, p);
}

/**
 * Assign tier and action based on final score.
 * @private
 */
function assignTier(score) {
  if (score >= 75) return { tier: "A", action: "Generate range brief immediately" };
  if (score >= 55)
    return { tier: "B", action: "Queue for brief review — validate competition manually" };
  if (score >= 35) return { tier: "C", action: "Monitor for 7 days before acting" };
  return { tier: "reject", action: "Discard — insufficient opportunity signal" };
}

/**
 * Add one granular rule component and return the rule points contribution.
 * @private
 */
function addRule(components, oppId, runDate, dimension, weight, componentName, rawValue, points, notes) {
  const normalized = clamp(points / 10, -1, 1);
  const weighted = round4(normalized * weight * 100);
  components.push({
    component_id: `${oppId}_${dimension}_${components.length + 1}`,
    opp_id: oppId,
    run_date: runDate,
    dimension,
    component_name: componentName,
    raw_value: round4(rawValue),
    normalized_value: round4(normalized),
    weight: round4(weight),
    weighted_contribution: weighted,
    notes: notes || "",
  });
  return points;
}

/**
 * Finalize a dimension output.
 * @private
 */
function finalizeDimension(rawPoints, weight) {
  const raw = clamp(round1(rawPoints), 0, 10);
  const weighted = round4((raw / 10) * weight * 100);
  return { raw, weighted };
}

function normalizeWeights(input) {
  const out = { ...DEFAULT_WEIGHTS };
  const src = input && typeof input === "object" ? input : {};
  for (const k of Object.keys(out)) {
    const v = Number(src[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

function complianceRisk(v) {
  const x = str(v).toLowerCase();
  if (x === "high" || x === "moderate" || x === "low") return x;
  return "low";
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function toBool(v) {
  return v === true || String(v).toLowerCase() === "true";
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

function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function unique(a) {
  return [...new Set(a)];
}

/**
 * Hardcoded smoke tests for scoring behavior.
 */
function runTests() {
  const weights = { ...DEFAULT_WEIGHTS };
  const options = { scorerVersion: "v1-test", runDate: "2026-04-28" };

  const candidates = [
    {
      canonical_id: "can_pickleball_mom",
      niche_keyword: "pickleball mom",
      target_audience: "mom",
      theme: "sports_lifestyle",
      language: "en",
      source_count: 3,
      etsy_phrase_count: 4,
      amazon_signal: true,
      google_signal: true,
      pinterest_signal: true,
      social_signal: true,
      alias_count: 4,
      seasonality_flag: "evergreen",
      seasonality_window: "year_round",
      product_formats: ["tshirt", "mug", "sticker", "sweatshirt"],
      phrase_length_words: 2,
      has_identity_word: true,
      has_occasion_word: false,
      compliance_risk: "low",
      risk_flags: [],
      velocity_hint: "high",
      days_since_first_seen: 7,
      days_since_last_seen: 1,
      persistence_windows: 3,
      top_etsy_phrases: ["pickleball mom shirt"],
      related_terms: [
        "pickleball mom gift",
        "pickleball mom era",
        "pickleball shirt",
        "pickleball funny",
        "pickleball life",
        "pickleball lover",
        "sports mom",
        "court queen",
      ],
    },
    {
      canonical_id: "can_trump_2024",
      niche_keyword: "trump 2024",
      target_audience: "general",
      theme: "politics",
      language: "en",
      source_count: 1,
      etsy_phrase_count: 1,
      amazon_signal: false,
      google_signal: false,
      pinterest_signal: false,
      social_signal: false,
      alias_count: 1,
      seasonality_flag: "unknown",
      seasonality_window: "unknown",
      product_formats: ["tshirt", "mug", "sticker"],
      phrase_length_words: 2,
      has_identity_word: false,
      has_occasion_word: false,
      compliance_risk: "high",
      risk_flags: ["trump"],
      velocity_hint: "low",
      days_since_first_seen: 2,
      days_since_last_seen: 1,
      persistence_windows: 1,
      top_etsy_phrases: ["trump 2024 shirt"],
      related_terms: ["election shirt"],
    },
    {
      canonical_id: "can_cottagecore_aesthetic",
      niche_keyword: "cottagecore aesthetic",
      target_audience: "general",
      theme: "aesthetic",
      language: "en",
      source_count: 2,
      etsy_phrase_count: 5,
      amazon_signal: true,
      google_signal: true,
      pinterest_signal: true,
      social_signal: false,
      alias_count: 3,
      seasonality_flag: "unknown",
      seasonality_window: "unknown",
      product_formats: ["tshirt", "mug", "sticker", "tote_bag"],
      phrase_length_words: 2,
      has_identity_word: false,
      has_occasion_word: false,
      compliance_risk: "low",
      risk_flags: [],
      velocity_hint: "medium",
      days_since_first_seen: 12,
      days_since_last_seen: 1,
      persistence_windows: 2,
      top_etsy_phrases: ["cottagecore shirt", "cottagecore mug"],
      related_terms: ["mushroom", "forest", "cozy", "botanical", "vintage"],
    },
  ];

  const out = batchScore(candidates, weights, options);
  // eslint-disable-next-line no-console
  console.log("=== scoringEngine runTests ===");
  for (const r of out) {
    // eslint-disable-next-line no-console
    console.log(
      `${r.niche_keyword} => score=${r.opportunity_score} tier=${r.tier} action="${r.action}" penalty=${r.risk_penalty}`
    );
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
}

module.exports = { scoreOpportunity, batchScore };

if (require.main === module) {
  runTests();
}
