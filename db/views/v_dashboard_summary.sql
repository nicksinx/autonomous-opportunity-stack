-- Replaces formula-driven `dashboard` tab from build_scoring_dashboard.gs.
-- Provides last-run tier counts, avg opportunity score, and Top-10 listings.

CREATE OR REPLACE VIEW v_dashboard_summary AS
WITH latest_run AS (
  SELECT MAX(run_date) AS run_date FROM opportunity_scores
),
latest_rows AS (
  SELECT o.*
    FROM opportunity_scores o
    JOIN latest_run lr USING (run_date)
)
SELECT
  (SELECT run_date FROM latest_run)                                  AS latest_run_date,
  COUNT(*) FILTER (WHERE tier = 'A')                                 AS tier_a_count,
  COUNT(*) FILTER (WHERE tier = 'B')                                 AS tier_b_count,
  COUNT(*) FILTER (WHERE tier = 'C')                                 AS tier_c_count,
  COUNT(*) FILTER (WHERE tier = 'reject')                            AS tier_reject_count,
  ROUND(AVG(opportunity_score)::NUMERIC, 2)                          AS avg_opportunity_score,
  ROUND(AVG(opportunity_score) FILTER (WHERE tier = 'A')::NUMERIC,2) AS avg_tier_a_score,
  COUNT(*)                                                           AS candidates_evaluated
FROM latest_rows;

CREATE OR REPLACE VIEW v_dashboard_top10 AS
WITH latest_run AS (
  SELECT MAX(run_date) AS run_date FROM opportunity_scores
)
SELECT
  o.opp_id,
  o.canonical_id,
  o.run_date,
  o.niche_keyword,
  o.target_audience,
  o.theme,
  -- Pin type for CREATE OR REPLACE (Layer 2 view uses unconstrained numeric on total_score).
  (o.opportunity_score)::numeric(6, 2) AS opportunity_score,
  o.tier,
  o.action,
  o.compliance_risk
FROM opportunity_scores o
JOIN latest_run lr USING (run_date)
ORDER BY o.opportunity_score DESC NULLS LAST
LIMIT 10;
