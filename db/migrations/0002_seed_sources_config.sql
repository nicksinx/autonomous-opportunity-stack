-- Seed rows for sources_config (lifted from setup_sheets.gs:24-73)
-- Idempotent: ON CONFLICT DO NOTHING preserves any user edits made post-seed.

BEGIN;

INSERT INTO sources_config (source_name, enabled, market, weight, pull_frequency, notes) VALUES
  ('google_trends',     TRUE, 'UK', 1.00, 'daily',  'Rising queries + related terms'),
  ('pinterest_trends',  TRUE, 'UK', 0.90, 'daily',  'Trending searches'),
  ('tiktok_creative',   TRUE, 'UK', 0.85, 'daily',  'Trending hashtags and sounds'),
  ('etsy_autocomplete', TRUE, 'UK', 1.00, 'daily',  'Buyer-intent phrases'),
  ('amazon_movers',     TRUE, 'UK', 0.90, 'daily',  'Category movers and shakers'),
  ('google_kw_planner', TRUE, 'UK', 0.80, 'weekly', 'Commercial modifier queries')
ON CONFLICT (source_name) DO NOTHING;

COMMIT;
