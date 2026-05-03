-- Latest source_health row per source for the most recent run_date.

CREATE OR REPLACE VIEW v_source_health_today AS
WITH latest_per_source AS (
  SELECT DISTINCT ON (source_name)
    source_name,
    run_id,
    run_date,
    status,
    rows_in,
    rows_valid,
    rows_rejected,
    duration_ms,
    last_error,
    http_status_codes,
    consecutive_failures,
    updated_at
  FROM source_health
  WHERE run_date >= CURRENT_DATE - INTERVAL '2 days'
  ORDER BY source_name, updated_at DESC
)
SELECT *
  FROM latest_per_source
ORDER BY status DESC, source_name;
