-- Phase 4 — Layer 2 scoring entities (candidate / score / factors / clusters v2).
-- cluster_members_v2 is used for trend_cluster_v2 (UUID); legacy cluster_members remains for theme_clusters.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS opportunity_candidate (
  opportunity_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_version    TEXT NOT NULL,
  cluster_id           UUID,
  title                TEXT NOT NULL,
  primary_niche        TEXT NOT NULL,
  sub_niche            TEXT,
  target_audience      JSONB,
  product_type_candidates JSONB,
  commercial_hypothesis TEXT,
  creative_hypotheses  JSONB,
  market_context       JSONB,
  risk_level           TEXT NOT NULL,
  readiness_status     TEXT NOT NULL,
  latest_score_id      UUID,
  latest_score         NUMERIC,
  latest_confidence    NUMERIC,
  score_version        TEXT,
  canonical_id         TEXT NOT NULL REFERENCES normalized_terms (canonical_id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_opp_candidate_risk
    CHECK (risk_level IN ('low','medium','high','blocked')),
  CONSTRAINT chk_opp_candidate_readiness
    CHECK (readiness_status IN ('new','ready_for_scoring','scoring','scored','needs_review','approved_for_creative','rejected','archived')),
  CONSTRAINT uq_opportunity_candidate_canonical UNIQUE (canonical_id)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_candidate_readiness
  ON opportunity_candidate (readiness_status);

CREATE TABLE IF NOT EXISTS opportunity_score (
  score_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id     UUID NOT NULL REFERENCES opportunity_candidate (opportunity_id) ON DELETE CASCADE,
  scoring_run_id     UUID NOT NULL REFERENCES scoring_runs (scoring_run_id) ON DELETE CASCADE,
  score_version      TEXT NOT NULL,
  total_score        NUMERIC NOT NULL,
  confidence_score   NUMERIC NOT NULL,
  recommendation     TEXT NOT NULL,
  summary_reason     TEXT NOT NULL,
  positive_drivers   JSONB,
  negative_drivers   JSONB,
  evidence_refs      JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_opportunity_score_recommendation
    CHECK (recommendation IN ('approve','review','reject','hold')),
  CONSTRAINT uq_opportunity_score_run UNIQUE (opportunity_id, scoring_run_id)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_score_opp
  ON opportunity_score (opportunity_id);

CREATE TABLE IF NOT EXISTS opportunity_score_factor (
  factor_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  score_id     UUID NOT NULL REFERENCES opportunity_score (score_id) ON DELETE CASCADE,
  factor_name  TEXT NOT NULL,
  raw_value    NUMERIC,
  weight       NUMERIC,
  factor_value NUMERIC NOT NULL,
  factor_reason TEXT,
  evidence     JSONB
);

CREATE INDEX IF NOT EXISTS idx_opportunity_score_factor_score
  ON opportunity_score_factor (score_id);

CREATE TABLE IF NOT EXISTS trend_cluster_v2 (
  cluster_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_key          TEXT NOT NULL,
  cluster_version      TEXT NOT NULL,
  primary_topic        TEXT NOT NULL,
  niche                TEXT,
  sub_niche            TEXT,
  source_count         INTEGER NOT NULL,
  signal_count         INTEGER NOT NULL,
  supporting_signal_ids JSONB NOT NULL,
  aggregate_metrics    JSONB,
  freshness_window     JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_trend_cluster_v2_key_ver UNIQUE (cluster_key, cluster_version)
);

CREATE TABLE IF NOT EXISTS cluster_members_v2 (
  member_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id     UUID NOT NULL REFERENCES trend_cluster_v2 (cluster_id) ON DELETE CASCADE,
  canonical_id   TEXT NOT NULL REFERENCES normalized_terms (canonical_id) ON DELETE CASCADE,
  canonical_term TEXT,
  member_role    TEXT,
  fit_score      NUMERIC(6,2),
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_cluster_members_v2_cluster_canon UNIQUE (cluster_id, canonical_id)
);

CREATE INDEX IF NOT EXISTS idx_cluster_members_v2_canonical
  ON cluster_members_v2 (canonical_id);

ALTER TABLE opportunity_candidate
  ADD CONSTRAINT fk_opportunity_candidate_cluster_v2
  FOREIGN KEY (cluster_id) REFERENCES trend_cluster_v2 (cluster_id)
  ON DELETE SET NULL;

DROP TRIGGER IF EXISTS trg_opportunity_candidate_updated_at ON opportunity_candidate;
CREATE TRIGGER trg_opportunity_candidate_updated_at
  BEFORE UPDATE ON opportunity_candidate
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_trend_cluster_v2_updated_at ON trend_cluster_v2;
CREATE TRIGGER trg_trend_cluster_v2_updated_at
  BEFORE UPDATE ON trend_cluster_v2
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
