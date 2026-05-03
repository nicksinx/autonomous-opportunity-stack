/**
 * Stage observability envelope (Item 6 of the pipeline hardening plan).
 *
 * Provides a uniform shape for stage-level telemetry that every workflow
 * writes to the stage_run_logs tab, plus rollup helpers used by the
 * dashboard observability section.
 *
 * Pure JavaScript, no external dependencies. Designed to be inlined into
 * n8n Code nodes via require()-free copy-paste blocks.
 */

/**
 * Lifecycle event types written to stage_run_logs.
 */
const STAGE_EVENT_TYPES = Object.freeze({
  START: "start",
  END: "end",
  ERROR: "error",
  WARN: "warn",
});

/**
 * Status enum used by the conditional formatting rules.
 */
const STAGE_STATUSES = Object.freeze({
  RUNNING: "running",
  SUCCESS: "success",
  WARN: "warn",
  ERROR: "error",
});

/**
 * Build a "start" envelope row.
 *
 * @param {{
 *   run_id: string,
 *   workflow_name: string,
 *   stage_name: string,
 *   rows_in?: number,
 *   metadata?: Object<string, any>,
 *   parent_log_id?: string,
 *   attempt_number?: number,
 * }} input
 * @returns {Object<string, any>}
 */
function buildStageStartLog(input) {
  const meta = input || {};
  const startedAt = new Date().toISOString();
  return {
    log_id: `slog_${str(meta.workflow_name)}_${str(meta.stage_name)}_${Date.now()}_start`,
    run_id: str(meta.run_id),
    workflow_name: str(meta.workflow_name),
    stage_name: str(meta.stage_name),
    event_type: STAGE_EVENT_TYPES.START,
    started_at: startedAt,
    ended_at: "",
    duration_ms: 0,
    rows_in: num(meta.rows_in),
    rows_out: 0,
    error_count: 0,
    status: STAGE_STATUSES.RUNNING,
    error_summary: "",
    attempt_number: num(meta.attempt_number) || 1,
    parent_log_id: str(meta.parent_log_id),
    metadata_json: meta.metadata ? safeJson(meta.metadata) : "",
  };
}

/**
 * Build an "end" envelope row that closes a previously-started stage.
 *
 * @param {{
 *   run_id: string,
 *   workflow_name: string,
 *   stage_name: string,
 *   started_at: string,
 *   rows_in?: number,
 *   rows_out?: number,
 *   error_count?: number,
 *   status?: string,
 *   error_summary?: string,
 *   metadata?: Object<string, any>,
 *   parent_log_id?: string,
 *   attempt_number?: number,
 *   start_log_id?: string,
 * }} input
 * @returns {Object<string, any>}
 */
function buildStageEndLog(input) {
  const meta = input || {};
  const endedAt = new Date().toISOString();
  const startedAt = str(meta.started_at) || endedAt;
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const status = str(meta.status) || STAGE_STATUSES.SUCCESS;
  const eventType = status === STAGE_STATUSES.ERROR ? STAGE_EVENT_TYPES.ERROR : STAGE_EVENT_TYPES.END;

  return {
    log_id: meta.start_log_id
      ? `${str(meta.start_log_id).replace(/_start$/, "")}_end`
      : `slog_${str(meta.workflow_name)}_${str(meta.stage_name)}_${Date.now()}_end`,
    run_id: str(meta.run_id),
    workflow_name: str(meta.workflow_name),
    stage_name: str(meta.stage_name),
    event_type: eventType,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    rows_in: num(meta.rows_in),
    rows_out: num(meta.rows_out),
    error_count: num(meta.error_count),
    status,
    error_summary: str(meta.error_summary),
    attempt_number: num(meta.attempt_number) || 1,
    parent_log_id: str(meta.parent_log_id),
    metadata_json: meta.metadata ? safeJson(meta.metadata) : "",
  };
}

/**
 * Wrap an async stage function so it always emits start + end (or error) rows.
 *
 * @template T
 * @param {{
 *   run_id: string,
 *   workflow_name: string,
 *   stage_name: string,
 *   rows_in?: number,
 *   metadata?: Object<string, any>,
 *   parent_log_id?: string,
 * }} envelope
 * @param {() => Promise<{ rows_out?: number, status?: string, error_summary?: string, metadata?: Object<string, any>, value?: T }>} fn
 * @returns {Promise<{ logs: Array<Object<string, any>>, value: T | null, status: string }>}
 */
async function runWithEnvelope(envelope, fn) {
  const startLog = buildStageStartLog(envelope);
  const startedAt = startLog.started_at;
  let endPayload = {};
  let value = null;
  let status = STAGE_STATUSES.SUCCESS;

  try {
    const res = await Promise.resolve().then(() => fn());
    endPayload = res || {};
    value = endPayload.value != null ? endPayload.value : null;
    status = endPayload.status || STAGE_STATUSES.SUCCESS;
  } catch (err) {
    status = STAGE_STATUSES.ERROR;
    endPayload = {
      status: STAGE_STATUSES.ERROR,
      error_summary: err && err.message ? err.message : String(err),
      metadata: { error_stack: err && err.stack ? err.stack.slice(0, 1000) : "" },
    };
  }

  const endLog = buildStageEndLog({
    run_id: envelope.run_id,
    workflow_name: envelope.workflow_name,
    stage_name: envelope.stage_name,
    started_at: startedAt,
    rows_in: envelope.rows_in,
    rows_out: endPayload.rows_out,
    error_count: status === STAGE_STATUSES.ERROR ? 1 : num(endPayload.error_count),
    status,
    error_summary: endPayload.error_summary,
    metadata: endPayload.metadata,
    parent_log_id: envelope.parent_log_id,
    attempt_number: envelope.attempt_number,
    start_log_id: startLog.log_id,
  });

  return { logs: [startLog, endLog], value, status };
}

/**
 * Compute lightweight rollup metrics from stage_run_logs rows.
 *
 * @param {Array<Object<string, any>>} stageLogs Rows from stage_run_logs tab.
 * @returns {{
 *   total_runs: number,
 *   error_runs: number,
 *   warn_runs: number,
 *   success_rate_pct: number,
 *   avg_duration_ms: number,
 *   p95_duration_ms: number,
 *   anomalous_stages: Array<{ stage_name: string, consecutive_errors: number }>,
 * }}
 */
function computeStageRollups(stageLogs) {
  const list = Array.isArray(stageLogs) ? stageLogs : [];
  const ends = list.filter((r) => r && r.event_type !== STAGE_EVENT_TYPES.START);

  const total = ends.length;
  const errors = ends.filter((r) => r.status === STAGE_STATUSES.ERROR).length;
  const warns = ends.filter((r) => r.status === STAGE_STATUSES.WARN).length;
  const durations = ends.map((r) => num(r.duration_ms)).filter((v) => v > 0);
  const successRate = total ? round1(((total - errors) / total) * 100) : 0;

  const sorted = durations.slice().sort((a, b) => a - b);
  const avg = sorted.length ? round1(sum(sorted) / sorted.length) : 0;
  const p95Index = sorted.length ? Math.max(0, Math.floor(sorted.length * 0.95) - 1) : 0;
  const p95 = sorted.length ? sorted[p95Index] : 0;

  const consecutiveByStage = {};
  for (const row of ends) {
    const key = str(row.stage_name);
    if (!key) continue;
    if (row.status === STAGE_STATUSES.ERROR) consecutiveByStage[key] = (consecutiveByStage[key] || 0) + 1;
    else consecutiveByStage[key] = 0;
  }
  const anomalous = Object.keys(consecutiveByStage)
    .filter((k) => consecutiveByStage[k] >= 2)
    .map((k) => ({ stage_name: k, consecutive_errors: consecutiveByStage[k] }))
    .sort((a, b) => b.consecutive_errors - a.consecutive_errors);

  return {
    total_runs: total,
    error_runs: errors,
    warn_runs: warns,
    success_rate_pct: successRate,
    avg_duration_ms: avg,
    p95_duration_ms: p95,
    anomalous_stages: anomalous,
  };
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

function round1(v) {
  return Math.round(v * 10) / 10;
}

function sum(arr) {
  return (arr || []).reduce((a, b) => a + num(b), 0);
}

if (typeof module !== "undefined") {
  module.exports = {
    STAGE_EVENT_TYPES,
    STAGE_STATUSES,
    buildStageStartLog,
    buildStageEndLog,
    runWithEnvelope,
    computeStageRollups,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  (async () => {
    const result = await runWithEnvelope(
      {
        run_id: "run_demo_42",
        workflow_name: "wf_collect_trends",
        stage_name: "fetch_google_trends",
        rows_in: 0,
      },
      async () => ({ rows_out: 5, metadata: { source: "google_trends" } })
    );
    // eslint-disable-next-line no-console
    console.log("Logs:", JSON.stringify(result.logs, null, 2));
    // eslint-disable-next-line no-console
    console.log(
      "Rollups:",
      JSON.stringify(
        computeStageRollups(
          result.logs.concat([
            { event_type: "end", status: "error", duration_ms: 1500, stage_name: "fetch_etsy" },
            { event_type: "end", status: "error", duration_ms: 2300, stage_name: "fetch_etsy" },
            { event_type: "end", status: "success", duration_ms: 800, stage_name: "build_run_log" },
          ])
        ),
        null,
        2
      )
    );
  })();
}
