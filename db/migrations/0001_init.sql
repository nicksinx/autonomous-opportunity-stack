-- POD Trend Research System — Postgres schema (initial)
-- 25 tables, mirroring the Sheets-tab schema in:
--   setup_sheets.gs                 (15 base tables)
--   extend_clustering_schema.gs     (cluster_members, cluster_history, cluster_review_queue, cluster_metrics)
--   extend_pipeline_hardening.gs    (normalization_log, publishing_queue, stage_run_logs, source_health, pipeline_locks, dual_write_mirror_log)
--   extend_scoring_schema.gs        (extends normalized_terms with scoring columns)
--
-- Conventions (per plan):
--   * App-generated TEXT PKs preserved (signal_id, opp_id, cluster_id, ...).
--   * TIMESTAMPTZ for events; DATE for run_date / week_start; NUMERIC for scores.
--   * JSONB for *_json columns.
--   * Composite UNIQUEs encode natural keys today only enforced in code.
--   * CHECK constraints for small enums (cheaper to evolve than PG ENUMs).
--   * updated_at triggers on UPSERT-keyed tables.

BEGIN;

-- ----------------------------------------------------------------------------
-- updated_at trigger function (shared across tables)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 1. sources_config (READ-config, lookup)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sources_config (
  source_name      TEXT PRIMARY KEY,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  market           TEXT NOT NULL DEFAULT 'UK',
  weight           NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  pull_frequency   TEXT NOT NULL DEFAULT 'daily',
  notes            TEXT
);

-- ============================================================================
-- 2. raw_signals (APPEND-mostly event log)
-- ============================================================================
CREATE TABLE IF NOT EXISTS raw_signals (
  signal_id        TEXT PRIMARY KEY,
  date_collected   TIMESTAMPTZ NOT NULL,
  source           TEXT NOT NULL,
  market           TEXT,
  term             TEXT NOT NULL,
  related_term     TEXT,
  category         TEXT,
  signal_type      TEXT,
  velocity_hint    TEXT,
  url              TEXT,
  raw_payload_json JSONB
);

CREATE INDEX IF NOT EXISTS idx_raw_signals_date_source
  ON raw_signals (date_collected, source);
CREATE INDEX IF NOT EXISTS idx_raw_signals_term
  ON raw_signals (term);

-- ============================================================================
-- 3. normalized_terms (UPSERT-keyed, extended with scoring tail)
-- ============================================================================
CREATE TABLE IF NOT EXISTS normalized_terms (
  canonical_id              TEXT PRIMARY KEY,
  date_first_seen           TIMESTAMPTZ,
  date_last_seen            TIMESTAMPTZ,
  canonical_term            TEXT NOT NULL,
  aliases                   TEXT,
  language                  TEXT,
  market                    TEXT,
  primary_category          TEXT,
  status                    TEXT NOT NULL DEFAULT 'active',
  -- Extended scoring tail (from extend_scoring_schema.gs)
  last_scored_at            TIMESTAMPTZ,
  latest_opp_id             TEXT,
  latest_opportunity_score  NUMERIC(6,2),
  latest_tier               TEXT,
  -- Bookkeeping
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_normalized_terms_status
    CHECK (LOWER(status) IN ('active','retired','merged','watch')),
  CONSTRAINT chk_normalized_terms_tier
    CHECK (latest_tier IS NULL OR latest_tier IN ('A','B','C','reject'))
);

CREATE INDEX IF NOT EXISTS idx_normalized_terms_status
  ON normalized_terms (status);
CREATE INDEX IF NOT EXISTS idx_normalized_terms_term_lower
  ON normalized_terms (LOWER(canonical_term));

DROP TRIGGER IF EXISTS trg_normalized_terms_updated_at ON normalized_terms;
CREATE TRIGGER trg_normalized_terms_updated_at
  BEFORE UPDATE ON normalized_terms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 4. marketplace_evidence (APPEND-mostly)
-- ============================================================================
CREATE TABLE IF NOT EXISTS marketplace_evidence (
  evidence_id        TEXT PRIMARY KEY,
  canonical_id       TEXT NOT NULL REFERENCES normalized_terms (canonical_id) ON DELETE CASCADE,
  source             TEXT NOT NULL,
  phrase             TEXT,
  product_type       TEXT,
  intent_type        TEXT,
  evidence_strength  NUMERIC(4,2),
  captured_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_evidence_canonical_captured
  ON marketplace_evidence (canonical_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_evidence_source
  ON marketplace_evidence (source);

-- ============================================================================
-- 5. trend_scores (APPEND-mostly run snapshot — bridge mirror of opportunity_scores)
-- ============================================================================
CREATE TABLE IF NOT EXISTS trend_scores (
  score_id            TEXT PRIMARY KEY,
  canonical_id        TEXT NOT NULL REFERENCES normalized_terms (canonical_id) ON DELETE CASCADE,
  run_date            DATE NOT NULL,
  momentum_score      NUMERIC(6,2),
  pod_fit_score       NUMERIC(6,2),
  buyer_intent_score  NUMERIC(6,2),
  range_depth_score   NUMERIC(6,2),
  novelty_score       NUMERIC(6,2),
  risk_score          NUMERIC(6,2),
  total_score         NUMERIC(6,2),
  decision            TEXT,
  CONSTRAINT chk_trend_scores_decision
    CHECK (decision IS NULL OR decision IN ('design_now','review_required','watchlist','reject'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trend_scores_canonical_run
  ON trend_scores (canonical_id, run_date);
CREATE INDEX IF NOT EXISTS idx_trend_scores_run_date
  ON trend_scores (run_date);

-- ============================================================================
-- 6. theme_clusters (UPSERT-keyed, 16 columns)
-- ============================================================================
CREATE TABLE IF NOT EXISTS theme_clusters (
  cluster_id      TEXT PRIMARY KEY,
  run_date        DATE NOT NULL,
  theme_name      TEXT,
  theme_slug      TEXT,
  parent_theme    TEXT,
  theme_summary   TEXT,
  audience        TEXT,
  occasion_type   TEXT,
  seasonality     TEXT,
  product_fit     TEXT,
  style_fit       TEXT,
  risk_level      TEXT,
  cluster_score   NUMERIC(6,2),
  term_count      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft',
  review_notes    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_theme_clusters_status
    CHECK (LOWER(status) IN ('draft','approved','watchlist','rejected'))
);

CREATE INDEX IF NOT EXISTS idx_theme_clusters_run_status
  ON theme_clusters (run_date, status);
CREATE INDEX IF NOT EXISTS idx_theme_clusters_slug
  ON theme_clusters (theme_slug);

DROP TRIGGER IF EXISTS trg_theme_clusters_updated_at ON theme_clusters;
CREATE TRIGGER trg_theme_clusters_updated_at
  BEFORE UPDATE ON theme_clusters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 7. cluster_members (UPSERT-keyed by composite)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cluster_members (
  member_id         TEXT PRIMARY KEY,
  cluster_id        TEXT NOT NULL REFERENCES theme_clusters (cluster_id) ON DELETE CASCADE,
  canonical_id      TEXT NOT NULL REFERENCES normalized_terms (canonical_id) ON DELETE CASCADE,
  canonical_term    TEXT,
  member_role       TEXT,
  fit_score         NUMERIC(6,2),
  evidence_summary  TEXT,
  reason_included   TEXT,
  reason_excluded   TEXT,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cluster_members_cluster_canonical
  ON cluster_members (cluster_id, canonical_id);

-- ============================================================================
-- 8. cluster_history (APPEND-mostly audit log)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cluster_history (
  history_id   TEXT PRIMARY KEY,
  cluster_id   TEXT NOT NULL REFERENCES theme_clusters (cluster_id) ON DELETE CASCADE,
  run_date     DATE NOT NULL,
  change_type  TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cluster_history_change_type
    CHECK (change_type IN ('created','updated','disappeared','merged','split','renamed','status_changed'))
);

CREATE INDEX IF NOT EXISTS idx_cluster_history_cluster_run
  ON cluster_history (cluster_id, run_date);

-- ============================================================================
-- 9. cluster_review_queue (UPSERT-keyed)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cluster_review_queue (
  review_id         TEXT PRIMARY KEY,
  cluster_id        TEXT NOT NULL REFERENCES theme_clusters (cluster_id) ON DELETE CASCADE,
  run_date          DATE NOT NULL,
  reason            TEXT,
  priority          TEXT NOT NULL DEFAULT 'low',
  assigned_to       TEXT,
  status            TEXT NOT NULL DEFAULT 'open',
  resolved_at       TIMESTAMPTZ,
  resolution_notes  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cluster_review_priority
    CHECK (LOWER(priority) IN ('high','medium','low')),
  CONSTRAINT chk_cluster_review_status
    CHECK (LOWER(status) IN ('open','in_progress','resolved','dismissed'))
);

CREATE INDEX IF NOT EXISTS idx_cluster_review_status
  ON cluster_review_queue (status);

DROP TRIGGER IF EXISTS trg_cluster_review_queue_updated_at ON cluster_review_queue;
CREATE TRIGGER trg_cluster_review_queue_updated_at
  BEFORE UPDATE ON cluster_review_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 10. cluster_metrics (UPSERT-keyed weekly aggregate)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cluster_metrics (
  metric_id                 TEXT PRIMARY KEY,
  week_start                DATE NOT NULL,
  total_clusters_generated  INTEGER NOT NULL DEFAULT 0,
  approved_count            INTEGER NOT NULL DEFAULT 0,
  avg_cluster_score         NUMERIC(6,2),
  avg_terms_per_cluster     NUMERIC(6,2),
  pct_sent_to_review        NUMERIC(5,2),
  pct_briefs_approved       NUMERIC(5,2),
  pct_rejected_weak_intent  NUMERIC(5,2),
  pct_rejected_risk         NUMERIC(5,2),
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cluster_metrics_week
  ON cluster_metrics (week_start);

DROP TRIGGER IF EXISTS trg_cluster_metrics_updated_at ON cluster_metrics;
CREATE TRIGGER trg_cluster_metrics_updated_at
  BEFORE UPDATE ON cluster_metrics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 11. range_briefs (UPSERT-keyed)
-- ============================================================================
CREATE TABLE IF NOT EXISTS range_briefs (
  brief_id           TEXT PRIMARY KEY,
  cluster_id         TEXT NOT NULL REFERENCES theme_clusters (cluster_id) ON DELETE CASCADE,
  run_date           DATE NOT NULL,
  range_title        TEXT,
  hero_angle         TEXT,
  best_products      TEXT,
  design_directions  TEXT,
  phrase_concepts    JSONB,
  audiences          TEXT,
  ip_risk            TEXT,
  status             TEXT NOT NULL DEFAULT 'draft',
  CONSTRAINT chk_range_briefs_status
    CHECK (LOWER(status) IN ('draft','approved','manual_review','rejected','published'))
);

CREATE INDEX IF NOT EXISTS idx_range_briefs_cluster
  ON range_briefs (cluster_id);
CREATE INDEX IF NOT EXISTS idx_range_briefs_status
  ON range_briefs (status);

-- ============================================================================
-- 12. phrase_bank (APPEND-mostly)
-- ============================================================================
CREATE TABLE IF NOT EXISTS phrase_bank (
  phrase_id        TEXT PRIMARY KEY,
  brief_id         TEXT NOT NULL REFERENCES range_briefs (brief_id) ON DELETE CASCADE,
  bucket           TEXT,
  phrase           TEXT NOT NULL,
  target_products  TEXT,
  style_hint       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phrase_bank_brief
  ON phrase_bank (brief_id);

-- ============================================================================
-- 13. watchlist (UPSERT-keyed)
-- ============================================================================
CREATE TABLE IF NOT EXISTS watchlist (
  watch_id      TEXT PRIMARY KEY,
  canonical_id  TEXT REFERENCES normalized_terms (canonical_id) ON DELETE SET NULL,
  reason        TEXT,
  review_after  DATE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watchlist_canonical
  ON watchlist (canonical_id);

-- ============================================================================
-- 14. workflow_runs (APPEND-mostly run log)
-- ============================================================================
CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id                TEXT PRIMARY KEY,
  run_started           TIMESTAMPTZ NOT NULL,
  run_finished          TIMESTAMPTZ,
  job_name              TEXT NOT NULL,
  rows_added            INTEGER NOT NULL DEFAULT 0,
  rows_updated          INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL,
  error_log             TEXT,
  sources_summary_json  JSONB,
  stage_log_root_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_started
  ON workflow_runs (run_started);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_job_name
  ON workflow_runs (job_name);

-- ============================================================================
-- 15. opportunity_scores (APPEND-mostly run snapshot, 25 columns)
-- ============================================================================
CREATE TABLE IF NOT EXISTS opportunity_scores (
  opp_id             TEXT PRIMARY KEY,
  canonical_id       TEXT NOT NULL REFERENCES normalized_terms (canonical_id) ON DELETE CASCADE,
  run_date           DATE NOT NULL,
  niche_keyword      TEXT,
  target_audience    TEXT,
  theme              TEXT,
  seasonality_flag   TEXT,
  product_formats    TEXT,
  compliance_risk    TEXT,
  demand_score       NUMERIC(6,2),
  competition_score  NUMERIC(6,2),
  conversion_score   NUMERIC(6,2),
  creative_score     NUMERIC(6,2),
  margin_score       NUMERIC(6,2),
  ops_score          NUMERIC(6,2),
  catalog_score      NUMERIC(6,2),
  repeat_score       NUMERIC(6,2),
  season_score       NUMERIC(6,2),
  raw_weighted_sum   NUMERIC(8,2),
  risk_penalty       NUMERIC(6,2),
  opportunity_score  NUMERIC(6,2),
  tier               TEXT,
  action             TEXT,
  scorer_version     TEXT,
  score_notes        TEXT,
  CONSTRAINT chk_opportunity_scores_tier
    CHECK (tier IS NULL OR tier IN ('A','B','C','reject'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_opportunity_scores_canonical_run
  ON opportunity_scores (canonical_id, run_date);
CREATE INDEX IF NOT EXISTS idx_opportunity_scores_run_date
  ON opportunity_scores (run_date);
CREATE INDEX IF NOT EXISTS idx_opportunity_scores_tier
  ON opportunity_scores (tier);

-- ============================================================================
-- 16. score_components (APPEND-mostly per-dimension breakdown)
-- ============================================================================
CREATE TABLE IF NOT EXISTS score_components (
  component_id           TEXT PRIMARY KEY,
  opp_id                 TEXT NOT NULL REFERENCES opportunity_scores (opp_id) ON DELETE CASCADE,
  run_date               DATE NOT NULL,
  dimension              TEXT NOT NULL,
  component_name         TEXT NOT NULL,
  raw_value              NUMERIC(10,4),
  normalized_value       NUMERIC(10,4),
  weight                 NUMERIC(6,4),
  weighted_contribution  NUMERIC(10,4),
  notes                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_score_components_opp
  ON score_components (opp_id);
CREATE INDEX IF NOT EXISTS idx_score_components_dimension
  ON score_components (dimension);

-- ============================================================================
-- 17. score_weights (READ-config, UPSERT by dimension)
-- ============================================================================
CREATE TABLE IF NOT EXISTS score_weights (
  dimension      TEXT PRIMARY KEY,
  weight         NUMERIC(4,2) NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  last_updated   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes          TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_score_weights_updated_at ON score_weights;
CREATE TRIGGER trg_score_weights_updated_at
  BEFORE UPDATE ON score_weights
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 18. performance_feedback (APPEND-mostly)
-- ============================================================================
CREATE TABLE IF NOT EXISTS performance_feedback (
  feedback_id          TEXT PRIMARY KEY,
  opp_id               TEXT REFERENCES opportunity_scores (opp_id) ON DELETE SET NULL,
  brief_id             TEXT REFERENCES range_briefs (brief_id) ON DELETE SET NULL,
  product_sku          TEXT,
  feedback_date        DATE NOT NULL,
  units_sold_30d       INTEGER,
  revenue_30d          NUMERIC(12,2),
  gross_margin_pct     NUMERIC(5,2),
  return_rate_pct      NUMERIC(5,2),
  ctr_pct              NUMERIC(5,2),
  conversion_rate_pct  NUMERIC(5,2),
  feedback_notes       TEXT
);

CREATE INDEX IF NOT EXISTS idx_performance_feedback_date
  ON performance_feedback (feedback_date);
CREATE INDEX IF NOT EXISTS idx_performance_feedback_opp
  ON performance_feedback (opp_id);

-- ============================================================================
-- 19. scoring_audit_log (APPEND-mostly)
-- ============================================================================
CREATE TABLE IF NOT EXISTS scoring_audit_log (
  audit_id               TEXT PRIMARY KEY,
  run_date               DATE NOT NULL,
  run_id                 TEXT REFERENCES workflow_runs (run_id) ON DELETE SET NULL,
  candidates_evaluated   INTEGER NOT NULL DEFAULT 0,
  tier_A_count           INTEGER NOT NULL DEFAULT 0,
  tier_B_count           INTEGER NOT NULL DEFAULT 0,
  tier_C_count           INTEGER NOT NULL DEFAULT 0,
  rejected_count         INTEGER NOT NULL DEFAULT 0,
  avg_opportunity_score  NUMERIC(6,2),
  top_opportunity        TEXT,
  scorer_version         TEXT,
  notes                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_scoring_audit_run_date
  ON scoring_audit_log (run_date);

-- ============================================================================
-- 20. normalization_log (APPEND-mostly decision log)
-- ============================================================================
CREATE TABLE IF NOT EXISTS normalization_log (
  log_id          TEXT PRIMARY KEY,
  run_id          TEXT REFERENCES workflow_runs (run_id) ON DELETE SET NULL,
  run_date        DATE NOT NULL,
  canonical_id    TEXT,
  input_term      TEXT,
  decision_type   TEXT NOT NULL,
  confidence      NUMERIC(4,2),
  merged_into     TEXT,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_normalization_log_decision_type
    CHECK (decision_type IN ('created','merged','skipped','low_confidence','retired','duplicate'))
);

CREATE INDEX IF NOT EXISTS idx_normalization_log_run_date
  ON normalization_log (run_date);
CREATE INDEX IF NOT EXISTS idx_normalization_log_canonical
  ON normalization_log (canonical_id);

-- ============================================================================
-- 21. publishing_queue (UPSERT-keyed by idempotency_key)
-- ============================================================================
CREATE TABLE IF NOT EXISTS publishing_queue (
  queue_id           TEXT PRIMARY KEY,
  idempotency_key    TEXT NOT NULL,
  run_id             TEXT REFERENCES workflow_runs (run_id) ON DELETE SET NULL,
  run_week           DATE,
  cluster_id         TEXT REFERENCES theme_clusters (cluster_id) ON DELETE SET NULL,
  brief_id           TEXT REFERENCES range_briefs (brief_id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  first_enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_run_id      TEXT,
  priority           TEXT NOT NULL DEFAULT 'medium',
  review_notes       TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_publishing_queue_status
    CHECK (LOWER(status) IN ('pending','processing','published','rejected','failed','cancelled')),
  CONSTRAINT chk_publishing_queue_priority
    CHECK (LOWER(priority) IN ('high','medium','low'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_publishing_queue_idempotency
  ON publishing_queue (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_publishing_queue_status_priority
  ON publishing_queue (status, priority);

DROP TRIGGER IF EXISTS trg_publishing_queue_updated_at ON publishing_queue;
CREATE TRIGGER trg_publishing_queue_updated_at
  BEFORE UPDATE ON publishing_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 22. stage_run_logs (APPEND-mostly stage event log)
-- ============================================================================
CREATE TABLE IF NOT EXISTS stage_run_logs (
  log_id          TEXT PRIMARY KEY,
  run_id          TEXT REFERENCES workflow_runs (run_id) ON DELETE SET NULL,
  workflow_name   TEXT NOT NULL,
  stage_name      TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  duration_ms     INTEGER,
  rows_in         INTEGER,
  rows_out        INTEGER,
  error_count     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  error_summary   TEXT,
  attempt_number  INTEGER NOT NULL DEFAULT 1,
  parent_log_id   TEXT,
  metadata_json   JSONB,
  CONSTRAINT chk_stage_run_logs_status
    CHECK (LOWER(status) IN ('running','success','warn','error','timeout','cancelled')),
  CONSTRAINT chk_stage_run_logs_event_type
    CHECK (event_type IN ('start','end','retry','warn','error'))
);

CREATE INDEX IF NOT EXISTS idx_stage_run_logs_run_started
  ON stage_run_logs (run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_stage_run_logs_workflow_stage
  ON stage_run_logs (workflow_name, stage_name);

-- ============================================================================
-- 23. source_health (UPSERT-keyed per (run_id, source_name))
-- ============================================================================
CREATE TABLE IF NOT EXISTS source_health (
  health_id              TEXT PRIMARY KEY,
  run_id                 TEXT REFERENCES workflow_runs (run_id) ON DELETE CASCADE,
  run_date               DATE NOT NULL,
  source_name            TEXT NOT NULL,
  status                 TEXT NOT NULL,
  rows_in                INTEGER NOT NULL DEFAULT 0,
  rows_valid             INTEGER NOT NULL DEFAULT 0,
  rows_rejected          INTEGER NOT NULL DEFAULT 0,
  duration_ms            INTEGER,
  last_error             TEXT,
  http_status_codes      TEXT,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_source_health_status
    CHECK (LOWER(status) IN ('ok','degraded','error','unknown'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_source_health_run_source
  ON source_health (run_id, source_name);
CREATE INDEX IF NOT EXISTS idx_source_health_run_date
  ON source_health (run_date);

-- ============================================================================
-- 24. pipeline_locks (UPSERT-keyed by lock_id; logical natural keys via unique partial index on active rows)
-- ============================================================================
CREATE TABLE IF NOT EXISTS pipeline_locks (
  lock_id          TEXT PRIMARY KEY,
  lock_owner       TEXT NOT NULL,
  workflow_name    TEXT NOT NULL,
  stage_name       TEXT,
  target_resource  TEXT,
  acquired_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lock_expires_at  TIMESTAMPTZ,
  released_at      TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'held',
  metadata_json    JSONB,
  CONSTRAINT chk_pipeline_locks_status
    CHECK (LOWER(status) IN ('held','released','expired'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_locks_workflow_resource
  ON pipeline_locks (workflow_name, target_resource);

-- ============================================================================
-- 25. dual_write_mirror_log (APPEND-mostly mirror-write audit; vestigial post-cutover)
-- ============================================================================
CREATE TABLE IF NOT EXISTS dual_write_mirror_log (
  mirror_id         TEXT PRIMARY KEY,
  run_id            TEXT REFERENCES workflow_runs (run_id) ON DELETE SET NULL,
  workflow_name     TEXT NOT NULL,
  target_table      TEXT NOT NULL,
  primary_sink      TEXT,
  secondary_sink    TEXT,
  rows_written      INTEGER NOT NULL DEFAULT 0,
  primary_status    TEXT,
  secondary_status  TEXT,
  mirror_hash       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dual_write_mirror_log_run
  ON dual_write_mirror_log (run_id);

COMMIT;
