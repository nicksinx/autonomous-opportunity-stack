CREATE OR REPLACE VIEW v_lineage_explorer AS
SELECT
  cs.signal_id,
  cs.source_name,
  cs.source_type,
  cs.status AS canonical_status,
  cs.lineage,
  nt.canonical_id,
  nt.canonical_term AS normalized_term
FROM canonical_signals cs
LEFT JOIN normalized_terms nt ON nt.canonical_id = (cs.lineage->>'normalized_term_id');
