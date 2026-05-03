-- Explicit grants for objects introduced after 0004 (safe if role lacks blanket ALL).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON score_weight_history TO pod_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON opportunity_lifecycle_log TO pod_app;
  END IF;
END
$$;
