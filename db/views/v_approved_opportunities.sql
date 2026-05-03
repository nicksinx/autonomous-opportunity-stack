CREATE OR REPLACE VIEW v_approved_opportunities AS
SELECT
  oc.opportunity_id,
  oc.title,
  oc.primary_niche,
  oc.readiness_status,
  oc.latest_score,
  oc.latest_confidence,
  oc.updated_at
FROM opportunity_candidate oc
WHERE oc.readiness_status = 'approved_for_creative';
