/**
 * Stage 1 source-contract validator (Item 2 of pipeline hardening plan).
 *
 * Validates raw_signals row shape, classifies failures, and produces
 * source-level health summaries that downstream nodes can write to
 * the source_health and stage_run_logs tabs.
 *
 * Pure JavaScript, no external dependencies. Designed to be inlined
 * into n8n Code nodes.
 */

/**
 * Required raw_signals fields and minimum constraints.
 */
const RAW_SIGNAL_REQUIRED_FIELDS = [
  "signal_id",
  "source",
  "term",
  "date_collected",
  "raw_payload_json",
];

/**
 * Optional fields that, when present, must be valid.
 */
const RAW_SIGNAL_OPTIONAL_FIELDS = [
  "market",
  "related_term",
  "category",
  "signal_type",
  "velocity_hint",
  "url",
];

/**
 * Validate one raw_signals row.
 *
 * @param {Object<string, any>} row Candidate raw_signals row.
 * @returns {{ ok: boolean, reasons: string[], normalized?: Object<string, any> }}
 */
function validateRawSignal(row) {
  const reasons = [];
  if (!row || typeof row !== "object") {
    return { ok: false, reasons: ["row_not_object"] };
  }

  const out = {};

  for (const field of RAW_SIGNAL_REQUIRED_FIELDS) {
    const value = row[field];
    if (value == null || String(value).trim() === "") {
      reasons.push(`missing:${field}`);
      continue;
    }
    out[field] = String(value).trim();
  }

  // Sentinel error rows from upstream branches are rejected.
  if (out.signal_id === "ERROR" || (out.term && out.term.toLowerCase() === "fetch_failed")) {
    return { ok: false, reasons: ["sentinel_error_row"] };
  }

  if (out.date_collected) {
    const ts = Date.parse(out.date_collected);
    if (!Number.isFinite(ts)) reasons.push("invalid:date_collected");
  }

  if (out.raw_payload_json) {
    try {
      JSON.parse(out.raw_payload_json);
    } catch (_e) {
      // Permit short non-JSON payload only when source explicitly emits raw text.
      if (String(out.raw_payload_json).length > 4000) {
        reasons.push("invalid:raw_payload_json_too_long");
      }
    }
  }

  for (const field of RAW_SIGNAL_OPTIONAL_FIELDS) {
    if (row[field] != null) out[field] = String(row[field]).trim();
  }

  if (out.term && out.term.length > 200) reasons.push("invalid:term_too_long");
  if (out.signal_id && out.signal_id.length > 200) reasons.push("invalid:signal_id_too_long");

  return { ok: reasons.length === 0, reasons, normalized: out };
}

/**
 * Validate a batch of rows and partition into accepted/rejected.
 *
 * @param {Array<Object<string, any>>} rows Candidate rows.
 * @returns {{
 *   accepted: Array<Object<string, any>>,
 *   rejected: Array<{ row: Object<string, any>, reasons: string[] }>,
 *   stats: {
 *     accepted_count: number,
 *     rejected_count: number,
 *     reasons_summary: Record<string, number>,
 *     by_source: Record<string, { accepted: number, rejected: number, last_reason: string }>,
 *   },
 * }}
 */
function validateRawSignalBatch(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const accepted = [];
  const rejected = [];
  const reasonsSummary = {};
  const bySource = {};

  for (const row of list) {
    const sourceKey = row && row.source ? String(row.source).trim() : "unknown";
    if (!bySource[sourceKey]) bySource[sourceKey] = { accepted: 0, rejected: 0, last_reason: "" };

    const result = validateRawSignal(row);
    if (result.ok) {
      accepted.push(result.normalized || row);
      bySource[sourceKey].accepted += 1;
    } else {
      rejected.push({ row: row || {}, reasons: result.reasons });
      bySource[sourceKey].rejected += 1;
      bySource[sourceKey].last_reason = result.reasons.join(",");
      for (const reason of result.reasons) {
        reasonsSummary[reason] = (reasonsSummary[reason] || 0) + 1;
      }
    }
  }

  return {
    accepted,
    rejected,
    stats: {
      accepted_count: accepted.length,
      rejected_count: rejected.length,
      reasons_summary: reasonsSummary,
      by_source: bySource,
    },
  };
}

/**
 * Translate per-source accepted/rejected counters into source_health rows.
 *
 * @param {Object<string, { accepted: number, rejected: number, last_reason?: string, duration_ms?: number, http_status?: string, error?: string }>} bySource
 * @param {{ run_id: string, run_date?: string }} runMeta
 * @returns {Array<Object<string, any>>}
 */
function buildSourceHealthRows(bySource, runMeta) {
  const map = bySource && typeof bySource === "object" ? bySource : {};
  const meta = runMeta || {};
  const runDate = meta.run_date || new Date().toISOString().slice(0, 10);
  const out = [];

  for (const sourceName of Object.keys(map)) {
    const entry = map[sourceName] || {};
    const total = (entry.accepted || 0) + (entry.rejected || 0);
    const rejected = entry.rejected || 0;
    let status = "ok";
    if (rejected > 0 && rejected === total) status = "error";
    else if (rejected > 0) status = "degraded";

    out.push({
      health_id: `health_${sourceName}_${runDate}_${Date.now()}`,
      run_id: meta.run_id || `run_unknown_${Date.now()}`,
      run_date: runDate,
      source_name: sourceName,
      status,
      rows_in: total,
      rows_valid: entry.accepted || 0,
      rows_rejected: rejected,
      duration_ms: entry.duration_ms || 0,
      last_error: entry.error || entry.last_reason || "",
      http_status_codes: entry.http_status || "",
      consecutive_failures: entry.consecutive_failures || 0,
      updated_at: new Date().toISOString(),
    });
  }

  return out;
}

/**
 * Wrap a per-source fetch function so it never throws and emits a status
 * payload along with the rows it produced. Suitable for sequencing in n8n
 * Code nodes that want a single try/catch boundary per source.
 *
 * @template T
 * @param {string} sourceName
 * @param {() => Promise<T[]> | T[]} fetcher
 * @returns {Promise<{ source: string, rows: T[], status: string, error?: string, duration_ms: number }>}
 */
async function runSourceBranchSafely(sourceName, fetcher) {
  const startedAt = Date.now();
  try {
    const result = await Promise.resolve().then(() => fetcher());
    const rows = Array.isArray(result) ? result : [];
    return {
      source: sourceName,
      rows,
      status: rows.length ? "ok" : "empty",
      duration_ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      source: sourceName,
      rows: [],
      status: "error",
      error: err && err.message ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
    };
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    RAW_SIGNAL_REQUIRED_FIELDS,
    RAW_SIGNAL_OPTIONAL_FIELDS,
    validateRawSignal,
    validateRawSignalBatch,
    buildSourceHealthRows,
    runSourceBranchSafely,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  const sample = [
    {
      signal_id: "sig_ok_1",
      source: "google_trends",
      term: "Pickleball Mom",
      date_collected: new Date().toISOString(),
      raw_payload_json: JSON.stringify({ traffic: "high" }),
    },
    {
      signal_id: "ERROR",
      source: "google_trends",
      term: "fetch_failed",
      date_collected: new Date().toISOString(),
      raw_payload_json: "boom",
    },
    {
      signal_id: "",
      source: "etsy_autocomplete",
      term: "Halloween Hoodie",
      date_collected: "not-a-date",
      raw_payload_json: "{",
    },
  ];

  const result = validateRawSignalBatch(sample);
  // eslint-disable-next-line no-console
  console.log("Batch result:", JSON.stringify(result, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    "Source health rows:",
    JSON.stringify(buildSourceHealthRows(result.stats.by_source, { run_id: "run_demo", run_date: "2026-04-28" }), null, 2)
  );
}
