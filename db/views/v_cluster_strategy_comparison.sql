-- Compare cluster richness by strategy key (cluster_key + cluster_version).
CREATE OR REPLACE VIEW v_cluster_strategy_comparison AS
SELECT
  tc.cluster_version AS strategy_label,
  COUNT(*)::bigint AS cluster_count,
  SUM(tc.signal_count)::bigint AS total_signals
FROM trend_cluster_v2 tc
GROUP BY tc.cluster_version;
