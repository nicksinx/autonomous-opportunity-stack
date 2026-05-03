-- Seed rows for score_weights (lifted from setup_sheets.gs:256-272)
-- Idempotent: ON CONFLICT DO NOTHING preserves any calibrated weights.

BEGIN;

INSERT INTO score_weights (dimension, weight, enabled, last_updated, notes) VALUES
  ('demand_strength',      0.20, TRUE, NOW(), 'Rising demand evidence'),
  ('competition_gap',      0.15, TRUE, NOW(), 'Whitespace vs saturation'),
  ('conversion_potential', 0.20, TRUE, NOW(), 'Click and purchase likelihood'),
  ('creative_diff',        0.10, TRUE, NOW(), 'Differentiation from existing'),
  ('margin_potential',     0.10, TRUE, NOW(), 'Unit economics viability'),
  ('ops_feasibility',      0.10, TRUE, NOW(), 'Print production reliability'),
  ('catalog_fit',          0.05, TRUE, NOW(), 'Store identity alignment'),
  ('repeatability',        0.05, TRUE, NOW(), 'Collection/series potential'),
  ('seasonality_timing',   0.05, TRUE, NOW(), 'Demand timing favorability')
ON CONFLICT (dimension) DO NOTHING;

COMMIT;
