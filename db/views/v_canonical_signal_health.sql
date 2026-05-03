-- Operational health for canonical_signals intake contract.

CREATE OR REPLACE VIEW v_canonical_signal_health AS
WITH by_status AS (
  SELECT status, COUNT(*) AS row_count
  FROM canonical_signals
  GROUP BY status
),
by_source_type AS (
  SELECT source_type, COUNT(*) AS row_count
  FROM canonical_signals
  GROUP BY source_type
),
by_contract AS (
  SELECT contract_version, COUNT(*) AS row_count
  FROM canonical_signals
  GROUP BY contract_version
),
dedupe_collisions AS (
  SELECT dedupe_key, COUNT(*) AS collision_count
  FROM canonical_signals
  WHERE ingested_at >= NOW() - INTERVAL '7 days'
  GROUP BY dedupe_key
  HAVING COUNT(*) > 1
)
SELECT
  (SELECT COALESCE(jsonb_object_agg(status, row_count), '{}'::jsonb) FROM by_status) AS counts_by_status,
  (SELECT COALESCE(jsonb_object_agg(source_type, row_count), '{}'::jsonb) FROM by_source_type) AS counts_by_source_type,
  (SELECT COALESCE(jsonb_object_agg(contract_version, row_count), '{}'::jsonb) FROM by_contract) AS counts_by_contract_version,
  (SELECT COUNT(*) FROM dedupe_collisions) AS dedupe_collision_groups_last_7d,
  (SELECT COALESCE(json_agg(dedupe_key), '[]'::json) FROM (SELECT dedupe_key FROM dedupe_collisions LIMIT 50) s) AS sample_colliding_dedupe_keys;
