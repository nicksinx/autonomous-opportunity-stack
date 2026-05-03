-- Human review decisions and lifecycle transitions.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS opportunity_lifecycle_log (
  log_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id   UUID NOT NULL REFERENCES opportunity_candidate (opportunity_id) ON DELETE CASCADE,
  from_status      TEXT,
  to_status        TEXT NOT NULL,
  actor            TEXT NOT NULL DEFAULT 'system',
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opportunity_lifecycle_log_opp
  ON opportunity_lifecycle_log (opportunity_id, created_at DESC);

COMMIT;
