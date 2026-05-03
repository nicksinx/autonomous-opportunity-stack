-- Per-stage success rate and timing in the last 24 hours.

CREATE OR REPLACE VIEW v_stage_run_health_24h AS
SELECT
  workflow_name,
  stage_name,
  COUNT(*)                                                       AS event_count,
  COUNT(*) FILTER (WHERE LOWER(status) = 'success')              AS success_count,
  COUNT(*) FILTER (WHERE LOWER(status) IN ('error','timeout'))   AS error_count,
  COUNT(*) FILTER (WHERE LOWER(status) = 'warn')                 AS warn_count,
  ROUND(AVG(duration_ms)::NUMERIC, 0)                            AS avg_duration_ms,
  MAX(duration_ms)                                               AS max_duration_ms,
  SUM(rows_in)                                                   AS total_rows_in,
  SUM(rows_out)                                                  AS total_rows_out,
  MAX(started_at)                                                AS last_started_at
FROM stage_run_logs
WHERE started_at >= NOW() - INTERVAL '24 hours'
  AND event_type IN ('end','error','warn')
GROUP BY workflow_name, stage_name
ORDER BY workflow_name, stage_name;
