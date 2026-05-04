-- Phase 6 — schema namespacing for Layer 1 + Layer 2 objects.
-- Creates intake/scoring/workflow/analytics schemas and moves public tables.
-- Keeps application compatibility via search_path (no SQL text rewrite required).

BEGIN;

CREATE SCHEMA IF NOT EXISTS intake;
CREATE SCHEMA IF NOT EXISTS scoring;
CREATE SCHEMA IF NOT EXISTS workflow;
CREATE SCHEMA IF NOT EXISTS analytics;

DO $$
DECLARE
  t text;
BEGIN
  -- Intake domain
  FOREACH t IN ARRAY ARRAY[
    'sources_config',
    'raw_signals',
    'normalized_terms',
    'canonical_signals',
    'marketplace_evidence'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA intake', t);
    END IF;
  END LOOP;

  -- Scoring + candidate domain
  FOREACH t IN ARRAY ARRAY[
    'score_weights',
    'score_weight_history',
    'opportunity_scores_legacy',
    'score_components',
    'scoring_runs',
    'opportunity_candidate',
    'opportunity_score',
    'opportunity_score_factor',
    'trend_cluster_v2',
    'cluster_members_v2',
    'opportunity_lifecycle_log',
    'trend_scores_legacy',
    'theme_clusters',
    'cluster_members',
    'cluster_history',
    'cluster_review_queue',
    'cluster_metrics'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA scoring', t);
    END IF;
  END LOOP;

  -- Workflow / orchestration domain
  FOREACH t IN ARRAY ARRAY[
    'workflow_runs',
    'workflow_outbox',
    'range_briefs',
    'phrase_bank',
    'watchlist',
    'publishing_queue',
    'stage_run_logs',
    'source_health',
    'pipeline_locks',
    'normalization_log',
    'scoring_audit_log',
    'dual_write_mirror_log_legacy'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA workflow', t);
    END IF;
  END LOOP;

  -- Feedback stays operationally with workflow domain for now.
  IF to_regclass('public.performance_feedback') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.performance_feedback SET SCHEMA workflow';
  END IF;
END $$;

-- Ensure role/database search path resolves moved objects transparently.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN
    ALTER ROLE pod_app IN DATABASE pod_trends
      SET search_path = intake, scoring, workflow, analytics, public;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_admin') THEN
    ALTER ROLE pod_admin IN DATABASE pod_trends
      SET search_path = intake, scoring, workflow, analytics, public;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'pod_trends') THEN
    ALTER DATABASE pod_trends
      SET search_path = intake, scoring, workflow, analytics, public;
  END IF;
END $$;

COMMIT;
