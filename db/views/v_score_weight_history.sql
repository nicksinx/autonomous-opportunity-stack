CREATE OR REPLACE VIEW v_score_weight_history AS
SELECT
  h.history_id,
  h.dimension,
  h.prior_weight,
  h.new_weight,
  h.calibrated_at,
  h.trigger_run_id,
  h.notes,
  sw.enabled AS dimension_enabled
FROM score_weight_history h
LEFT JOIN score_weights sw ON sw.dimension = h.dimension;
