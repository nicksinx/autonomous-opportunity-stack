-- Phase 3 — scoring run registry.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS scoring_runs (
  scoring_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type   TEXT NOT NULL,
  trigger_ref    TEXT,
  scoring_version TEXT NOT NULL,
  scope          JSONB NOT NULL,
  status         TEXT NOT NULL,
  metrics        JSONB,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  CONSTRAINT chk_scoring_runs_trigger
    CHECK (trigger_type IN ('event','batch','replay','manual','scheduled')),
  CONSTRAINT chk_scoring_runs_status
    CHECK (status IN ('pending','running','success','partial','failed'))
);

CREATE INDEX IF NOT EXISTS idx_scoring_runs_status_started
  ON scoring_runs (status, started_at);

COMMIT;
