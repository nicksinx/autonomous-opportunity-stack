-- Current state of the publishing queue with cluster + brief joins.

CREATE OR REPLACE VIEW v_publish_queue_status AS
SELECT
  q.queue_id,
  q.idempotency_key,
  q.status,
  q.priority,
  q.attempt_count,
  q.first_enqueued_at,
  q.last_seen_at,
  q.run_week,
  q.run_id,
  q.cluster_id,
  c.theme_name,
  c.theme_slug,
  c.cluster_score,
  q.brief_id,
  b.range_title,
  b.status        AS brief_status,
  q.review_notes
FROM publishing_queue q
LEFT JOIN theme_clusters c ON c.cluster_id = q.cluster_id
LEFT JOIN range_briefs   b ON b.brief_id   = q.brief_id
ORDER BY
  CASE LOWER(q.priority) WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
  q.first_enqueued_at;
