CREATE OR REPLACE VIEW v_creative_pack_status AS
SELECT
  oc.opportunity_id,
  oc.title,
  oc.primary_niche,
  oc.readiness_status,
  oc.latest_score,
  oc.latest_confidence,
  oc.updated_at AS candidate_updated_at,
  cgr.run_id,
  cgr.status AS creative_run_status,
  cgr.idempotency_key,
  cgr.drive_folder_url,
  cgr.started_at AS creative_started_at,
  cgr.finished_at AS creative_finished_at,
  cgr.error_summary AS creative_error_summary
FROM opportunity_candidate oc
LEFT JOIN LATERAL (
  SELECT *
  FROM creative_generation_run r
  WHERE r.opportunity_id = oc.opportunity_id
  ORDER BY r.started_at DESC
  LIMIT 1
) cgr ON TRUE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN
    GRANT SELECT ON v_creative_pack_status TO pod_app;
  END IF;
END
$$;
