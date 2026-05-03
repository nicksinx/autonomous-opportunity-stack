-- Optional CSV-backed source placeholder for multi-source onboarding.

BEGIN;

INSERT INTO sources_config (source_name, enabled, market, weight, pull_frequency, notes, source_type)
VALUES ('csv_upload', TRUE, 'UK', 0.70, 'manual', 'CSV importer seed row', 'csv')
ON CONFLICT (source_name) DO NOTHING;

COMMIT;
