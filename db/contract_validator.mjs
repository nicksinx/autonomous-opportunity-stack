/**
 * Validates canonical_signals rows against db/contracts/canonical_signal_v1.json.
 * Pure JS (no Ajv) — keeps dependencies minimal.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUIRED_TOP = [
  "signal_id",
  "contract_version",
  "source_type",
  "source_name",
  "lineage",
  "dedupe_key",
  "status",
];

const SOURCE_TYPES = new Set(["marketplace", "search", "social", "reviews", "csv", "internal", "unknown"]);
const STATUSES = new Set(["ready", "suppressed", "invalid", "archived", "quarantined"]);

function reason(ok, msg) {
  return { ok, reasons: msg ? [msg] : [] };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function validateCanonicalSignal(row) {
  const reasons = [];
  if (!row || typeof row !== "object") return reason(false, "row must be an object");

  for (const k of REQUIRED_TOP) {
    if (row[k] === undefined || row[k] === null || row[k] === "") {
      reasons.push(`missing_or_empty:${k}`);
    }
  }
  if (typeof row.signal_id === "string" && row.signal_id.length === 0) reasons.push("signal_id empty");

  if (typeof row.source_type === "string" && !SOURCE_TYPES.has(row.source_type)) {
    reasons.push(`source_type_invalid:${row.source_type}`);
  }
  if (typeof row.status === "string" && !STATUSES.has(row.status)) {
    reasons.push(`status_invalid:${row.status}`);
  }

  const lineage = row.lineage;
  if (!lineage || typeof lineage !== "object") {
    reasons.push("lineage_must_be_object");
  } else if (
    lineage.normalized_term_id === undefined ||
    lineage.normalized_term_id === null ||
    String(lineage.normalized_term_id).trim() === ""
  ) {
    reasons.push("lineage.normalized_term_id required");
  }

  return reasons.length ? { ok: false, reasons } : { ok: true, reasons: [] };
}

/** Load JSON Schema file for documentation / future AJV use */
export function loadCanonicalSignalSchema() {
  const p = path.join(__dirname, "contracts", "canonical_signal_v1.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
