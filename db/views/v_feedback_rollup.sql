-- Rolls performance_feedback up to opp_id with realised vs forecast contrast.

CREATE OR REPLACE VIEW v_feedback_rollup AS
SELECT
  pf.opp_id,
  o.canonical_id,
  o.run_date            AS scored_run_date,
  o.tier,
  (o.opportunity_score)::numeric(6, 2)         AS opportunity_score,
  COUNT(pf.feedback_id)                          AS feedback_count,
  MIN(pf.feedback_date)                          AS first_feedback_date,
  MAX(pf.feedback_date)                          AS last_feedback_date,
  SUM(pf.units_sold_30d)                         AS total_units_sold_30d,
  SUM(pf.revenue_30d)                            AS total_revenue_30d,
  ROUND(AVG(pf.gross_margin_pct)::NUMERIC,     2) AS avg_gross_margin_pct,
  ROUND(AVG(pf.return_rate_pct)::NUMERIC,      2) AS avg_return_rate_pct,
  ROUND(AVG(pf.ctr_pct)::NUMERIC,              2) AS avg_ctr_pct,
  ROUND(AVG(pf.conversion_rate_pct)::NUMERIC,  2) AS avg_conversion_rate_pct
FROM performance_feedback pf
LEFT JOIN opportunity_scores o ON o.opp_id = pf.opp_id
GROUP BY pf.opp_id, o.canonical_id, o.run_date, o.tier, (o.opportunity_score)::numeric(6, 2)
ORDER BY total_revenue_30d DESC NULLS LAST;
