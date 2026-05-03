-- Layer 2 Pre-Implementation Refactor — Phase 1
-- Lineage and source-family hardening.
--
-- 1. Adds raw_signals.canonical_id FK -> normalized_terms (was: implicit via slugify(term)).
-- 2. Adds sources_config.source_type family (was: only the specific source_name).
-- 3. Backfills both columns deterministically.
--
-- Additive only. Safe to roll back: DROP INDEX, DROP CONSTRAINT, DROP COLUMN.

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. raw_signals.canonical_id FK to normalized_terms
-- ----------------------------------------------------------------------------
ALTER TABLE raw_signals
  ADD COLUMN IF NOT EXISTS canonical_id TEXT
    REFERENCES normalized_terms (canonical_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_raw_signals_canonical
  ON raw_signals (canonical_id);

-- Backfill the FK using the same slugify rule the live wf_normalize_terms node uses
-- (lowercase, replace non-alphanumeric with underscore, trim leading/trailing underscores).
-- The 'norm_' prefix mirrors normalized_terms.canonical_id construction.
--
-- Rows whose computed slug does not match any existing normalized_terms row are left NULL
-- (the FK ON DELETE SET NULL path also leaves them NULL on retire), and the LEFT JOIN guard
-- prevents an FK violation.
WITH derived AS (
  SELECT
    rs.signal_id,
    'norm_' || trim(both '_' from regexp_replace(lower(rs.term), '[^a-z0-9]+', '_', 'g')) AS computed_canonical_id
  FROM raw_signals rs
  WHERE rs.canonical_id IS NULL
    AND rs.term IS NOT NULL
    AND rs.term <> ''
)
UPDATE raw_signals rs
   SET canonical_id = d.computed_canonical_id
  FROM derived d
  JOIN normalized_terms nt ON nt.canonical_id = d.computed_canonical_id
 WHERE rs.signal_id = d.signal_id;

-- ----------------------------------------------------------------------------
-- 2. sources_config.source_type family
-- ----------------------------------------------------------------------------
ALTER TABLE sources_config
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'unknown';

-- Constraint added separately so DEFAULT 'unknown' is allowed for any pre-existing rows
-- that we have not yet mapped (current schema has 6 known seeds; the UPDATE below covers
-- those, and the CHECK is added once values are valid).
UPDATE sources_config SET source_type = 'search'      WHERE source_name = 'google_trends';
UPDATE sources_config SET source_type = 'social'      WHERE source_name = 'pinterest_trends';
UPDATE sources_config SET source_type = 'social'      WHERE source_name = 'tiktok_creative';
UPDATE sources_config SET source_type = 'marketplace' WHERE source_name = 'etsy_autocomplete';
UPDATE sources_config SET source_type = 'marketplace' WHERE source_name = 'amazon_movers';
UPDATE sources_config SET source_type = 'search'      WHERE source_name = 'google_kw_planner';

-- Now that values are valid, enforce the enum.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_sources_config_source_type'
  ) THEN
    ALTER TABLE sources_config
      ADD CONSTRAINT chk_sources_config_source_type
        CHECK (source_type IN ('marketplace','search','social','reviews','csv','internal','unknown'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_sources_config_source_type
  ON sources_config (source_type);

COMMIT;
