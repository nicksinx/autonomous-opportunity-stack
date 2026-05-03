import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pgNode } from "./build_pg_node.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const layer2ScoreCode = fs.readFileSync(path.join(__dirname, "layer2_score_code.js"), "utf8");
const clusterCode = fs.readFileSync(path.join(__dirname, "cluster_code.js"), "utf8");

const scoringVersionLiteral = String(process.env.LAYER2_SCORING_VERSION || "1.0.0").replace(/'/g, "''");

// ----------------------------------------------------------------------------
// SQL helpers — bulk inserts via jsonb_to_recordset, parameter-bound to a
// single JSON array stringified from the upstream Code node. This collapses
// the previous "Expand <field>" + "Append <field>" two-node pairs into one
// Postgres executeQuery node per bulk write.
// ----------------------------------------------------------------------------

function jsonbBulkInsert({ table, columns, types, conflict, action }) {
  const colCsv = columns.join(", ");
  const recordCsv = columns.map((c, i) => `${c} ${types[i]}`).join(", ");
  const conflictClause =
    conflict && action
      ? `ON CONFLICT (${conflict}) DO ${action}`
      : "ON CONFLICT DO NOTHING";
  return `INSERT INTO ${table} (${colCsv})
SELECT ${colCsv}
  FROM jsonb_to_recordset($1::jsonb) AS t(${recordCsv})
${conflictClause}`;
}

const sqlBeginScoringRun = `INSERT INTO scoring_runs (trigger_type, trigger_ref, scoring_version, scope, status)
VALUES ('scheduled', NULL, '${scoringVersionLiteral}', '{}'::jsonb, 'running')
RETURNING scoring_run_id`;

const sqlUpsertOpportunityCandidate = `INSERT INTO opportunity_candidate (
  opportunity_id, candidate_version, cluster_id, title, primary_niche, sub_niche,
  target_audience, product_type_candidates, commercial_hypothesis, creative_hypotheses,
  market_context, risk_level, readiness_status, latest_score_id, latest_score,
  latest_confidence, score_version, canonical_id
)
SELECT
  opportunity_id, candidate_version, cluster_id, title, primary_niche, sub_niche,
  target_audience::jsonb, product_type_candidates::jsonb, commercial_hypothesis, creative_hypotheses::jsonb,
  market_context::jsonb, risk_level, readiness_status, latest_score_id, latest_score,
  latest_confidence, score_version, canonical_id
FROM jsonb_to_recordset($1::jsonb) AS t(
  opportunity_id uuid, candidate_version text, cluster_id uuid, title text, primary_niche text, sub_niche text,
  target_audience text, product_type_candidates text, commercial_hypothesis text, creative_hypotheses text,
  market_context text, risk_level text, readiness_status text, latest_score_id uuid, latest_score numeric,
  latest_confidence numeric, score_version text, canonical_id text
)
ON CONFLICT (canonical_id) DO UPDATE SET
  candidate_version = EXCLUDED.candidate_version,
  title = EXCLUDED.title,
  primary_niche = EXCLUDED.primary_niche,
  readiness_status = EXCLUDED.readiness_status,
  latest_score_id = EXCLUDED.latest_score_id,
  latest_score = EXCLUDED.latest_score,
  latest_confidence = EXCLUDED.latest_confidence,
  score_version = EXCLUDED.score_version,
  updated_at = NOW()`;

const sqlInsertOpportunityScore = jsonbBulkInsert({
  table: "opportunity_score",
  columns: [
    "score_id", "opportunity_id", "scoring_run_id", "score_version",
    "total_score", "confidence_score", "recommendation", "summary_reason",
    "positive_drivers", "negative_drivers", "evidence_refs",
  ],
  types: [
    "uuid", "uuid", "uuid", "text",
    "numeric", "numeric", "text", "text",
    "jsonb", "jsonb", "jsonb",
  ],
  conflict: null,
  action: null,
});

const sqlInsertOpportunityFactors = jsonbBulkInsert({
  table: "opportunity_score_factor",
  columns: [
    "factor_id", "score_id", "factor_name", "raw_value", "weight",
    "factor_value", "factor_reason", "evidence",
  ],
  types: [
    "uuid", "uuid", "text", "numeric", "numeric",
    "numeric", "text", "jsonb",
  ],
  conflict: null,
  action: null,
});

const sqlInsertOutbox = jsonbBulkInsert({
  table: "workflow_outbox",
  columns: [
    "aggregate_type", "aggregate_id", "event_type", "payload", "schema_version",
  ],
  types: ["text", "text", "text", "jsonb", "text"],
  conflict: null,
  action: null,
});

const sqlInsertTrendClusterV2 = jsonbBulkInsert({
  table: "trend_cluster_v2",
  columns: [
    "cluster_id",
    "cluster_key",
    "cluster_version",
    "primary_topic",
    "niche",
    "sub_niche",
    "source_count",
    "signal_count",
    "supporting_signal_ids",
    "aggregate_metrics",
    "freshness_window",
  ],
  types: [
    "uuid",
    "text",
    "text",
    "text",
    "text",
    "text",
    "int",
    "int",
    "jsonb",
    "jsonb",
    "jsonb",
  ],
  conflict: null,
  action: null,
});

const sqlInsertClusterMembersV2 = jsonbBulkInsert({
  table: "cluster_members_v2",
  columns: ["member_id", "cluster_id", "canonical_id", "canonical_term", "member_role", "fit_score"],
  types: ["uuid", "uuid", "text", "text", "text", "numeric"],
  conflict: null,
  action: null,
});

const sqlUpdateCandidateClusters = `WITH upd AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS v(canonical_id text, cluster_id uuid)
)
UPDATE opportunity_candidate oc
SET cluster_id = upd.cluster_id, updated_at = NOW()
FROM upd
WHERE oc.canonical_id = upd.canonical_id`;

const sqlCompleteScoringRun = `UPDATE scoring_runs SET status = 'success', finished_at = NOW(), metrics = $2::jsonb WHERE scoring_run_id = $1::uuid`;

const sqlUpsertNormalizedScores = `INSERT INTO normalized_terms
  (canonical_id, last_scored_at, latest_opp_id, latest_opportunity_score, latest_tier, canonical_term, status)
SELECT
  canonical_id, last_scored_at, latest_opp_id, latest_opportunity_score, latest_tier,
  COALESCE(canonical_term, canonical_id) AS canonical_term,
  'active'                              AS status
  FROM jsonb_to_recordset($1::jsonb)
       AS t(canonical_id text, last_scored_at timestamptz, latest_opp_id text,
             latest_opportunity_score numeric, latest_tier text, canonical_term text)
ON CONFLICT (canonical_id) DO UPDATE SET
  last_scored_at           = EXCLUDED.last_scored_at,
  latest_opp_id            = EXCLUDED.latest_opp_id,
  latest_opportunity_score = EXCLUDED.latest_opportunity_score,
  latest_tier              = EXCLUDED.latest_tier`;

const sqlInsertScoringAudit = `INSERT INTO scoring_audit_log
  (audit_id, run_date, run_id, candidates_evaluated, tier_A_count, tier_B_count,
   tier_C_count, rejected_count, avg_opportunity_score, top_opportunity,
   scorer_version, notes)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS t(audit_id text, run_date date, run_id text, candidates_evaluated int,
       tier_A_count int, tier_B_count int, tier_C_count int, rejected_count int,
       avg_opportunity_score numeric, top_opportunity text, scorer_version text, notes text)
ON CONFLICT (audit_id) DO NOTHING`;

const sqlInsertThemeClusters = jsonbBulkInsert({
  table: "theme_clusters",
  columns: [
    "cluster_id", "run_date", "theme_name", "theme_slug", "parent_theme",
    "theme_summary", "audience", "occasion_type", "seasonality", "product_fit",
    "style_fit", "risk_level", "cluster_score", "term_count", "status", "review_notes",
  ],
  types: [
    "text", "date", "text", "text", "text",
    "text", "text", "text", "text", "text",
    "text", "text", "numeric", "int", "text", "text",
  ],
  conflict: "cluster_id",
  action: "NOTHING",
});

const sqlInsertStageRunLogs = jsonbBulkInsert({
  table: "stage_run_logs",
  columns: [
    "log_id", "run_id", "workflow_name", "stage_name", "event_type",
    "started_at", "ended_at", "duration_ms", "rows_in", "rows_out",
    "error_count", "status", "error_summary", "attempt_number",
    "parent_log_id", "metadata_json",
  ],
  types: [
    "text", "text", "text", "text", "text",
    "timestamptz", "timestamptz", "int", "int", "int",
    "int", "text", "text", "int",
    "text", "jsonb",
  ],
  conflict: null,
  action: null,
});

const sqlInsertWorkflowRun = `INSERT INTO workflow_runs
  (run_id, run_started, run_finished, job_name, rows_added, rows_updated,
   status, error_log, sources_summary_json, stage_log_root_id)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS t(run_id text, run_started timestamptz, run_finished timestamptz,
       job_name text, rows_added int, rows_updated int, status text,
       error_log text, sources_summary_json jsonb, stage_log_root_id text)
ON CONFLICT (run_id) DO NOTHING`;

// ----------------------------------------------------------------------------
// Code-node bodies (unchanged scoring engine, with read-side filtering removed
// because SQL WHEREs in nodes 2/3/4/5 already constrain the rows).
// ----------------------------------------------------------------------------

const codeScore = layer2ScoreCode;

const codeTierAB = `const j = $('5. Score all candidates (Layer 2)').first().json || {}; const rows = Array.isArray(j.scored_rows) ? j.scored_rows : []; return rows.filter(r => ['A','B'].includes(String(r.tier||''))).map(r => ({json:r}));`;

const codeRunLog = `const meta = $('5. Score all candidates (Layer 2)').first().json;
const now = new Date().toISOString();
const runId = meta.run_id || ('run_wf_score_and_cluster_' + Date.now());
const scoreCount = Number(meta.audit_row?.candidates_evaluated||0);
const trendScoreCount = scoreCount;
let themeCount = 0;
try { themeCount = ($('15. Clustering').first().json.cluster_rows||[]).length; } catch (_e) { themeCount = 0; }
const start = meta.run_started || now;
const stage_run_logs_rows = [
  {log_id:'slog_wf_score_and_cluster_main_'+Date.now()+'_start',run_id:runId,workflow_name:'wf_score_and_cluster',stage_name:'score_and_cluster',event_type:'start',started_at:start,ended_at:null,duration_ms:null,rows_in:scoreCount,rows_out:0,error_count:0,status:'running',error_summary:'',attempt_number:1,parent_log_id:null,metadata_json:null},
  {log_id:'slog_wf_score_and_cluster_main_'+Date.now()+'_end',run_id:runId,workflow_name:'wf_score_and_cluster',stage_name:'score_and_cluster',event_type:'end',started_at:start,ended_at:now,duration_ms:Math.max(0,Date.parse(now)-Date.parse(start)),rows_in:scoreCount,rows_out:scoreCount,error_count:0,status:'success',error_summary:'',attempt_number:1,parent_log_id:null,metadata_json:null}
];
const workflow_runs_rows = [{run_id:runId,run_started:start,run_finished:now,job_name:'wf_score_and_cluster',rows_added:scoreCount,rows_updated:Array.isArray(meta.normalized_terms_updates)?meta.normalized_terms_updates.length:0,status:'success',error_log:'',sources_summary_json:{candidates:scoreCount,trends:trendScoreCount,clusters:themeCount},stage_log_root_id:null}];
return [{json:{run_id:runId, stage_run_logs_rows, workflow_runs_rows}}];`;

// ----------------------------------------------------------------------------
// Workflow descriptors
// ----------------------------------------------------------------------------

const wf = {
  id: "d4000004-0004-4004-8004-000000000002",
  name: "wf_score_and_cluster",
  active: false,
  nodes: [
    {
      parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 0 7 * * *" }] } },
      id: "d4-101",
      name: "1. Schedule Trigger — 07:00 Europe/London daily",
      type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.2,
      position: [0, 300],
    },
    {
      ...pgNode({ operation: "executeQuery", query: sqlBeginScoringRun }),
      id: "d4-101b",
      name: "2. Begin scoring_run",
      position: [220, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: "SELECT * FROM canonical_signals WHERE status = 'ready'",
      }),
      id: "d4-102c",
      name: "3. Read canonical_signals (ready)",
      position: [440, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: "SELECT * FROM score_weights WHERE enabled = TRUE",
      }),
      id: "d4-105",
      name: "4. Read score_weights (enabled)",
      position: [660, 300],
    },
    {
      parameters: {
        mode: "runOnceForAllItems",
        language: "javaScript",
        jsCode: codeScore,
      },
      id: "d4-107",
      name: "5. Score all candidates (Layer 2)",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [880, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlUpsertOpportunityCandidate,
        parameters: [
          "={{ JSON.stringify($('5. Score all candidates (Layer 2)').first().json.opportunity_candidate_upsert || []) }}",
        ],
      }),
      id: "d4-108",
      name: "6. Upsert opportunity_candidate",
      position: [1100, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertOpportunityScore,
        parameters: [
          "={{ JSON.stringify($('5. Score all candidates (Layer 2)').first().json.opportunity_score_rows || []) }}",
        ],
      }),
      id: "d4-109",
      name: "7. Insert opportunity_score",
      position: [1320, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertOpportunityFactors,
        parameters: [
          "={{ JSON.stringify($('5. Score all candidates (Layer 2)').first().json.opportunity_score_factor_rows || []) }}",
        ],
      }),
      id: "d4-110",
      name: "8. Insert opportunity_score_factor",
      position: [1540, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertOutbox,
        parameters: [
          "={{ JSON.stringify($('5. Score all candidates (Layer 2)').first().json.workflow_outbox_rows || []) }}",
        ],
      }),
      id: "d4-111",
      name: "9. Insert workflow_outbox",
      position: [1760, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlUpsertNormalizedScores,
        parameters: [
          "={{ JSON.stringify($('5. Score all candidates (Layer 2)').first().json.normalized_terms_updates || []) }}",
        ],
      }),
      id: "d4-112",
      name: "10. Upsert normalized_terms scores",
      position: [1980, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertScoringAudit,
        parameters: [
          "={{ JSON.stringify([$('5. Score all candidates (Layer 2)').first().json.audit_row]) }}",
        ],
      }),
      id: "d4-113",
      name: "11. Insert scoring_audit_log",
      position: [2200, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlCompleteScoringRun,
        parameters: [
          "={{ $('5. Score all candidates (Layer 2)').first().json.scoring_run_id }}",
          "={{ JSON.stringify($('5. Score all candidates (Layer 2)').first().json.scoring_metrics || {}) }}",
        ],
      }),
      id: "d4-114",
      name: "12. Complete scoring_run",
      position: [2420, 300],
    },
    {
      parameters: {
        conditions: {
          options: { version: 2, leftValue: "", caseSensitive: true, typeValidation: "strict" },
          conditions: [
            {
              id: "tA",
              leftValue:
                "={{ Number($('5. Score all candidates (Layer 2)').first().json.audit_row.tier_A_count || 0) }}",
              rightValue: 0,
              operator: { type: "number", operation: "gt" },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
      id: "d4-115",
      name: "13. Has Tier A opportunities?",
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      position: [2640, 420],
    },
    {
      parameters: {
        mode: "runOnceForAllItems",
        language: "javaScript",
        jsCode: codeTierAB,
      },
      id: "d4-113b",
      name: "14. Filter Tier A and B for clustering",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [2860, 300],
    },
    {
      parameters: {
        mode: "runOnceForAllItems",
        language: "javaScript",
        jsCode: clusterCode,
      },
      id: "d4-114b",
      name: "15. Clustering",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [3080, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertTrendClusterV2,
        parameters: [
          "={{ JSON.stringify($('15. Clustering').first().json.trend_cluster_v2_rows || []) }}",
        ],
      }),
      id: "d4-114t1",
      name: "16. Insert trend_cluster_v2",
      position: [3190, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertClusterMembersV2,
        parameters: [
          "={{ JSON.stringify($('15. Clustering').first().json.cluster_members_v2_rows || []) }}",
        ],
      }),
      id: "d4-114t2",
      name: "17. Insert cluster_members_v2",
      position: [3300, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlUpdateCandidateClusters,
        parameters: [
          "={{ JSON.stringify($('15. Clustering').first().json.candidate_cluster_updates || []) }}",
        ],
      }),
      id: "d4-114t3",
      name: "18. Update opportunity_candidate clusters",
      position: [3410, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertThemeClusters,
        parameters: [
          "={{ JSON.stringify($('15. Clustering').first().json.cluster_rows || []) }}",
        ],
      }),
      id: "d4-115b",
      name: "19. Insert theme_clusters",
      position: [3520, 300],
    },
    {
      parameters: {
        mode: "runOnceForAllItems",
        language: "javaScript",
        jsCode: codeRunLog,
      },
      id: "d4-116",
      name: "20. Build run log rows",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [3740, 420],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertStageRunLogs,
        parameters: ["={{ JSON.stringify($json.stage_run_logs_rows || []) }}"],
      }),
      id: "d4-117",
      name: "21. Insert stage_run_logs",
      position: [3960, 360],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertWorkflowRun,
        parameters: ["={{ JSON.stringify($json.workflow_runs_rows || []) }}"],
      }),
      id: "d4-118",
      name: "22. Insert workflow_runs",
      position: [3960, 460],
    },
  ],
  connections: {
    "1. Schedule Trigger — 07:00 Europe/London daily": {
      main: [[{ node: "2. Begin scoring_run", type: "main", index: 0 }]],
    },
    "2. Begin scoring_run": {
      main: [[{ node: "3. Read canonical_signals (ready)", type: "main", index: 0 }]],
    },
    "3. Read canonical_signals (ready)": {
      main: [[{ node: "4. Read score_weights (enabled)", type: "main", index: 0 }]],
    },
    "4. Read score_weights (enabled)": {
      main: [[{ node: "5. Score all candidates (Layer 2)", type: "main", index: 0 }]],
    },
    "5. Score all candidates (Layer 2)": {
      main: [[{ node: "6. Upsert opportunity_candidate", type: "main", index: 0 }]],
    },
    "6. Upsert opportunity_candidate": {
      main: [[{ node: "7. Insert opportunity_score", type: "main", index: 0 }]],
    },
    "7. Insert opportunity_score": {
      main: [[{ node: "8. Insert opportunity_score_factor", type: "main", index: 0 }]],
    },
    "8. Insert opportunity_score_factor": {
      main: [[{ node: "9. Insert workflow_outbox", type: "main", index: 0 }]],
    },
    "9. Insert workflow_outbox": {
      main: [[{ node: "10. Upsert normalized_terms scores", type: "main", index: 0 }]],
    },
    "10. Upsert normalized_terms scores": {
      main: [[{ node: "11. Insert scoring_audit_log", type: "main", index: 0 }]],
    },
    "11. Insert scoring_audit_log": {
      main: [[{ node: "12. Complete scoring_run", type: "main", index: 0 }]],
    },
    "12. Complete scoring_run": {
      main: [[{ node: "13. Has Tier A opportunities?", type: "main", index: 0 }]],
    },
    "13. Has Tier A opportunities?": {
      main: [
        [{ node: "14. Filter Tier A and B for clustering", type: "main", index: 0 }],
        [{ node: "20. Build run log rows", type: "main", index: 0 }],
      ],
    },
    "14. Filter Tier A and B for clustering": {
      main: [[{ node: "15. Clustering", type: "main", index: 0 }]],
    },
    "15. Clustering": {
      main: [[{ node: "16. Insert trend_cluster_v2", type: "main", index: 0 }]],
    },
    "16. Insert trend_cluster_v2": {
      main: [[{ node: "17. Insert cluster_members_v2", type: "main", index: 0 }]],
    },
    "17. Insert cluster_members_v2": {
      main: [[{ node: "18. Update opportunity_candidate clusters", type: "main", index: 0 }]],
    },
    "18. Update opportunity_candidate clusters": {
      main: [[{ node: "19. Insert theme_clusters", type: "main", index: 0 }]],
    },
    "19. Insert theme_clusters": {
      main: [[{ node: "20. Build run log rows", type: "main", index: 0 }]],
    },
    "20. Build run log rows": {
      main: [[{ node: "22. Insert workflow_runs", type: "main", index: 0 }]],
    },
    "22. Insert workflow_runs": {
      main: [[{ node: "21. Insert stage_run_logs", type: "main", index: 0 }]],
    },
  },
  settings: {
    executionOrder: "v1",
    timezone: "Europe/London",
    errorWorkflow: "d4000004-0004-4004-8004-000000000001",
  },
  staticData: null,
  meta: { templateCredsSetupCompleted: true },
  pinData: {},
  tags: [{ name: "pod-research" }],
  versionId: "d4000004-0004-4004-8004-0000000000f3",
};


const errorWorkflow = {
  id: "d4000004-0004-4004-8004-000000000001",
  name: "wf_score_and_cluster — Error Handler",
  active: false,
  nodes: [
    { parameters: {}, id: "d4000004-0004-4004-8004-000000000011", name: "Error Trigger", type: "n8n-nodes-base.errorTrigger", typeVersion: 1, position: [0, 260] },
    {
      parameters: {
        mode: "runOnceForAllItems", language: "javaScript",
        jsCode: "const j=$input.first().json||{};const wfName=j.workflow?.name||'unknown';const msg=j.execution?.error?.message||String(j.execution?.error||'Error');const now=new Date().toISOString();return [{json:{rows:[{run_id:'run_'+wfName+'_error_'+Date.now(),run_started:now,run_finished:now,job_name:wfName,rows_added:0,rows_updated:0,status:'error',error_log:msg,sources_summary_json:null,stage_log_root_id:null}]}}];",
      },
      id: "d4000004-0004-4004-8004-000000000012", name: "Build error row",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 260],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertWorkflowRun,
        parameters: ["={{ JSON.stringify($json.rows || []) }}"],
      }),
      id: "d4000004-0004-4004-8004-000000000013",
      name: "Insert workflow_runs (error)",
      position: [440, 260],
    },
  ],
  connections: {
    "Error Trigger": { main: [[{ node: "Build error row", type: "main", index: 0 }]] },
    "Build error row": { main: [[{ node: "Insert workflow_runs (error)", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1", timezone: "Europe/London" },
  staticData: null, meta: { templateCredsSetupCompleted: true }, pinData: {},
  tags: [{ name: "pod-research" }],
  versionId: "d4000004-0004-4004-8004-0000000000e1",
};

const outPath = path.join(__dirname, "wf_score_and_cluster.json");
fs.writeFileSync(outPath, JSON.stringify([errorWorkflow, wf], null, 2), "utf8");
console.log("Wrote", outPath);
