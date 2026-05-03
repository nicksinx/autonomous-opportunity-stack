/**
 * Item 1 mitigation kit (without immediate DB cutover).
 *
 * Provides utilities used by every workflow Code node to:
 *   - Acquire/release run-scoped locks on Sheets resources via the
 *     pipeline_locks tab.
 *   - Generate deterministic row IDs to make appends safe to retry.
 *   - Run dedup checks before append.
 *   - Provide a mirror-writer abstraction so secondary sinks (JSONL, SQLite,
 *     Postgres) can be added behind a feature flag without changing
 *     workflows.
 *
 * Pure JavaScript, no external dependencies. Designed to be inlined into
 * n8n Code nodes.
 */

/**
 * Lock statuses written to pipeline_locks.status.
 */
const LOCK_STATUSES = Object.freeze({
  ACTIVE: "active",
  RELEASED: "released",
  EXPIRED: "expired",
  REJECTED: "rejected",
});

/**
 * Build a lock candidate row. Caller appends to pipeline_locks and re-reads
 * to confirm acquisition (only the earliest active row for a target wins).
 *
 * @param {{ workflow_name: string, stage_name: string, target_resource: string, ttl_ms?: number, run_id?: string }} input
 * @returns {Object<string, any>}
 */
function buildLockRow(input) {
  const i = input || {};
  const ttl = num(i.ttl_ms) > 0 ? num(i.ttl_ms) : 5 * 60 * 1000;
  const acquiredAt = new Date();
  const expiresAt = new Date(acquiredAt.getTime() + ttl);
  return {
    lock_id: `lock_${str(i.workflow_name)}_${str(i.stage_name)}_${str(i.target_resource)}_${Date.now()}_${rand()}`,
    lock_owner: str(i.run_id) || `runner_${Date.now()}`,
    workflow_name: str(i.workflow_name),
    stage_name: str(i.stage_name),
    target_resource: str(i.target_resource),
    acquired_at: acquiredAt.toISOString(),
    lock_expires_at: expiresAt.toISOString(),
    released_at: "",
    status: LOCK_STATUSES.ACTIVE,
    metadata_json: i.metadata ? safeJson(i.metadata) : "",
  };
}

/**
 * Decide whether the candidate lock wins given currently-known lock rows.
 *
 * @param {Object<string, any>} candidate Row built by buildLockRow.
 * @param {Array<Object<string, any>>} currentRows All known pipeline_locks rows.
 * @returns {{ acquired: boolean, conflict_lock_id?: string, reason?: string }}
 */
function evaluateLockAcquisition(candidate, currentRows) {
  const c = candidate || {};
  const target = str(c.target_resource);
  const acquiredAt = Date.parse(c.acquired_at) || Date.now();
  const list = Array.isArray(currentRows) ? currentRows : [];

  for (const row of list) {
    if (str(row.lock_id) === str(c.lock_id)) continue;
    if (str(row.target_resource) !== target) continue;
    if (str(row.status) !== LOCK_STATUSES.ACTIVE) continue;

    const otherAcquired = Date.parse(row.acquired_at);
    const expiresAt = Date.parse(row.lock_expires_at);
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) continue;

    if (Number.isFinite(otherAcquired) && otherAcquired < acquiredAt) {
      return { acquired: false, conflict_lock_id: str(row.lock_id), reason: "earlier_active_lock" };
    }
  }
  return { acquired: true };
}

/**
 * Build a release row that flips an active lock to released.
 *
 * @param {Object<string, any>} lockRow
 * @returns {Object<string, any>}
 */
function buildReleaseRow(lockRow) {
  return {
    ...(lockRow || {}),
    released_at: new Date().toISOString(),
    status: LOCK_STATUSES.RELEASED,
  };
}

/**
 * Deterministic row ID for an append-only event row. The combination of
 * (workflow_name, target_table, natural_key) yields stable IDs that keep
 * retries safe.
 *
 * @param {{ workflow_name: string, target_table: string, natural_key: string|string[] }} input
 * @returns {string}
 */
function deterministicRowId(input) {
  const i = input || {};
  const naturalKey = Array.isArray(i.natural_key) ? i.natural_key.join("|") : str(i.natural_key);
  const slug = `${str(i.workflow_name)}|${str(i.target_table)}|${naturalKey}`;
  return `row_${str(i.target_table)}_${hash(slug)}`;
}

/**
 * Filter out rows whose deterministic ID already exists in the target table.
 *
 * @param {Array<Object<string, any>>} candidates Rows produced by the workflow.
 * @param {Array<Object<string, any>>} existingRows Pre-existing target rows.
 * @param {{ id_field: string }} options
 * @returns {{ to_insert: Array<Object<string, any>>, duplicates: Array<Object<string, any>> }}
 */
function dedupBeforeAppend(candidates, existingRows, options) {
  const opts = options || { id_field: "id" };
  const idField = str(opts.id_field) || "id";
  const list = Array.isArray(candidates) ? candidates : [];
  const existingIds = new Set();
  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    const id = str(row[idField]);
    if (id) existingIds.add(id);
  }
  const toInsert = [];
  const duplicates = [];
  for (const row of list) {
    const id = str(row[idField]);
    if (id && existingIds.has(id)) duplicates.push(row);
    else toInsert.push(row);
  }
  return { to_insert: toInsert, duplicates };
}

/**
 * Build a mirror-writer log entry. The actual secondary sink is plugged in
 * by the caller (e.g. JSONL writer in a Code node, Postgres HTTP request).
 *
 * @param {{
 *   run_id: string,
 *   workflow_name: string,
 *   target_table: string,
 *   primary_status: string,
 *   secondary_status: string,
 *   rows_written: number,
 *   rows_hash?: string,
 * }} input
 * @returns {Object<string, any>}
 */
function buildMirrorLogRow(input) {
  const i = input || {};
  return {
    mirror_id: `mirror_${str(i.workflow_name)}_${str(i.target_table)}_${Date.now()}`,
    run_id: str(i.run_id),
    workflow_name: str(i.workflow_name),
    target_table: str(i.target_table),
    primary_sink: "google_sheets",
    secondary_sink: str(i.secondary_sink) || "jsonl",
    rows_written: num(i.rows_written),
    primary_status: str(i.primary_status),
    secondary_status: str(i.secondary_status),
    mirror_hash: str(i.rows_hash),
    created_at: new Date().toISOString(),
  };
}

/**
 * Compute a deterministic hash for a batch of rows. Used by mirror-writer
 * comparisons and by integrity checks across primary/secondary sinks.
 *
 * @param {Array<Object<string, any>>} rows
 * @returns {string}
 */
function hashRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const acc = list
    .map((r) =>
      Object.keys(r || {})
        .sort()
        .map((k) => `${k}=${str(r[k])}`)
        .join("&")
    )
    .join("\n");
  return hash(acc);
}

/**
 * Resolve secondary sink behavior from environment-style flags. The caller
 * passes whichever process.env / $env shape they use.
 *
 * @param {Object<string, any>} env
 * @returns {{
 *   enabled: boolean,
 *   sink: "jsonl" | "sqlite" | "postgres" | "noop",
 *   target?: string,
 * }}
 */
function resolveSecondarySink(env) {
  const e = env || {};
  const sinkRaw = str(e.MIRROR_SECONDARY_SINK || e.PIPELINE_MIRROR_SINK || "").toLowerCase();
  const enabled = parseBool(e.MIRROR_ENABLED || e.PIPELINE_MIRROR_ENABLED, false);
  if (!enabled) return { enabled: false, sink: "noop" };
  const allowed = new Set(["jsonl", "sqlite", "postgres"]);
  const sink = allowed.has(sinkRaw) ? sinkRaw : "jsonl";
  return { enabled: true, sink, target: str(e.MIRROR_TARGET || e.PIPELINE_MIRROR_TARGET) };
}

function parseBool(v, fallback) {
  if (v === true) return true;
  if (v === false) return false;
  const s = str(v).toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return Boolean(fallback);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return "";
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function rand() {
  return Math.floor(Math.random() * 1e9).toString(36);
}

function hash(value) {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  const s = String(value || "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16) + (h1 >>> 0).toString(16));
}

if (typeof module !== "undefined") {
  module.exports = {
    LOCK_STATUSES,
    buildLockRow,
    evaluateLockAcquisition,
    buildReleaseRow,
    deterministicRowId,
    dedupBeforeAppend,
    buildMirrorLogRow,
    hashRows,
    resolveSecondarySink,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  const lockA = buildLockRow({
    workflow_name: "wf_collect_trends",
    stage_name: "append_raw_signals",
    target_resource: "raw_signals",
    run_id: "run_demo_a",
    ttl_ms: 60_000,
  });

  const lockB = buildLockRow({
    workflow_name: "wf_collect_trends",
    stage_name: "append_raw_signals",
    target_resource: "raw_signals",
    run_id: "run_demo_b",
    ttl_ms: 60_000,
  });

  const acqA = evaluateLockAcquisition(lockA, [lockA]);
  const acqB = evaluateLockAcquisition(lockB, [lockA, lockB]);

  // eslint-disable-next-line no-console
  console.log("A acquired:", acqA, "B acquired:", acqB);

  const ids = [
    deterministicRowId({ workflow_name: "wf_collect_trends", target_table: "raw_signals", natural_key: ["sig_etsy_2026-04-28_pickleball_mom"] }),
    deterministicRowId({ workflow_name: "wf_collect_trends", target_table: "raw_signals", natural_key: ["sig_etsy_2026-04-28_pickleball_mom"] }),
  ];
  // eslint-disable-next-line no-console
  console.log("Deterministic ids stable:", ids[0] === ids[1], ids[0]);

  const mirror = buildMirrorLogRow({
    run_id: "run_demo",
    workflow_name: "wf_collect_trends",
    target_table: "raw_signals",
    primary_status: "success",
    secondary_status: "skipped",
    rows_written: 12,
    rows_hash: hashRows([{ a: 1 }, { a: 2 }]),
  });
  // eslint-disable-next-line no-console
  console.log("Mirror log:", mirror);
}
