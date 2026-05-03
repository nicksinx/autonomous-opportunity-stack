CREATE OR REPLACE VIEW v_workflow_outbox_health AS
SELECT
  (SELECT COUNT(*) FROM workflow_outbox WHERE status = 'pending') AS pending_count,
  (SELECT COUNT(*) FROM workflow_outbox WHERE status = 'processing') AS processing_count,
  (SELECT COUNT(*) FROM workflow_outbox WHERE status = 'deadletter') AS deadletter_count,
  (SELECT MAX(NOW() - scheduled_at) FROM workflow_outbox WHERE status = 'pending') AS oldest_pending_age,
  (SELECT COALESCE(jsonb_object_agg(event_type::text, c), '{}'::jsonb)
   FROM (
     SELECT event_type, COUNT(*) AS c
     FROM workflow_outbox
     WHERE status = 'deadletter'
     GROUP BY event_type
   ) q) AS deadletter_by_event_type,
  (SELECT COALESCE(jsonb_object_agg(retry_count::text, c), '{}'::jsonb)
   FROM (
     SELECT retry_count, COUNT(*) AS c
     FROM workflow_outbox
     GROUP BY retry_count
   ) r) AS retry_distribution;
