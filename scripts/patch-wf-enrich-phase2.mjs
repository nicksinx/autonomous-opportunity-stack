/**
 * Phase 2: after wf_enrich_marketplace success, refresh canonical_signals.competition_metrics from marketplace_evidence (7d).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wfPath = path.join(__dirname, "..", "n8n/wf_enrich_marketplace.json");

const sql = `WITH agg AS (
  SELECT
    canonical_id,
    jsonb_build_object(
      'window_days', 7,
      'evidence_rows', COUNT(*)::int,
      'distinct_sources', COUNT(DISTINCT source)::int
    ) AS metrics
  FROM marketplace_evidence
  WHERE captured_at >= NOW() - INTERVAL '7 days'
  GROUP BY canonical_id
)
UPDATE canonical_signals AS cs
SET competition_metrics = agg.metrics,
    updated_at = NOW()
FROM agg
WHERE cs.lineage->>'normalized_term_id' = agg.canonical_id
  AND cs.contract_version = '2026-05-01'`;

const data = JSON.parse(fs.readFileSync(wfPath, "utf8"));
const wf = data.find((w) => w.name === "wf_enrich_marketplace");
if (!wf) throw new Error("wf_enrich_marketplace missing");

wf.nodes.push({
  parameters: {
    operation: "executeQuery",
    query: sql,
    options: {},
  },
  id: "c3000003-0003-4003-8003-000000000040",
  name: "Update canonical_signals competition_metrics",
  type: "n8n-nodes-base.postgres",
  typeVersion: 2.6,
  position: [1980, 120],
  credentials: { postgres: { name: "Postgres - POD Research" } },
});

wf.connections["Append workflow_runs (success)"] = {
  main: [[{ node: "Update canonical_signals competition_metrics", type: "main", index: 0 }]],
};

fs.writeFileSync(wfPath, JSON.stringify(data, null, 2), "utf8");
console.log("Patched", wfPath);
