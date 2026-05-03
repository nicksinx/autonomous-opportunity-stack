/**
 * Phase 1 patch for wf_normalize_terms.json:
 * - extend Build normalized terms with signalLinks + __signal_links on sidecars
 * - remove dual_write_mirror_log nodes
 * - add Prepare raw_signals lineage + Postgres UPDATE chain from Build normalized terms
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const wfPath = path.join(root, "n8n/wf_normalize_terms.json");

const data = JSON.parse(fs.readFileSync(wfPath, "utf8"));
const wf = data.find((w) => w.name === "wf_normalize_terms");
if (!wf) throw new Error("wf_normalize_terms not found");

const buildNode = wf.nodes.find((n) => n.name === "Build normalized terms");
if (!buildNode) throw new Error("Build normalized terms node missing");

let code = buildNode.parameters.jsCode;

code = code.replace(
  "const stats = { created: 0, merged: 0, skipped: 0, low_confidence: 0, duplicates: 0 };",
  "const stats = { created: 0, merged: 0, skipped: 0, low_confidence: 0, duplicates: 0 };\nconst signalLinks = [];",
);

code = code.replace(
  "if (existing.has(canonicalId)) {\n    stats.duplicates += 1;\n    logRows.push(logRow({ run_id: runId, run_date: runDate, canonical_id: canonicalId, input_term: term, decision_type: 'skipped', confidence: 1, merged_into: canonicalId, reason: 'already_canonical' }));\n    continue;\n  }",
  "if (existing.has(canonicalId)) {\n    stats.duplicates += 1;\n    logRows.push(logRow({ run_id: runId, run_date: runDate, canonical_id: canonicalId, input_term: term, decision_type: 'skipped', confidence: 1, merged_into: canonicalId, reason: 'already_canonical' }));\n    signalLinks.push({ signal_id: signalId, canonical_id: canonicalId });\n    continue;\n  }",
);

code = code.replace(
  "    });\n  }\n}\n\nconst normalizedRows = Array.from(groups.values())",
  "    });\n  }\n  signalLinks.push({ signal_id: signalId, canonical_id: canonicalId });\n}\n\nconst normalizedRows = Array.from(groups.values())",
);

code = code.replace(
  "{ __noRows: true, __runMeta: { run_id: runId, run_started: runStarted }, __logRows: logRows, __watchRows: watchRows, __stats: stats, run_id: runId,",
  "{ __noRows: true, __runMeta: { run_id: runId, run_started: runStarted }, __logRows: logRows, __watchRows: watchRows, __stats: stats, __signal_links: signalLinks, run_id: runId,",
);

code = code.replace(
  "{ __sidecar: true, __runMeta: { run_id: runId, run_started: runStarted }, __logRows: logRows, __watchRows: watchRows, __stats: stats }",
  "{ __sidecar: true, __runMeta: { run_id: runId, run_started: runStarted }, __logRows: logRows, __watchRows: watchRows, __stats: stats, __signal_links: signalLinks }",
);

buildNode.parameters.jsCode = code;

const mirrorIds = new Set([
  "b2000002-0002-4002-8002-000000000033",
  "b2000002-0002-4002-8002-000000000034",
]);
wf.nodes = wf.nodes.filter((n) => !mirrorIds.has(n.id));

const lineageCode = `const items = $('Build normalized terms').all();
let links = [];
for (const it of items) {
  const j = it.json || {};
  if (j.__sidecar && Array.isArray(j.__signal_links)) links = j.__signal_links;
  if (j.__noRows && Array.isArray(j.__signal_links)) links = j.__signal_links;
}
return [{ json: { signal_links_json: JSON.stringify(links) } }];`;

wf.nodes.push({
  parameters: {
    mode: "runOnceForAllItems",
    language: "javaScript",
    jsCode: lineageCode,
  },
  id: "b2000002-0002-4002-8002-000000000035",
  name: "Prepare raw_signals lineage update",
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: [880, -120],
});

wf.nodes.push({
  parameters: {
    operation: "executeQuery",
    query: `UPDATE raw_signals AS rs
SET canonical_id = v.canonical_id
FROM jsonb_to_recordset($1::jsonb) AS v(signal_id text, canonical_id text)
WHERE rs.signal_id = v.signal_id
  AND v.signal_id IS NOT NULL
  AND v.signal_id <> ''
  AND v.canonical_id IS NOT NULL`,
    options: {
      queryReplacement: "={{ $json.signal_links_json }}",
    },
  },
  id: "b2000002-0002-4002-8002-000000000036",
  name: "Update raw_signals canonical_id",
  type: "n8n-nodes-base.postgres",
  typeVersion: 2.6,
  position: [1100, -120],
  credentials: {
    postgres: { name: "Postgres - POD Research" },
  },
});

const conn = wf.connections;

conn["Build normalized terms"].main[0].push({
  node: "Prepare raw_signals lineage update",
  type: "main",
  index: 0,
});

conn["Prepare raw_signals lineage update"] = {
  main: [[{ node: "Update raw_signals canonical_id", type: "main", index: 0 }]],
};

if (conn["Append workflow_runs (success)"]?.main?.[0]) {
  conn["Append workflow_runs (success)"].main[0] = conn["Append workflow_runs (success)"].main[0].filter(
    (c) => c.node !== "Build normalized_terms mirror rows",
  );
}

delete conn["Build normalized_terms mirror rows"];

fs.writeFileSync(wfPath, JSON.stringify(data, null, 2), "utf8");
console.log("Patched", wfPath);
