CREATE OR REPLACE VIEW v_review_queue AS
SELECT
  oc.opportunity_id,
  oc.title,
  oc.primary_niche,
  oc.risk_level,
  oc.readiness_status,
  oc.latest_score,
  oc.latest_confidence,
  oc.updated_at
FROM opportunity_candidate oc
WHERE oc.readiness_status IN ('needs_review', 'scored');
