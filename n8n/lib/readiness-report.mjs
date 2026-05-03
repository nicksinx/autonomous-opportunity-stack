/**
 * Markdown writer for the Layer 2 readiness gate.
 * Pure function: takes the structured result, returns a markdown string.
 */

const SECTION_TITLES = {
  must: "Must Complete",
  should: "Strongly Recommended",
  defer: "Can Be Deferred",
  decision: "Decisions Needed",
};

const STATUS_LABEL = {
  pass: "PASS",
  fail: "FAIL",
  partial: "PARTIAL",
  deferred: "DEFERRED",
  skipped: "SKIPPED",
  unknown: "UNKNOWN",
};

function escMd(s) {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function summarize(results) {
  const buckets = { must: {}, should: {}, defer: {}, decision: {} };
  for (const r of results) {
    const b = (buckets[r.section] = buckets[r.section] || {});
    b[r.status] = (b[r.status] || 0) + 1;
  }
  return buckets;
}

function bucketLine(section, b) {
  const total = Object.values(b).reduce((a, v) => a + v, 0);
  const pieces = [];
  for (const k of ["pass", "fail", "partial", "deferred", "skipped", "unknown"]) {
    if (b[k]) pieces.push(`${b[k]} ${k}`);
  }
  return `- ${SECTION_TITLES[section]}: ${total} total (${pieces.join(", ")})`;
}

function table(rows) {
  const lines = [
    "| ID | Title | Status | Evidence | Fix |",
    "| -- | -- | -- | -- | -- |",
  ];
  for (const r of rows) {
    lines.push(
      `| \`${escMd(r.id)}\` | ${escMd(r.title)} | ${STATUS_LABEL[r.status]} | ${escMd(r.evidence || "")} | ${escMd(r.fixHint || "")} |`,
    );
  }
  return lines.join("\n");
}

/**
 * @param {{ verdict: "READY"|"NOT READY"|"NEEDS INPUT", generatedAt: string, repoHead?: string, results: Array, options?: object }} ctx
 */
export function renderReport({ verdict, generatedAt, repoHead, results, options }) {
  const buckets = summarize(results);
  const ts = generatedAt || new Date().toISOString();
  const lines = [];
  lines.push("# Layer 2 Readiness Report");
  lines.push("");
  lines.push(`Generated: ${ts}  |  Repo HEAD: ${repoHead || "?"}  |  Verdict: **${verdict}**`);
  lines.push("");
  if (options) {
    const flags = Object.entries(options)
      .filter(([_, v]) => v)
      .map(([k]) => `\`--${k}\``)
      .join(", ");
    if (flags) lines.push(`Flags: ${flags}`);
    lines.push("");
  }
  lines.push("## Summary");
  for (const sec of ["must", "should", "defer", "decision"]) {
    lines.push(bucketLine(sec, buckets[sec] || {}));
  }
  lines.push("");

  for (const sec of ["must", "should", "defer", "decision"]) {
    const rows = results.filter((r) => r.section === sec);
    if (!rows.length) continue;
    lines.push(`## ${SECTION_TITLES[sec]}`);
    lines.push("");
    lines.push(table(rows));
    lines.push("");
  }

  lines.push("---");
  lines.push("Run with `npm run layer2:readiness` (status only), `npm run layer2:readiness:report` (regenerate this file), or `npm run layer2:readiness:full` (report + `npm test` + `n8n:validate`).");
  lines.push("");
  return lines.join("\n");
}

/** Compact human summary for stdout. */
export function renderHuman({ verdict, results }) {
  const buckets = summarize(results);
  const lines = [`Layer 2 readiness: ${verdict}`];
  for (const sec of ["must", "should", "defer", "decision"]) {
    lines.push(bucketLine(sec, buckets[sec] || {}));
  }
  const failing = results.filter((r) => r.status === "fail");
  if (failing.length) {
    lines.push("");
    lines.push("Failing:");
    for (const r of failing) {
      lines.push(`  [${STATUS_LABEL[r.status]}] ${r.id} — ${r.evidence}${r.fixHint ? `  -> ${r.fixHint}` : ""}`);
    }
  }
  const partial = results.filter((r) => r.status === "partial");
  if (partial.length) {
    lines.push("");
    lines.push("Partial:");
    for (const r of partial) {
      lines.push(`  [PARTIAL] ${r.id} — ${r.evidence}${r.fixHint ? `  -> ${r.fixHint}` : ""}`);
    }
  }
  return lines.join("\n");
}
