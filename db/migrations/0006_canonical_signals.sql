-- Layer 2 Phase 2 — canonical_signals contract table (spec §10.1 alignment).

BEGIN;

CREATE TABLE IF NOT EXISTS canonical_signals (
  signal_id              TEXT PRIMARY KEY,
  contract_version       TEXT NOT NULL,
  source_type            TEXT NOT NULL,
  source_name            TEXT NOT NULL REFERENCES sources_config (source_name),
  source_record_id       TEXT,
  intake_run_id          TEXT,
  observed_at            TIMESTAMPTZ,
  ingested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  normalized_topic       TEXT,
  normalized_niche       TEXT,
  normalized_sub_niche   TEXT,
  audience_hint          JSONB,
  product_type_hints     JSONB,
  trend_metrics          JSONB,
  sentiment_metrics      JSONB,
  competition_metrics    JSONB,
  seasonality_hint       JSONB,
  enrichment             JSONB,
  risk_flags             JSONB,
  quality_score          NUMERIC(8,4),
  lineage                JSONB NOT NULL,
  dedupe_key             TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'ready',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_canonical_signals_status
    CHECK (status IN ('ready','suppressed','invalid','archived','quarantined')),
  CONSTRAINT chk_canonical_signals_source_type
    CHECK (source_type IN ('marketplace','search','social','reviews','csv','internal','unknown')),
  CONSTRAINT uq_canonical_signals_dedupe_contract UNIQUE (dedupe_key, contract_version)
);

CREATE INDEX IF NOT EXISTS idx_canonical_signals_status
  ON canonical_signals (status);
CREATE INDEX IF NOT EXISTS idx_canonical_signals_source_type
  ON canonical_signals (source_type);
CREATE INDEX IF NOT EXISTS idx_canonical_signals_dedupe_key
  ON canonical_signals (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_canonical_signals_normalized_topic
  ON canonical_signals (normalized_topic);
CREATE INDEX IF NOT EXISTS idx_canonical_signals_ingested_at
  ON canonical_signals (ingested_at);

DROP TRIGGER IF EXISTS trg_canonical_signals_updated_at ON canonical_signals;
CREATE TRIGGER trg_canonical_signals_updated_at
  BEFORE UPDATE ON canonical_signals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
