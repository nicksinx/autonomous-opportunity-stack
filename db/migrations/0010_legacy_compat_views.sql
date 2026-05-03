-- Phase 4 — Rename legacy snapshot tables and recreate dashboard-facing views over Layer 2.

BEGIN;

ALTER TABLE IF EXISTS opportunity_scores RENAME TO opportunity_scores_legacy;
ALTER TABLE IF EXISTS trend_scores RENAME TO trend_scores_legacy;

ALTER TABLE IF EXISTS score_components DROP CONSTRAINT IF EXISTS score_components_opp_id_fkey;
ALTER TABLE IF EXISTS performance_feedback DROP CONSTRAINT IF EXISTS performance_feedback_opp_id_fkey;

ALTER TABLE score_components
  ADD CONSTRAINT score_components_opp_id_fkey
  FOREIGN KEY (opp_id) REFERENCES opportunity_scores_legacy (opp_id) ON DELETE CASCADE;

ALTER TABLE performance_feedback
  ADD CONSTRAINT performance_feedback_opp_id_fkey
  FOREIGN KEY (opp_id) REFERENCES opportunity_scores_legacy (opp_id) ON DELETE SET NULL;

CREATE OR REPLACE VIEW opportunity_scores AS
SELECT
  oc.opportunity_id::text AS opp_id,
  oc.canonical_id,
  os.created_at::date AS run_date,
  oc.title AS niche_keyword,
  COALESCE(oc.target_audience->>'primary', oc.primary_niche) AS target_audience,
  oc.primary_niche AS theme,
  COALESCE(oc.market_context->>'seasonality_flag', 'unknown') AS seasonality_flag,
  COALESCE(oc.product_type_candidates::text, '') AS product_formats,
  oc.risk_level AS compliance_risk,
  fac.demand_score,
  fac.competition_score,
  fac.conversion_score,
  fac.creative_score,
  fac.margin_score,
  fac.ops_score,
  fac.catalog_score,
  fac.repeat_score,
  fac.season_score,
  os.total_score AS raw_weighted_sum,
  COALESCE((os.negative_drivers->>'risk_penalty')::numeric, 0) AS risk_penalty,
  os.total_score AS opportunity_score,
  CASE
    WHEN os.total_score >= 75 THEN 'A'
    WHEN os.total_score >= 55 THEN 'B'
    WHEN os.total_score >= 35 THEN 'C'
    ELSE 'reject'
  END AS tier,
  CASE
    WHEN os.total_score >= 75 THEN 'Generate range brief immediately'
    WHEN os.total_score >= 55 THEN 'Queue for brief review — validate competition manually'
    WHEN os.total_score >= 35 THEN 'Monitor for 7 days before acting'
    ELSE 'Discard — insufficient opportunity signal'
  END AS action,
  os.score_version AS scorer_version,
  os.summary_reason AS score_notes
FROM opportunity_candidate oc
JOIN opportunity_score os ON os.score_id = oc.latest_score_id
LEFT JOIN LATERAL (
  SELECT
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'demand_strength') AS demand_score,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'competition_gap') AS competition_score,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'conversion_potential') AS conversion_score,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'creative_diff') AS creative_score,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'margin_potential') AS margin_score,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'ops_feasibility') AS ops_score,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'catalog_fit') AS catalog_score,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'repeatability') AS repeat_score,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'seasonality_timing') AS season_score
  FROM opportunity_score_factor f
  WHERE f.score_id = os.score_id
) fac ON TRUE;

CREATE OR REPLACE VIEW trend_scores AS
SELECT
  ('ts_' || oc.opportunity_id::text || '_' || to_char(os.created_at::date, 'YYYY-MM-DD'))::text AS score_id,
  oc.canonical_id,
  os.created_at::date AS run_date,
  fac.demand_strength AS momentum_score,
  fac.catalog_fit AS pod_fit_score,
  fac.conversion_potential AS buyer_intent_score,
  fac.repeatability AS range_depth_score,
  fac.creative_diff AS novelty_score,
  LEAST(10::numeric, GREATEST(0::numeric, 10 - COALESCE((os.negative_drivers->>'risk_penalty')::numeric, 0) / 2.5)) AS risk_score,
  os.total_score,
  CASE os.recommendation
    WHEN 'approve' THEN 'design_now'
    WHEN 'review' THEN 'review_required'
    WHEN 'hold' THEN 'watchlist'
    ELSE 'reject'
  END AS decision
FROM opportunity_candidate oc
JOIN opportunity_score os ON os.score_id = oc.latest_score_id
LEFT JOIN LATERAL (
  SELECT
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'demand_strength') AS demand_strength,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'catalog_fit') AS catalog_fit,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'conversion_potential') AS conversion_potential,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'repeatability') AS repeatability,
    MAX(f.factor_value) FILTER (WHERE f.factor_name = 'creative_diff') AS creative_diff
  FROM opportunity_score_factor f
  WHERE f.score_id = os.score_id
) fac ON TRUE;

COMMIT;
