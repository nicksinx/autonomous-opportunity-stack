#!/usr/bin/env node
/**
 * Emits wf_layer3_creative_pack.json — Layer 3 creative pack (MJ prompts + OpenAI images + SVG).
 *
 * Env (n8n): ANTHROPIC_API_KEY, OPENAI_API_KEY
 * Optional: LAYER3_OPENAI_IMAGE_MODEL (default dall-e-3), LAYER3_SKIP_DRIVE_UPLOAD (default true)
 *
 * Google Drive upload nodes are omitted here; set LAYER3_SKIP_DRIVE_UPLOAD=false and attach Drive
 * nodes in n8n UI, or see docs/layer3-google-drive-n8n.md.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pgNode } from "./build_pg_node.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sqlPendingOpportunities = `SELECT oc.opportunity_id, oc.title, oc.primary_niche, oc.sub_niche,
  oc.target_audience, oc.product_type_candidates, oc.commercial_hypothesis,
  oc.creative_hypotheses, oc.market_context, oc.risk_level,
  oc.latest_score_id, oc.latest_score, oc.latest_confidence,
  oc.canonical_id
FROM opportunity_candidate oc
WHERE oc.readiness_status = 'approved_for_creative'
  AND oc.latest_score_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM creative_generation_run r
    WHERE r.opportunity_id = oc.opportunity_id
      AND (r.score_id IS NOT DISTINCT FROM oc.latest_score_id)
      AND r.status IN ('success', 'partial')
  )
ORDER BY oc.updated_at DESC
LIMIT 10`;

const sqlInsertRun = `INSERT INTO creative_generation_run (
  opportunity_id, score_id, status, idempotency_key, workflow_version, started_at
)
SELECT
  (el->'candidate'->>'opportunity_id')::uuid,
  NULLIF(trim(el->'candidate'->>'latest_score_id'),'')::uuid,
  'processing',
  el->>'idempotency_key',
  'layer3-v1',
  NOW()
FROM jsonb_array_elements($1::jsonb) AS t(el)
RETURNING run_id, opportunity_id, idempotency_key`;

const sqlUpdateRun = `UPDATE creative_generation_run AS u SET
  prompt_pack_json = (v.prompt_pack_json)::jsonb,
  status = v.status,
  finished_at = NOW(),
  error_summary = NULLIF(trim(v.error_summary),'')
FROM jsonb_to_recordset($1::jsonb) AS v(
  run_id text,
  prompt_pack_json text,
  status text,
  error_summary text
)
WHERE u.run_id = v.run_id::uuid`;

const sqlInsertOutputs = `INSERT INTO creative_output (
  run_id, kind, variant_index, mime_type, body_text, metadata_json
)
SELECT
  (t.run_id)::uuid,
  t.kind,
  t.variant_index,
  NULLIF(trim(t.mime_type),''),
  NULLIF(trim(t.body_text),''),
  NULLIF(trim(t.metadata_json),'')::jsonb
FROM jsonb_to_recordset($1::jsonb) AS t(
  run_id text,
  kind text,
  variant_index int,
  mime_type text,
  body_text text,
  metadata_json text
)`;

const sqlInsertWorkflowRun = `INSERT INTO workflow_runs
  (run_id, run_started, run_finished, job_name, rows_added, rows_updated,
   status, error_log, sources_summary_json, stage_log_root_id)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS t(run_id text, run_started timestamptz, run_finished timestamptz,
       job_name text, rows_added int, rows_updated int, status text,
       error_log text, sources_summary_json jsonb, stage_log_root_id text)
ON CONFLICT (run_id) DO NOTHING`;

const codePrepare = `const j = $input.first().json || {};
const idempotency_key = 'l3:' + String(j.opportunity_id || '') + ':' + String(j.latest_score_id || 'none');
return [{ json: { candidate: j, idempotency_key } }];`;

const codeBuildPersist = `const j = $input.first().json || {};
const upd = [{
  run_id: String(j.run_id || ''),
  prompt_pack_json: JSON.stringify(j.prompt_pack_obj || {}),
  status: String(j.final_status || 'failed'),
  error_summary: String(j.error_summary || ''),
}];
const outs = (j.output_rows || []).map((r) => ({
  run_id: String(r.run_id || ''),
  kind: String(r.kind || ''),
  variant_index: Number(r.variant_index),
  mime_type: String(r.mime_type || ''),
  body_text: r.body_text == null ? '' : String(r.body_text),
  metadata_json: typeof r.metadata_json === 'string' ? r.metadata_json : JSON.stringify(r.metadata_json || {}),
}));
return [{ json: { persist_update_rows: upd, persist_output_rows: outs } }];`;

const codeBuildItemRunLog = `const j = $('Generate creative pack (Claude + OpenAI + SVG)').first()?.json || {};
const now = new Date().toISOString();
const rid = 'run_wf_layer3_item_' + String(j.run_id || '').slice(0, 8) + '_' + Date.now();
return [{ json: { workflow_runs_rows: [{
  run_id: rid,
  run_started: now,
  run_finished: now,
  job_name: 'wf_layer3_creative_pack',
  rows_added: 1,
  rows_updated: 0,
  status: j.final_status === 'failed' ? 'error' : 'success',
  error_log: j.error_summary || '',
  sources_summary_json: { opportunity_id: j.opportunity_id, creative_run_id: j.run_id },
  stage_log_root_id: null,
}] } }];`;

const generatePackCode = fs.readFileSync(path.join(__dirname, "snippets/layer3_generate_creative_pack.js"), "utf8");

const errorWorkflow = {
  id: "l3000016-l003-4003-8003-000000000001",
  name: "wf_layer3_creative_pack — Error Handler",
  active: false,
  nodes: [
    { parameters: {}, id: "l3-err-1", name: "Error Trigger", type: "n8n-nodes-base.errorTrigger", typeVersion: 1, position: [0, 520] },
    {
      parameters: {
        mode: "runOnceForAllItems",
        language: "javaScript",
        jsCode:
          "const j=$input.first().json||{};const wfName=j.workflow?.name||'unknown';const msg=j.execution?.error?.message||String(j.execution?.error||'Error');const now=new Date().toISOString();return [{json:{rows:[{run_id:'run_'+wfName+'_error_'+Date.now(),run_started:now,run_finished:now,job_name:wfName,rows_added:0,rows_updated:0,status:'error',error_log:msg,sources_summary_json:null,stage_log_root_id:null}]}}];",
      },
      id: "l3-err-2",
      name: "Build error row",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [220, 520],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertWorkflowRun,
        parameters: ["={{ JSON.stringify($json.rows || []) }}"],
      }),
      id: "l3-err-3",
      name: "Insert workflow_runs (error)",
      position: [440, 520],
    },
  ],
  connections: {
    "Error Trigger": { main: [[{ node: "Build error row", type: "main", index: 0 }]] },
    "Build error row": { main: [[{ node: "Insert workflow_runs (error)", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1", timezone: "Europe/London" },
  tags: [{ name: "pod-research" }],
};

const mainWorkflow = {
  id: "l3000016-l003-4003-8003-000000000002",
  name: "wf_layer3_creative_pack",
  active: false,
  nodes: [
    {
      parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 30 8 * * *" }] } },
      id: "l3-101",
      name: "Schedule Trigger (08:30 daily)",
      type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.2,
      position: [0, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlPendingOpportunities,
      }),
      id: "l3-102",
      name: "Read pending approved opportunities",
      position: [220, 300],
    },
    {
      parameters: { options: { reset: false }, batchSize: 1 },
      id: "l3-103",
      name: "Split opportunities (batch 1)",
      type: "n8n-nodes-base.splitInBatches",
      typeVersion: 3,
      position: [440, 300],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codePrepare },
      id: "l3-104",
      name: "Prepare idempotency",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [660, 420],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertRun,
        parameters: ["={{ JSON.stringify([$json]) }}"],
      }),
      id: "l3-105",
      name: "Insert creative_generation_run",
      position: [880, 420],
    },
    {
      parameters: {
        conditions: {
          options: { version: 2, leftValue: "", caseSensitive: true, typeValidation: "strict" },
          conditions: [
            {
              id: "l3if1",
              leftValue: "={{ Boolean($json.run_id) }}",
              rightValue: true,
              operator: { type: "boolean", operation: "equals", singleValue: true },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
      id: "l3-106",
      name: "IF — run inserted?",
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      position: [1100, 420],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: generatePackCode },
      id: "l3-107",
      name: "Generate creative pack (Claude + OpenAI + SVG)",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [1320, 360],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codeBuildPersist },
      id: "l3-108",
      name: "Build persist payload",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [1540, 360],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlUpdateRun,
        parameters: ["={{ JSON.stringify($json.persist_update_rows || []) }}"],
      }),
      id: "l3-109",
      name: "UPDATE creative_generation_run",
      position: [1760, 360],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertOutputs,
        parameters: ["={{ JSON.stringify($json.persist_output_rows || []) }}"],
      }),
      id: "l3-110",
      name: "INSERT creative_output",
      position: [1980, 360],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codeBuildItemRunLog },
      id: "l3-111",
      name: "Build workflow_runs row",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [2200, 360],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertWorkflowRun,
        parameters: ["={{ JSON.stringify($json.workflow_runs_rows || []) }}"],
      }),
      id: "l3-112",
      name: "Insert workflow_runs",
      position: [2420, 360],
    },
    {
      parameters: {},
      id: "l3-113",
      name: "NoOp — batch finished",
      type: "n8n-nodes-base.noOp",
      typeVersion: 1,
      position: [660, 120],
    },
    {
      parameters: {},
      id: "l3-114",
      name: "NoOp — skip (no run_id)",
      type: "n8n-nodes-base.noOp",
      typeVersion: 1,
      position: [1320, 520],
    },
  ],
  connections: {
    "Schedule Trigger (08:30 daily)": { main: [[{ node: "Read pending approved opportunities", type: "main", index: 0 }]] },
    "Read pending approved opportunities": { main: [[{ node: "Split opportunities (batch 1)", type: "main", index: 0 }]] },
    "Split opportunities (batch 1)": {
      main: [
        [{ node: "NoOp — batch finished", type: "main", index: 0 }],
        [{ node: "Prepare idempotency", type: "main", index: 0 }],
      ],
    },
    "Prepare idempotency": { main: [[{ node: "Insert creative_generation_run", type: "main", index: 0 }]] },
    "Insert creative_generation_run": { main: [[{ node: "IF — run inserted?", type: "main", index: 0 }]] },
    "IF — run inserted?": {
      main: [
        [{ node: "Generate creative pack (Claude + OpenAI + SVG)", type: "main", index: 0 }],
        [{ node: "NoOp — skip (no run_id)", type: "main", index: 0 }],
      ],
    },
    "Generate creative pack (Claude + OpenAI + SVG)": {
      main: [[{ node: "Build persist payload", type: "main", index: 0 }]],
    },
    "Build persist payload": { main: [[{ node: "UPDATE creative_generation_run", type: "main", index: 0 }]] },
    "UPDATE creative_generation_run": { main: [[{ node: "INSERT creative_output", type: "main", index: 0 }]] },
    "INSERT creative_output": { main: [[{ node: "Build workflow_runs row", type: "main", index: 0 }]] },
    "Build workflow_runs row": { main: [[{ node: "Insert workflow_runs", type: "main", index: 0 }]] },
    "Insert workflow_runs": { main: [[{ node: "Split opportunities (batch 1)", type: "main", index: 0 }]] },
    "NoOp — skip (no run_id)": { main: [[{ node: "Split opportunities (batch 1)", type: "main", index: 0 }]] },
  },
  settings: {
    executionOrder: "v1",
    timezone: "Europe/London",
    errorWorkflow: "l3000016-l003-4003-8003-000000000001",
  },
  staticData: null,
  meta: { templateCredsSetupCompleted: true },
  pinData: {},
  tags: [{ name: "pod-research" }],
  versionId: "l3000016-l003-4003-8003-0000000000e2",
};

const outPath = path.join(__dirname, "wf_layer3_creative_pack.json");
fs.writeFileSync(outPath, JSON.stringify([errorWorkflow, mainWorkflow], null, 2), "utf8");
console.log("Wrote", outPath);
