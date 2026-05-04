-- Grants for Layer 3 tables (creative_generation_run, creative_output).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON creative_generation_run TO pod_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON creative_output TO pod_app;
  END IF;
END
$$;
