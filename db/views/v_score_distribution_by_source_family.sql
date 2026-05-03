-- Score distribution by canonical signal source family (spec §22).
-- One row per opportunity per source_type: picks the latest ingested ready signal per (opportunity, family).

CREATE OR REPLACE VIEW v_score_distribution_by_source_family AS
WITH opp_signal_family AS (
  SELECT DISTINCT ON (oc.opportunity_id, cs.source_type)
    oc.opportunity_id,
    cs.source_type,
    os.total_score,
    os.confidence_score,
    os.recommendation
  FROM opportunity_candidate oc
  JOIN opportunity_score os ON os.score_id = oc.latest_score_id
  JOIN canonical_signals cs
    ON (cs.lineage->>'normalized_term_id') = oc.canonical_id
   AND cs.status = 'ready'
  ORDER BY oc.opportunity_id, cs.source_type, cs.ingested_at DESC
)
SELECT
  source_type,
  COUNT(*) AS opportunity_count,
  ROUND(AVG(total_score)::numeric, 2) AS avg_total_score,
  ROUND(AVG(confidence_score)::numeric, 2) AS avg_confidence,
  COUNT(*) FILTER (WHERE recommendation = 'approve') AS approve_count,
  COUNT(*) FILTER (WHERE recommendation = 'review') AS review_count,
  COUNT(*) FILTER (WHERE recommendation IN ('reject', 'hold')) AS reject_or_hold_count
FROM opp_signal_family
GROUP BY source_type;
