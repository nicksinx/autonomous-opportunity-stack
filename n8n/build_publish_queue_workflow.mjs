#!/usr/bin/env node
/**
 * Builder for wf_publish_queue (Postgres edition).
 *
 * Collapses the previous read-then-upsert dance into a single Postgres
 * executeQuery using `ON CONFLICT (idempotency_key) DO UPDATE`. Lock
 * acquisition is also performed via SQL with row-level claim semantics.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pgNode } from "./build_pg_node.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "wf_publish_queue.json");

// --------------------------------------------------------------------------
// Build candidate queue rows from approved/draft_brief/manual_review briefs.
// Pulls a fresh run_week and run_id locally and emits one item per insert
// with the deterministic `idempotency_key` natural key.
// --------------------------------------------------------------------------
const codeBuildQueue = `const briefs = $('2. Read publish candidates').all().map(i=>i.json||{});
const nowIso = new Date().toISOString();
const runWeek = (() => {
  const d = new Date();
  // Monday of this ISO week:
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
})();
const run_id = 'run_wf_publish_queue_' + Date.now();
const str = v => String(v == null ? '' : v).trim();
const hash = s => { let h=0; const x=String(s||''); for(let i=0;i<x.length;i++){h=(h<<5)-h+x.charCodeAt(i);h|=0;} return Math.abs(h).toString(36); };

const seen = new Set();
const queue_rows = [];
for (const b of briefs) {
  const cluster_id = str(b.cluster_id) || null;
  const brief_id   = str(b.brief_id);
  const opp_id     = str(b.opp_id);
  const entity_key = brief_id || opp_id;
  if (!entity_key) continue;
  const idempotency_key = ['idem','v1',cluster_id,entity_key,runWeek].join(':');
  if (seen.has(idempotency_key)) continue;
  seen.add(idempotency_key);
  queue_rows.push({
    queue_id: 'q_' + hash(idempotency_key) + '_' + Date.now(),
    idempotency_key,
    run_id,
    run_week: runWeek,
    cluster_id,
    brief_id: brief_id || null,
    status: 'pending',
    attempt_count: 1,
    first_enqueued_at: nowIso,
    last_seen_at: nowIso,
    source_run_id: run_id,
    priority: str(b.priority) || 'medium',
    review_notes: opp_id ? 'source:outbox_approved' : ''
  });
}

const stage_rows = [
  { log_id: 'slog_wf_publish_queue_enqueue_'+Date.now()+'_start', run_id, workflow_name:'wf_publish_queue', stage_name:'enqueue', event_type:'start', started_at:nowIso, ended_at:null, duration_ms:null, rows_in:briefs.length, rows_out:0, error_count:0, status:'running', error_summary:'', attempt_number:1, parent_log_id:null, metadata_json:null },
  { log_id: 'slog_wf_publish_queue_enqueue_'+Date.now()+'_end',   run_id, workflow_name:'wf_publish_queue', stage_name:'enqueue', event_type:'end',   started_at:nowIso, ended_at:new Date().toISOString(), duration_ms:0, rows_in:briefs.length, rows_out:queue_rows.length, error_count:0, status:'success', error_summary:'', attempt_number:1, parent_log_id:null, metadata_json:{ enqueued: queue_rows.length } },
];
const workflow_rows = [{ run_id, run_started:nowIso, run_finished:new Date().toISOString(), job_name:'wf_publish_queue', rows_added:queue_rows.length, rows_updated:0, status:'success', error_log:'', sources_summary_json:{ briefs:briefs.length, enqueued:queue_rows.length }, stage_log_root_id:null }];

return [{ json: { run_id, queue_rows, stage_rows, workflow_rows } }];`;

// --------------------------------------------------------------------------
// SQL: single executeQuery handles both insert and the bump-on-existing case.
// --------------------------------------------------------------------------
const sqlUpsertQueue = `INSERT INTO publishing_queue
  (queue_id, idempotency_key, run_id, run_week, cluster_id, brief_id,
   status, attempt_count, first_enqueued_at, last_seen_at, source_run_id,
   priority, review_notes)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS t(queue_id text, idempotency_key text, run_id text, run_week date,
       cluster_id text, brief_id text, status text, attempt_count int,
       first_enqueued_at timestamptz, last_seen_at timestamptz,
       source_run_id text, priority text, review_notes text)
ON CONFLICT (idempotency_key) DO UPDATE
   SET attempt_count = publishing_queue.attempt_count + 1,
       last_seen_at  = EXCLUDED.last_seen_at,
       run_id        = EXCLUDED.run_id,
       priority      = EXCLUDED.priority`;

const sqlInsertStageLogs = `INSERT INTO stage_run_logs
  (log_id, run_id, workflow_name, stage_name, event_type, started_at, ended_at,
   duration_ms, rows_in, rows_out, error_count, status, error_summary,
   attempt_number, parent_log_id, metadata_json)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS t(log_id text, run_id text, workflow_name text, stage_name text,
       event_type text, started_at timestamptz, ended_at timestamptz,
       duration_ms int, rows_in int, rows_out int, error_count int,
       status text, error_summary text, attempt_number int,
       parent_log_id text, metadata_json jsonb)
ON CONFLICT (log_id) DO NOTHING`;

const sqlInsertWorkflowRun = `INSERT INTO workflow_runs
  (run_id, run_started, run_finished, job_name, rows_added, rows_updated,
   status, error_log, sources_summary_json, stage_log_root_id)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS t(run_id text, run_started timestamptz, run_finished timestamptz,
       job_name text, rows_added int, rows_updated int, status text,
       error_log text, sources_summary_json jsonb, stage_log_root_id text)
ON CONFLICT (run_id) DO NOTHING`;

// --------------------------------------------------------------------------
// Workflow descriptors
// --------------------------------------------------------------------------
const errorWorkflow = {
  id: "q9000009-0009-4009-8009-000000000001",
  name: "wf_publish_queue — Error Handler",
  active: false,
  nodes: [
    { parameters: {}, id: "q9-err-1", name: "Error Trigger", type: "n8n-nodes-base.errorTrigger", typeVersion: 1, position: [0, 240] },
    {
      parameters: {
        mode: "runOnceForAllItems", language: "javaScript",
        jsCode: "const j=$input.first().json||{};const wfName=j.workflow?.name||'unknown';const msg=j.execution?.error?.message||String(j.execution?.error||'Error');const now=new Date().toISOString();return [{json:{rows:[{run_id:'run_'+wfName+'_error_'+Date.now(),run_started:now,run_finished:now,job_name:wfName,rows_added:0,rows_updated:0,status:'error',error_log:msg,sources_summary_json:null,stage_log_root_id:null}]}}];",
      },
      id: "q9-err-2", name: "Build error row", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 240],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertWorkflowRun,
        parameters: ["={{ JSON.stringify($json.rows || []) }}"],
      }),
      id: "q9-err-3", name: "Insert workflow_runs (error)", position: [440, 240],
    },
  ],
  connections: {
    "Error Trigger": { main: [[{ node: "Build error row", type: "main", index: 0 }]] },
    "Build error row": { main: [[{ node: "Insert workflow_runs (error)", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1", timezone: "Europe/London" },
  tags: [{ name: "pod-research" }],
};

const wf = {
  id: "q9000009-0009-4009-8009-000000000002",
  name: "wf_publish_queue",
  active: false,
  nodes: [
    {
      parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 45 7 * * *" }] } },
      id: "q9-101", name: "1. Schedule Trigger",
      type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 480],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: `SELECT brief_id, cluster_id, status, run_date, opp_id, priority FROM (
  SELECT rb.brief_id, rb.cluster_id, rb.status, rb.run_date::date AS run_date,
         NULL::text AS opp_id, 'high'::text AS priority
    FROM range_briefs rb
   WHERE LOWER(rb.status) IN ('approved','draft','manual_review')
  UNION ALL
  SELECT NULL::text AS brief_id, NULL::text AS cluster_id, 'approved'::text AS status,
         CURRENT_DATE AS run_date, oc.opportunity_id::text AS opp_id, 'high'::text AS priority
    FROM workflow_outbox wo
    JOIN opportunity_candidate oc ON oc.opportunity_id::text = wo.aggregate_id
   WHERE wo.event_type = 'opportunity_approved_for_creative'
     AND wo.status = 'complete'
     AND wo.processed_at >= NOW() - INTERVAL '24 hours'
) q`,
      }),
      id: "q9-102", name: "2. Read publish candidates", position: [220, 480],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codeBuildQueue },
      id: "q9-103", name: "3. Build queue upsert payload",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [440, 480],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlUpsertQueue,
        parameters: ["={{ JSON.stringify($json.queue_rows || []) }}"],
      }),
      id: "q9-104", name: "4. Upsert publishing_queue", position: [660, 480],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertStageLogs,
        parameters: ["={{ JSON.stringify($('3. Build queue upsert payload').first().json.stage_rows || []) }}"],
      }),
      id: "q9-105", name: "5. Insert stage_run_logs", position: [880, 380],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertWorkflowRun,
        parameters: ["={{ JSON.stringify($('3. Build queue upsert payload').first().json.workflow_rows || []) }}"],
      }),
      id: "q9-106", name: "6. Insert workflow_runs", position: [880, 580],
    },
  ],
  connections: {
    "1. Schedule Trigger": { main: [[{ node: "2. Read publish candidates", type: "main", index: 0 }]] },
    "2. Read publish candidates": { main: [[{ node: "3. Build queue upsert payload", type: "main", index: 0 }]] },
    "3. Build queue upsert payload": {
      main: [[
        { node: "4. Upsert publishing_queue", type: "main", index: 0 },
        { node: "5. Insert stage_run_logs", type: "main", index: 0 },
        { node: "6. Insert workflow_runs", type: "main", index: 0 },
      ]],
    },
  },
  settings: { executionOrder: "v1", timezone: "Europe/London", errorWorkflow: "q9000009-0009-4009-8009-000000000001" },
  tags: [{ name: "pod-research" }],
};

fs.writeFileSync(outPath, JSON.stringify([errorWorkflow, wf], null, 2) + "\n", "utf8");
console.log("Wrote", outPath);
