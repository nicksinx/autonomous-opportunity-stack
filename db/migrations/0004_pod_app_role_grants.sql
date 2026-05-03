-- Application role pod_app (matches docker-compose / README; password defaults to
-- .env.postgres.example — rotate with ALTER ROLE pod_app WITH PASSWORD '...' locally).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN
    CREATE ROLE pod_app WITH LOGIN PASSWORD 'postgres';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE pod_trends TO pod_app;
GRANT USAGE ON SCHEMA public TO pod_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pod_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pod_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pod_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pod_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pod_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pod_app;
