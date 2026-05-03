/**
 * Publishing queue idempotency module (Item 5 of pipeline hardening plan).
 *
 * Produces deterministic idempotency keys, applies upsert semantics against
 * the publishing_queue tab, and emits stage logs/metrics for the queueing
 * step. Pure JavaScript, designed for n8n Code-node inlining.
 */

/**
 * Lifecycle statuses recognized by the queue consumer / dashboard.
 */
const QUEUE_STATUSES = Object.freeze({
  PENDING: "pending",
  IN_REVIEW: "in_review",
  PUBLISHED: "published",
  REJECTED: "rejected",
  ON_HOLD: "on_hold",
});

/**
 * Idempotency key version. Bump when the composite changes meaning so old
 * keys cannot collide with new ones.
 */
const IDEMPOTENCY_KEY_VERSION = "v1";

/**
 * Deterministic key for a queue entry.
 *
 * @param {{ cluster_id: string, brief_id: string, run_week?: string }} parts
 * @returns {string}
 */
function buildIdempotencyKey(parts) {
  const p = parts || {};
  const week = str(p.run_week) || isoWeek(new Date());
  return [
    "idem",
    IDEMPOTENCY_KEY_VERSION,
    str(p.cluster_id) || "no_cluster",
    str(p.brief_id) || "no_brief",
    week,
  ].join(":");
}

/**
 * Compute the ISO 8601 week (YYYY-Www) for a given date.
 */
function isoWeek(dateLike) {
  const d = new Date(dateLike || new Date());
  if (!Number.isFinite(d.getTime())) return "";
  const target = new Date(d.valueOf());
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
  }
  const week = 1 + Math.ceil((firstThursday - target) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Apply upsert-by-key semantics against existing publishing_queue rows.
 *
 * @param {Array<{ cluster_id: string, brief_id: string, run_id?: string, priority?: string|number, review_notes?: string, status?: string }>} candidates
 * @param {Array<Object<string, any>>} existingQueueRows Current rows from publishing_queue tab.
 * @param {{ run_id?: string, run_date?: string }} runMeta
 * @returns {{
 *   inserts: Array<Object<string, any>>,
 *   updates: Array<Object<string, any>>,
 *   skipped: Array<{ reason: string, key: string }>,
 *   stats: {
 *     candidates: number,
 *     inserts: number,
 *     updates: number,
 *     duplicates_in_batch: number,
 *     skipped: number,
 *   },
 * }}
 */
function reconcileQueueUpserts(candidates, existingQueueRows, runMeta) {
  const list = Array.isArray(candidates) ? candidates : [];
  const existing = Array.isArray(existingQueueRows) ? existingQueueRows : [];
  const meta = runMeta || {};
  const runId = str(meta.run_id) || `run_queue_${Date.now()}`;
  const runWeek = str(meta.run_week) || isoWeek(new Date());
  const nowIso = new Date().toISOString();

  const existingByKey = new Map();
  for (const row of existing) {
    const k = str(row.idempotency_key);
    if (k) existingByKey.set(k, row);
  }

  const inserts = [];
  const updates = [];
  const skipped = [];
  const seenInBatch = new Set();
  let duplicatesInBatch = 0;

  for (const cand of list) {
    if (!cand || !cand.cluster_id || !cand.brief_id) {
      skipped.push({ reason: "missing_required_keys", key: "" });
      continue;
    }

    const key = buildIdempotencyKey({
      cluster_id: cand.cluster_id,
      brief_id: cand.brief_id,
      run_week: cand.run_week || runWeek,
    });

    if (seenInBatch.has(key)) {
      duplicatesInBatch += 1;
      skipped.push({ reason: "duplicate_in_batch", key });
      continue;
    }
    seenInBatch.add(key);

    const prev = existingByKey.get(key);
    if (!prev) {
      inserts.push({
        queue_id: `q_${hash(key)}_${Date.now()}`,
        idempotency_key: key,
        run_id: runId,
        run_week: cand.run_week || runWeek,
        cluster_id: str(cand.cluster_id),
        brief_id: str(cand.brief_id),
        status: str(cand.status) || QUEUE_STATUSES.PENDING,
        attempt_count: 1,
        first_enqueued_at: nowIso,
        last_seen_at: nowIso,
        source_run_id: str(cand.run_id) || runId,
        priority: cand.priority != null ? str(cand.priority) : "normal",
        review_notes: str(cand.review_notes),
      });
    } else {
      updates.push({
        queue_id: str(prev.queue_id),
        idempotency_key: key,
        run_id: runId,
        run_week: str(prev.run_week) || runWeek,
        cluster_id: str(prev.cluster_id) || str(cand.cluster_id),
        brief_id: str(prev.brief_id) || str(cand.brief_id),
        status: str(prev.status) || QUEUE_STATUSES.PENDING,
        attempt_count: num(prev.attempt_count) + 1,
        first_enqueued_at: str(prev.first_enqueued_at) || nowIso,
        last_seen_at: nowIso,
        source_run_id: str(prev.source_run_id) || runId,
        // Upsert semantics: incoming candidate priority overrides stored priority.
        priority: cand.priority != null ? str(cand.priority) : str(prev.priority || "normal"),
        review_notes: str(cand.review_notes) || str(prev.review_notes),
      });
    }
  }

  return {
    inserts,
    updates,
    skipped,
    stats: {
      candidates: list.length,
      inserts: inserts.length,
      updates: updates.length,
      duplicates_in_batch: duplicatesInBatch,
      skipped: skipped.length,
    },
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function hash(value) {
  let h = 0;
  const s = String(value || "");
  for (let i = 0; i < s.length; i += 1) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

if (typeof module !== "undefined") {
  module.exports = {
    QUEUE_STATUSES,
    IDEMPOTENCY_KEY_VERSION,
    buildIdempotencyKey,
    isoWeek,
    reconcileQueueUpserts,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  const candidates = [
    { cluster_id: "clu_a", brief_id: "br_1", priority: "high", run_id: "run_1" },
    { cluster_id: "clu_a", brief_id: "br_1", priority: "high", run_id: "run_2" },
    { cluster_id: "clu_b", brief_id: "br_2", priority: "normal", run_id: "run_2" },
  ];
  const existing = [
    { queue_id: "q_existing_1", idempotency_key: buildIdempotencyKey({ cluster_id: "clu_a", brief_id: "br_1" }), status: "pending", attempt_count: 1, first_enqueued_at: "2026-04-27T00:00:00Z" },
  ];
  const result = reconcileQueueUpserts(candidates, existing, { run_id: "run_demo" });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}
