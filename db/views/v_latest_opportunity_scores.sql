CREATE OR REPLACE VIEW v_latest_opportunity_scores AS
SELECT DISTINCT ON (os.opportunity_id)
  os.opportunity_id,
  os.score_id,
  os.scoring_run_id,
  os.total_score,
  os.confidence_score,
  os.recommendation,
  os.summary_reason,
  os.created_at
FROM opportunity_score os
ORDER BY os.opportunity_id, os.created_at DESC;
