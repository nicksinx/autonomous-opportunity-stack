import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pgNode } from "./build_pg_node.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// SQL bulk-write helpers — one Postgres executeQuery per loop instead of an
// inner Sheets append per iteration.
// ---------------------------------------------------------------------------

const sqlUpsertRangeBriefs = `INSERT INTO range_briefs
  (brief_id, cluster_id, run_date, range_title, hero_angle, best_products,
   design_directions, phrase_concepts, audiences, ip_risk, status)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS t(brief_id text, cluster_id text, run_date date, range_title text,
       hero_angle text, best_products text, design_directions text,
       phrase_concepts jsonb, audiences text, ip_risk text, status text)
ON CONFLICT (brief_id) DO UPDATE SET
  range_title       = EXCLUDED.range_title,
  hero_angle        = EXCLUDED.hero_angle,
  best_products     = EXCLUDED.best_products,
  design_directions = EXCLUDED.design_directions,
  phrase_concepts   = EXCLUDED.phrase_concepts,
  audiences         = EXCLUDED.audiences,
  ip_risk           = EXCLUDED.ip_risk,
  status            = EXCLUDED.status`;

const sqlInsertPhraseBank = `INSERT INTO phrase_bank
  (phrase_id, brief_id, bucket, phrase, target_products, style_hint, created_at)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS t(phrase_id text, brief_id text, bucket text, phrase text,
       target_products text, style_hint text, created_at timestamptz)
ON CONFLICT (phrase_id) DO NOTHING`;

const sqlInsertWorkflowRun = `INSERT INTO workflow_runs
  (run_id, run_started, run_finished, job_name, rows_added, rows_updated,
   status, error_log, sources_summary_json, stage_log_root_id)
SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS t(run_id text, run_started timestamptz, run_finished timestamptz,
       job_name text, rows_added int, rows_updated int, status text,
       error_log text, sources_summary_json jsonb, stage_log_root_id text)
ON CONFLICT (run_id) DO NOTHING`;

const sqlUpdateBriefStatus = `UPDATE range_briefs
   SET status = $2
 WHERE brief_id = $1
RETURNING brief_id, cluster_id, run_date, range_title, hero_angle,
          best_products, design_directions, phrase_concepts,
          audiences, ip_risk, status`;

/** Legacy theme_clusters plus Layer 2 approved opportunities (same row shape for downstream nodes). */
const sqlReadPublishableClusters = `SELECT cluster_id, run_date, theme_name, theme_slug, theme_summary, audience, seasonality, review_notes, status
FROM theme_clusters
WHERE LOWER(status) IN ('approved','draft')
  AND (run_date = CURRENT_DATE OR LOWER(review_notes) = 'high')
UNION ALL
SELECT
  tc.cluster_id::text AS cluster_id,
  CURRENT_DATE AS run_date,
  COALESCE(tc.primary_topic, va.title) AS theme_name,
  COALESCE(NULLIF(tc.cluster_key, ''), regexp_replace(lower(COALESCE(tc.primary_topic, va.title)), '[^a-z0-9]+', '-', 'g')) AS theme_slug,
  COALESCE(NULLIF(trim(oc.commercial_hypothesis), ''), tc.aggregate_metrics::text, '') AS theme_summary,
  COALESCE(oc.target_audience->>'primary', '') AS audience,
  COALESCE(oc.market_context->>'seasonality_flag', 'unknown') AS seasonality,
  'high' AS review_notes,
  'approved' AS status
FROM v_approved_opportunities va
JOIN opportunity_candidate oc ON oc.opportunity_id = va.opportunity_id
JOIN trend_cluster_v2 tc ON tc.cluster_id = oc.cluster_id
WHERE oc.cluster_id IS NOT NULL
UNION ALL
SELECT NULL::text, NULL::date, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text
WHERE NOT EXISTS (
    SELECT 1 FROM theme_clusters tc1
    WHERE LOWER(tc1.status) IN ('approved','draft')
      AND (tc1.run_date = CURRENT_DATE OR LOWER(tc1.review_notes) = 'high')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM v_approved_opportunities va2
    JOIN opportunity_candidate oc2 ON oc2.opportunity_id = va2.opportunity_id
    JOIN trend_cluster_v2 tc2 ON tc2.cluster_id = oc2.cluster_id
    WHERE oc2.cluster_id IS NOT NULL
  )`;

// ---------------------------------------------------------------------------
// Code-node bodies
// ---------------------------------------------------------------------------

const codeFilterClusters = `const run_id = 'run_wf_generate_range_briefs_' + Date.now();
const run_started = new Date().toISOString();
const rows = $input.all();
const today = new Date().toISOString().slice(0, 10);
const out = [];
for (const it of rows) {
  const j = it.json || {};
  const pr = String(j.review_notes || j.priority || '').toLowerCase();
  const rd = String(j.run_date || '');
  const rdDay = rd.includes('T') ? rd.slice(0, 10) : rd.slice(0, 10);
  if (pr === 'high' || rdDay === today) out.push({ json: { ...j, run_id, run_started } });
}
if (!out.length) return [{ json: { __noClusters: true, run_id, run_started } }];
return out;`;

const codeGenerateRangeBrief = `const row = $input.first().json || {};
const cluster_id = String(row.cluster_id || '').trim();
if (!cluster_id) return [{ json: { error: true, message: 'Missing cluster_id' } }];

function getAnthropicKey() {
  try { if (typeof $env !== 'undefined' && $env.ANTHROPIC_API_KEY) return String($env.ANTHROPIC_API_KEY); } catch (_e) {}
  if (typeof process !== 'undefined' && process.env?.ANTHROPIC_API_KEY) return String(process.env.ANTHROPIC_API_KEY);
  return '';
}
function extractJsonText(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const start = s.indexOf('{'); const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) return s.slice(start, end + 1).trim();
  return s;
}

const PROMPT_TEMPLATE = \`You are a print-on-demand product strategist.

Task: Turn the supplied theme cluster into a commercially useful product range brief for a POD business.

Business goal: Generate ideas suitable for T-shirts, mugs, stickers, tote bags, and sweatshirts.

Instructions:
- Produce a range, not one design.
- Focus on commercially viable concepts.
- Avoid copyrighted characters, brand names, slogans, celebrity references, sports teams, breaking-news references, and trademark-heavy language.
- Favor evergreen or repeatable seasonal angles.
- Include both text-led and graphic-led directions.

Return exactly this JSON. No markdown. No preamble:
{
  "range_title":"","hero_angle":"","why_now":"","audience_segments":[],"best_products":[],
  "design_directions":[{"name":"","style_notes":"","visual_motifs":[],"color_feel":"","best_for":[]}],
  "phrase_concepts":[{"text":"","tone":"","best_products":[],"notes":""}],
  "sub_niches":[],"seasonality_window":"","ip_risk_level":"","reasons_to_skip":[],"next_action":""
}

Cluster input:
{{CLUSTER_SUMMARY}}\`;

const theme_name = String(row.theme_name ?? row.theme ?? '').trim();
const cluster_summary = String(row.theme_summary ?? row.cluster_summary ?? '').trim();
const audience = String(row.audience ?? '').trim();
const seasonality = String(row.seasonality ?? '').trim();
const CLUSTER_SUMMARY = ['Theme: '+theme_name,'Summary: '+cluster_summary,'Audience: '+audience,'Seasonality: '+seasonality].join('\\n');
const userContent = PROMPT_TEMPLATE.replace('{{CLUSTER_SUMMARY}}', CLUSTER_SUMMARY);
const apiKey = getAnthropicKey();
if (!apiKey) return [{ json: { error: true, message: 'ANTHROPIC_API_KEY not set', cluster_id } }];

let body;
try {
  body = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: { model: 'claude-sonnet-4-20250514', max_tokens: 4096, system: 'You are a POD strategist. Output only valid JSON.', messages: [{ role: 'user', content: userContent }] },
    json: true,
  });
} catch (err) {
  return [{ json: { error: true, message: String(err?.message || err), cluster_id } }];
}
let brief;
try {
  const tb = (body?.content || []).find((b) => b.type === 'text' && b.text);
  if (!tb?.text) throw new Error('No text in response');
  brief = JSON.parse(extractJsonText(tb.text));
} catch (_e) {
  return [{ json: { error: true, message: 'JSON parse failed', cluster_id } }];
}

function safeJoin(arr, sep) { return Array.isArray(arr) ? arr.map(String).join(sep) : ''; }
const ipLevel = String(brief.ip_risk_level || '').toLowerCase();
const isHighIp = ['high','very_high'].includes(ipLevel);
const status = isHighIp ? 'manual_review' : 'draft';
const run_date = new Date().toISOString().slice(0, 10);
const brief_id = 'brf_' + cluster_id + '_' + run_date.replace(/-/g, '');

return [{ json: {
  brief_id,
  cluster_id,
  run_date,
  range_title: String(brief.range_title || ''),
  hero_angle: String(brief.hero_angle || ''),
  best_products: safeJoin(brief.best_products, '|'),
  design_directions: JSON.stringify(brief.design_directions ?? []),
  phrase_concepts: brief.phrase_concepts ?? [],
  audiences: safeJoin(brief.audience_segments, '|'),
  ip_risk: brief.ip_risk_level || 'unknown',
  status,
  __isHighIp: isHighIp,
}}];`;

const codeCollectBriefRows = `const items = $('Generate range brief').all().map((i) => i.json || {});
const rows = items
  .filter((i) => i.brief_id && !i.error)
  .map((i) => ({
    brief_id: i.brief_id,
    cluster_id: i.cluster_id,
    run_date: i.run_date,
    range_title: i.range_title,
    hero_angle: i.hero_angle,
    best_products: i.best_products,
    design_directions: i.design_directions,
    phrase_concepts: i.phrase_concepts,
    audiences: i.audiences,
    ip_risk: i.ip_risk,
    status: i.status,
  }));
return [{ json: { brief_rows: rows } }];`;

const codeBuildRunLog = `const fj = $('Filter clusters (high or today)').first().json || {};
const briefRows = ($('Collect brief rows').first()?.json?.brief_rows) || [];
const run_finished = new Date().toISOString();
return [{ json: { workflow_runs_rows: [{
  run_id: fj.run_id || ('run_wf_generate_range_briefs_' + Date.now()),
  run_started: fj.run_started || run_finished,
  run_finished,
  job_name: 'wf_generate_range_briefs',
  rows_added: briefRows.length,
  rows_updated: 0,
  status: 'success',
  error_log: '',
  sources_summary_json: { briefs: briefRows.length },
  stage_log_root_id: null,
}] } }];`;

const codeNoClustersLog = `const fj = $('Filter clusters (high or today)').first().json || {};
const now = new Date().toISOString();
return [{ json: { workflow_runs_rows: [{
  run_id: fj.run_id || ('run_wf_generate_range_briefs_' + Date.now()),
  run_started: fj.run_started || now,
  run_finished: now,
  job_name: 'wf_generate_range_briefs',
  rows_added: 0,
  rows_updated: 0,
  status: 'no_clusters',
  error_log: '',
  sources_summary_json: { briefs: 0 },
  stage_log_root_id: null,
}] } }];`;

const codeExtractBriefId = `const b = $input.first().json?.body || $input.first().json || {};
const brief_id = String(b.brief_id || '').trim();
if (!brief_id) return [{ json: { error: true, message: 'Missing brief_id in body' } }];
return [{ json: { brief_id } }];`;

const codePhraseExpansion = `const row = $input.first().json || {};
const briefId = String(row.brief_id || '').trim();
if (!briefId) return [{ json: { error: true, message: 'Brief not found' } }];

function getAnthropicKey() {
  try { if (typeof $env !== 'undefined' && $env.ANTHROPIC_API_KEY) return String($env.ANTHROPIC_API_KEY); } catch (_e) {}
  if (typeof process !== 'undefined' && process.env?.ANTHROPIC_API_KEY) return String(process.env.ANTHROPIC_API_KEY);
  return '';
}
function flattenPhraseConceptsField(raw) {
  if (raw == null) return '';
  if (Array.isArray(raw)) return raw.map((p) => String(p?.text ?? p?.phrase ?? '').trim()).filter(Boolean).join('|');
  return String(raw).trim();
}
function extractJsonArray(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const start = s.indexOf('['); const end = s.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('No JSON array');
  return JSON.parse(s.slice(start, end + 1));
}

const PROMPT_TEMPLATE = \`You are generating print-on-demand phrase ideas from an approved product theme.
Generate exactly 30 short phrase concepts (max 7 words each). No copyrighted phrases.
Split into 3 buckets of 10: funny, heartfelt, minimalist.
Output strict JSON: [{"bucket":"funny|heartfelt|minimalist","phrase":"","target_products":[],"style_hint":""}]

Approved theme:
{{APPROVED_RANGE_BRIEF}}\`;

const title = String(row.range_title || '').trim();
const hero = String(row.hero_angle || '').trim();
const concepts = flattenPhraseConceptsField(row.phrase_concepts);
const userContent = PROMPT_TEMPLATE.replace('{{APPROVED_RANGE_BRIEF}}', [title, hero, concepts].join('|'));
const apiKey = getAnthropicKey();
if (!apiKey) return [{ json: { error: true, message: 'ANTHROPIC_API_KEY not set' } }];

const body = await this.helpers.httpRequest({
  method: 'POST',
  url: 'https://api.anthropic.com/v1/messages',
  headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
  body: { model: 'claude-sonnet-4-20250514', max_tokens: 4096, system: 'Reply with JSON only.', messages: [{ role: 'user', content: userContent }] },
  json: true,
});
const tb = (body?.content || []).find((b) => b.type === 'text' && b.text);
const phrases = extractJsonArray(tb?.text);
if (!Array.isArray(phrases) || phrases.length !== 30) throw new Error('Expected 30 phrases');

const created_at = new Date().toISOString();
const phrase_rows = phrases.map((p, i) => ({
  phrase_id: 'phr_' + briefId + '_' + (i + 1),
  brief_id: briefId,
  bucket: String(p?.bucket || '').toLowerCase(),
  phrase: String(p?.phrase || '').trim(),
  target_products: Array.isArray(p?.target_products) ? p.target_products.join('|') : '',
  style_hint: String(p?.style_hint || ''),
  created_at,
}));
return [{ json: { brief_id: briefId, phrase_rows } }];`;

const codeBuildPhraseResponse = `const phraseRows = ($('Phrase expansion (Claude)').first()?.json?.phrase_rows) || [];
return [{ json: { status: 'ok', phrases_added: phraseRows.length, __statusCode: 200 } }];`;

const codeBuildBriefNotFound = `return [{ json: { status: 'error', message: 'Brief not found', phrases_added: 0, __statusCode: 404 } }];`;

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

const errorWorkflow = {
  id: "f7000007-f007-4007-8007-000000000001",
  name: "wf_generate_range_briefs — Error Handler",
  active: false,
  nodes: [
    { parameters: {}, id: "f7000007-f007-4007-8007-000000000011", name: "Error Trigger", type: "n8n-nodes-base.errorTrigger", typeVersion: 1, position: [0, 700] },
    {
      parameters: {
        mode: "runOnceForAllItems", language: "javaScript",
        jsCode: "const j=$input.first().json||{};const wfName=j.workflow?.name||'unknown';const msg=j.execution?.error?.message||String(j.execution?.error||'Error');const now=new Date().toISOString();return [{json:{rows:[{run_id:'run_'+wfName+'_error_'+Date.now(),run_started:now,run_finished:now,job_name:wfName,rows_added:0,rows_updated:0,status:'error',error_log:msg,sources_summary_json:null,stage_log_root_id:null}]}}];",
      },
      id: "f7000007-f007-4007-8007-000000000012", name: "Build error row", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 700],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertWorkflowRun,
        parameters: ["={{ JSON.stringify($json.rows || []) }}"],
      }),
      id: "f7000007-f007-4007-8007-000000000013", name: "Insert workflow_runs (error)", position: [440, 700],
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
  id: "f7000007-f007-4007-8007-000000000002",
  name: "wf_generate_range_briefs",
  active: false,
  nodes: [
    {
      parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 30 7 * * 1" }] } },
      id: "f7-101", name: "Schedule Trigger (Mon 07:30 Europe/London)",
      type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlReadPublishableClusters,
      }),
      id: "f7-102", name: "Read theme_clusters (publishable today)", position: [220, 300],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codeFilterClusters },
      id: "f7-103", name: "Filter clusters (high or today)",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [440, 300],
    },
    {
      parameters: {
        conditions: {
          options: { version: 2, leftValue: "", caseSensitive: true, typeValidation: "strict" },
          conditions: [{ id: "c1", leftValue: "={{ Boolean($json.__noClusters) }}", rightValue: true, operator: { type: "boolean", operation: "equals", singleValue: true } }],
          combinator: "and",
        },
        options: {},
      },
      id: "f7-104", name: "IF — Has clusters?",
      type: "n8n-nodes-base.if", typeVersion: 2.2, position: [660, 300],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codeNoClustersLog },
      id: "f7-105", name: "Build no-clusters run log",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [880, 120],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertWorkflowRun,
        parameters: ["={{ JSON.stringify($json.workflow_runs_rows || []) }}"],
      }),
      id: "f7-106", name: "Insert workflow_runs (no clusters)", position: [1100, 120],
    },
    {
      parameters: { options: { reset: false }, batchSize: 1 },
      id: "f7-107", name: "Split clusters (batch 1)",
      type: "n8n-nodes-base.splitInBatches", typeVersion: 3, position: [880, 420],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codeGenerateRangeBrief },
      id: "f7-108", name: "Generate range brief",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [1100, 420],
    },
    {
      parameters: {
        conditions: {
          options: { version: 2, leftValue: "", caseSensitive: true, typeValidation: "strict" },
          conditions: [
            { id: "s1", leftValue: "={{ Boolean(String($env.SLACK_WEBHOOK_URL || '').trim()) && $json.__isHighIp !== true && !$json.error }}", rightValue: true, operator: { type: "boolean", operation: "equals", singleValue: true } },
          ],
          combinator: "and",
        },
        options: {},
      },
      id: "f7-109", name: "IF — Slack notify?",
      type: "n8n-nodes-base.if", typeVersion: 2.2, position: [1320, 420],
    },
    {
      parameters: {
        method: "POST",
        url: "={{ $env.SLACK_WEBHOOK_URL }}",
        sendBody: true,
        specifyBody: "json",
        jsonBody: '={{ JSON.stringify({ text: "New range brief: " + $json.range_title + " | Cluster: " + $json.cluster_id }) }}',
        options: {},
      },
      id: "f7-110", name: "Slack notification (POST)",
      type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [1540, 360],
      continueOnFail: true,
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codeCollectBriefRows },
      id: "f7-111", name: "Collect brief rows",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [1100, 0],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlUpsertRangeBriefs,
        parameters: ["={{ JSON.stringify($json.brief_rows || []) }}"],
      }),
      id: "f7-112", name: "Bulk upsert range_briefs", position: [1320, 0],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codeBuildRunLog },
      id: "f7-113", name: "Build run log",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [1540, 0],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertWorkflowRun,
        parameters: ["={{ JSON.stringify($json.workflow_runs_rows || []) }}"],
      }),
      id: "f7-114", name: "Insert workflow_runs (success)", position: [1760, 0],
    },
  ],
  connections: {
    "Schedule Trigger (Mon 07:30 Europe/London)": { main: [[{ node: "Read theme_clusters (publishable today)", type: "main", index: 0 }]] },
    "Read theme_clusters (publishable today)": { main: [[{ node: "Filter clusters (high or today)", type: "main", index: 0 }]] },
    "Filter clusters (high or today)": { main: [[{ node: "IF — Has clusters?", type: "main", index: 0 }]] },
    "IF — Has clusters?": {
      main: [
        [{ node: "Build no-clusters run log", type: "main", index: 0 }],
        [{ node: "Split clusters (batch 1)", type: "main", index: 0 }],
      ],
    },
    "Build no-clusters run log": { main: [[{ node: "Insert workflow_runs (no clusters)", type: "main", index: 0 }]] },
    "Split clusters (batch 1)": {
      main: [
        [{ node: "Collect brief rows", type: "main", index: 0 }],
        [{ node: "Generate range brief", type: "main", index: 0 }],
      ],
    },
    "Generate range brief": { main: [[{ node: "IF — Slack notify?", type: "main", index: 0 }]] },
    "IF — Slack notify?": {
      main: [
        [{ node: "Slack notification (POST)", type: "main", index: 0 }],
        [{ node: "Split clusters (batch 1)", type: "main", index: 0 }],
      ],
    },
    "Slack notification (POST)": { main: [[{ node: "Split clusters (batch 1)", type: "main", index: 0 }]] },
    "Collect brief rows": { main: [[{ node: "Bulk upsert range_briefs", type: "main", index: 0 }]] },
    "Bulk upsert range_briefs": { main: [[{ node: "Build run log", type: "main", index: 0 }]] },
    "Build run log": { main: [[{ node: "Insert workflow_runs (success)", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1", timezone: "Europe/London", errorWorkflow: "f7000007-f007-4007-8007-000000000001" },
  staticData: null,
  meta: { templateCredsSetupCompleted: true },
  pinData: {},
  tags: [{ name: "pod-research" }],
  versionId: "f7000007-f007-4007-8007-0000000000e2",
};

const phraseWorkflow = {
  id: "p8000008-p008-4008-8008-000000000002",
  name: "wf_phrase_expansion",
  active: false,
  nodes: [
    {
      parameters: { path: "approve-brief", httpMethod: "POST", responseMode: "responseNode", options: {} },
      id: "p8-201", name: "Webhook approve-brief",
      type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 300],
      webhookId: "approve-brief-pod",
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codeExtractBriefId },
      id: "p8-202", name: "Extract brief_id",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 300],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlUpdateBriefStatus,
        parameters: [
          "={{ $json.brief_id }}",
          "approved",
        ],
      }),
      id: "p8-203", name: "Update range_briefs SET status=approved",
      position: [440, 300],
    },
    {
      parameters: {
        conditions: {
          options: { version: 2, leftValue: "", caseSensitive: true, typeValidation: "strict" },
          conditions: [
            { id: "bf1", leftValue: "={{ Boolean($json && $json.brief_id) }}", rightValue: true, operator: { type: "boolean", operation: "equals", singleValue: true } },
          ],
          combinator: "and",
        },
        options: {},
      },
      id: "p8-204", name: "IF — Brief found?",
      type: "n8n-nodes-base.if", typeVersion: 2.2, position: [660, 300],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codePhraseExpansion },
      id: "p8-205", name: "Phrase expansion (Claude)",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [880, 240],
    },
    {
      ...pgNode({
        operation: "executeQuery",
        query: sqlInsertPhraseBank,
        parameters: ["={{ JSON.stringify($json.phrase_rows || []) }}"],
      }),
      id: "p8-206", name: "Bulk insert phrase_bank",
      position: [1100, 240],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codeBuildPhraseResponse },
      id: "p8-207", name: "Build success response",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [1320, 240],
    },
    {
      parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: codeBuildBriefNotFound },
      id: "p8-208", name: "Build not-found response",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [880, 380],
    },
    {
      parameters: {
        options: {},
        respondWith: "json",
        responseBody: "={{ { status: $json.status, message: $json.message, phrases_added: $json.phrases_added } }}",
        responseCode: "={{ Number($json.__statusCode || 200) }}",
      },
      id: "p8-209", name: "Respond to Webhook",
      type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [1540, 300],
    },
  ],
  connections: {
    "Webhook approve-brief": { main: [[{ node: "Extract brief_id", type: "main", index: 0 }]] },
    "Extract brief_id": { main: [[{ node: "Update range_briefs SET status=approved", type: "main", index: 0 }]] },
    "Update range_briefs SET status=approved": { main: [[{ node: "IF — Brief found?", type: "main", index: 0 }]] },
    "IF — Brief found?": {
      main: [
        [{ node: "Phrase expansion (Claude)", type: "main", index: 0 }],
        [{ node: "Build not-found response", type: "main", index: 0 }],
      ],
    },
    "Phrase expansion (Claude)": { main: [[{ node: "Bulk insert phrase_bank", type: "main", index: 0 }]] },
    "Bulk insert phrase_bank": { main: [[{ node: "Build success response", type: "main", index: 0 }]] },
    "Build success response": { main: [[{ node: "Respond to Webhook", type: "main", index: 0 }]] },
    "Build not-found response": { main: [[{ node: "Respond to Webhook", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1", timezone: "Europe/London" },
  staticData: null,
  meta: { templateCredsSetupCompleted: true },
  pinData: {},
  tags: [{ name: "pod-research" }],
  versionId: "p8000008-p008-4008-8008-0000000000e2",
};

const outPath = path.join(__dirname, "wf_generate_range_briefs_and_phrase_expansion.json");
fs.writeFileSync(
  outPath,
  JSON.stringify([errorWorkflow, mainWorkflow, phraseWorkflow], null, 2),
  "utf8",
);
console.log("Wrote", outPath);
