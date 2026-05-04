-- Cleanup pass for accidental duplicate objects created in intake schema
-- during schema-search_path transition.

BEGIN;

DO $$
DECLARE
  rec record;
  cols text;
BEGIN
  -- Tables that should not live in intake. Copy missing rows into target schema,
  -- then drop the intake duplicate.
  FOR rec IN
    SELECT *
    FROM (VALUES
      ('workflow_runs','workflow'),
      ('workflow_outbox','workflow'),
      ('range_briefs','workflow'),
      ('phrase_bank','workflow'),
      ('watchlist','workflow'),
      ('publishing_queue','workflow'),
      ('stage_run_logs','workflow'),
      ('source_health','workflow'),
      ('pipeline_locks','workflow'),
      ('normalization_log','workflow'),
      ('scoring_audit_log','workflow'),
      ('dual_write_mirror_log_legacy','workflow'),
      ('performance_feedback','workflow'),
      ('score_weights','scoring'),
      ('score_weight_history','scoring'),
      ('opportunity_scores_legacy','scoring'),
      ('score_components','scoring'),
      ('scoring_runs','scoring'),
      ('opportunity_candidate','scoring'),
      ('opportunity_score','scoring'),
      ('opportunity_score_factor','scoring'),
      ('trend_cluster_v2','scoring'),
      ('cluster_members_v2','scoring'),
      ('opportunity_lifecycle_log','scoring'),
      ('trend_scores_legacy','scoring'),
      ('theme_clusters','scoring'),
      ('cluster_members','scoring'),
      ('cluster_history','scoring'),
      ('cluster_review_queue','scoring'),
      ('cluster_metrics','scoring')
    ) AS m(table_name, target_schema)
  LOOP
    IF to_regclass(format('intake.%I', rec.table_name)) IS NOT NULL
       AND to_regclass(format('%I.%I', rec.target_schema, rec.table_name)) IS NOT NULL THEN
      SELECT string_agg(format('%I', c.column_name), ', ')
        INTO cols
      FROM information_schema.columns c
      WHERE c.table_schema = rec.target_schema
        AND c.table_name = rec.table_name;

      IF cols IS NOT NULL THEN
        EXECUTE format(
          'INSERT INTO %I.%I (%s) SELECT %s FROM intake.%I ON CONFLICT DO NOTHING',
          rec.target_schema, rec.table_name, cols, cols, rec.table_name
        );
      END IF;

      EXECUTE format('DROP TABLE intake.%I CASCADE', rec.table_name);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  v record;
BEGIN
  -- Drop duplicated analytics views in intake; they are rebuilt in public.
  FOR v IN
    SELECT table_name
    FROM information_schema.views
    WHERE table_schema = 'intake' AND table_name LIKE 'v\_%' ESCAPE '\'
  LOOP
    EXECUTE format('DROP VIEW IF EXISTS intake.%I CASCADE', v.table_name);
  END LOOP;
END $$;

COMMIT;
