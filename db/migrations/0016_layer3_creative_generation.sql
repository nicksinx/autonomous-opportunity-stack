-- Layer 3 — creative generation runs, outputs (Midjourney prompts, OpenAI images, SVG), Drive pointers.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS creative_generation_run (
  run_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id      UUID NOT NULL REFERENCES opportunity_candidate (opportunity_id) ON DELETE CASCADE,
  score_id            UUID REFERENCES opportunity_score (score_id) ON DELETE SET NULL,
  status              TEXT NOT NULL,
  drive_folder_id     TEXT,
  drive_folder_url    TEXT,
  prompt_pack_json    JSONB,
  idempotency_key     TEXT NOT NULL,
  workflow_version    TEXT NOT NULL DEFAULT 'layer3-v1',
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ,
  error_summary       TEXT,
  CONSTRAINT chk_creative_generation_run_status
    CHECK (status IN ('pending','processing','success','partial','failed'))
);

CREATE INDEX IF NOT EXISTS idx_creative_generation_run_idempotency
  ON creative_generation_run (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_creative_generation_run_opp
  ON creative_generation_run (opportunity_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_creative_generation_run_status
  ON creative_generation_run (status);

CREATE TABLE IF NOT EXISTS creative_output (
  output_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES creative_generation_run (run_id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  variant_index   INTEGER NOT NULL DEFAULT 0,
  mime_type       TEXT,
  drive_file_id   TEXT,
  drive_web_view_link TEXT,
  sha256          TEXT,
  body_text       TEXT,
  metadata_json   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_creative_output_kind
    CHECK (kind IN ('mj_prompt_bundle','openai_image','svg_sample')),
  CONSTRAINT uq_creative_output_run_kind_variant
    UNIQUE (run_id, kind, variant_index)
);

CREATE INDEX IF NOT EXISTS idx_creative_output_run
  ON creative_output (run_id);

COMMIT;
