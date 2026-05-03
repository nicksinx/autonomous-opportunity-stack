CREATE OR REPLACE VIEW v_lifecycle_history AS
SELECT
  l.log_id,
  l.opportunity_id,
  oc.title,
  l.from_status,
  l.to_status,
  l.actor,
  l.note,
  l.created_at
FROM opportunity_lifecycle_log l
JOIN opportunity_candidate oc ON oc.opportunity_id = l.opportunity_id;
