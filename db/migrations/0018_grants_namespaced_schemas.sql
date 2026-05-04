-- Phase 6 follow-up: grants for namespaced schemas/tables.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN
    GRANT USAGE ON SCHEMA intake, scoring, workflow, analytics TO pod_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA intake, scoring, workflow, analytics TO pod_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA intake, scoring, workflow, analytics
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pod_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA intake, scoring, workflow, analytics TO pod_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA intake, scoring, workflow, analytics
      GRANT USAGE, SELECT ON SEQUENCES TO pod_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_admin') THEN
    GRANT USAGE ON SCHEMA intake, scoring, workflow, analytics TO pod_admin;
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA intake, scoring, workflow, analytics TO pod_admin;
    ALTER DEFAULT PRIVILEGES IN SCHEMA intake, scoring, workflow, analytics
      GRANT ALL PRIVILEGES ON TABLES TO pod_admin;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA intake, scoring, workflow, analytics TO pod_admin;
    ALTER DEFAULT PRIVILEGES IN SCHEMA intake, scoring, workflow, analytics
      GRANT ALL PRIVILEGES ON SEQUENCES TO pod_admin;
  END IF;
END $$;

COMMIT;
