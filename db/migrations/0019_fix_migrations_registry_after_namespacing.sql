-- Reconcile migration registry if _migrations was created outside public
-- during schema search_path transition.

BEGIN;

CREATE TABLE IF NOT EXISTS public._migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum    TEXT
);

DO $$
BEGIN
  IF to_regclass('intake._migrations') IS NOT NULL THEN
    INSERT INTO public._migrations (filename, applied_at, checksum)
    SELECT filename, applied_at, checksum
    FROM intake._migrations
    ON CONFLICT (filename) DO NOTHING;
    DROP TABLE intake._migrations;
  END IF;
END $$;

COMMIT;
