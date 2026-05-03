-- Audit trail for calibrated weights (ties to score_weights.dimension).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS score_weight_history (
  history_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension       TEXT NOT NULL REFERENCES score_weights (dimension) ON DELETE CASCADE,
  prior_weight    NUMERIC(4,2),
  new_weight      NUMERIC(4,2) NOT NULL,
  calibrated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger_run_id  TEXT,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_score_weight_history_dim_time
  ON score_weight_history (dimension, calibrated_at DESC);

COMMIT;
