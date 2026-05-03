CREATE OR REPLACE VIEW v_scoring_run_health AS
SELECT
  trigger_type,
  status,
  COUNT(*) AS run_count,
  AVG(EXTRACT(EPOCH FROM (finished_at - started_at))) FILTER (WHERE finished_at IS NOT NULL) AS mean_duration_s,
  AVG((metrics->>'records_processed')::numeric) FILTER (WHERE metrics ? 'records_processed') AS mean_records_processed
FROM scoring_runs
GROUP BY trigger_type, status;
