-- Phase 5 closeout — retire `dual_write_mirror_log` (staged: rename + revoke now,
-- DROP in a follow-up `0016` after one full Gate-6-green sprint with the legacy
-- table sitting unchanged).
--
-- Backed by the resolved `vestigial_js_modules` decision in
-- `LAYER2_DECISIONS.md`. The dual-write target was Sheets (gone post-cutover),
-- workflow writes were stripped in Phase 1, and the `n8n:check-mirror` tooling
-- has been retired in this same change set.
--
-- Renames are idempotent (IF EXISTS); revokes are wrapped so they no-op if the
-- pod_app role is absent (e.g. fresh environments using a different role).

BEGIN;

ALTER TABLE IF EXISTS dual_write_mirror_log
  RENAME TO dual_write_mirror_log_legacy;

ALTER INDEX IF EXISTS idx_dual_write_mirror_log_run
  RENAME TO idx_dual_write_mirror_log_legacy_run;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app')
     AND EXISTS (SELECT 1 FROM pg_class WHERE relname = 'dual_write_mirror_log_legacy') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON dual_write_mirror_log_legacy FROM pod_app';
  END IF;
END
$$;

COMMIT;
