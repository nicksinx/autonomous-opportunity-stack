-- Phase 3 — transactional workflow outbox (spec §18.2).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workflow_outbox (
  event_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  schema_version TEXT NOT NULL,
  scheduled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at   TIMESTAMPTZ,
  retry_count    INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',
  CONSTRAINT chk_workflow_outbox_status
    CHECK (status IN ('pending','processing','complete','deadletter'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_outbox_status_scheduled
  ON workflow_outbox (status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_workflow_outbox_aggregate
  ON workflow_outbox (aggregate_type, aggregate_id);

COMMIT;
