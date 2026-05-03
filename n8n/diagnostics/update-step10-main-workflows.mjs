#!/usr/bin/env node
/**
 * Update only the five Step 10 main workflows by exact live ID.
 *
 * This avoids bundled error-handler ambiguity in wf_*.json files. It does not
 * activate/deactivate workflows.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const backupsDir = path.join(repoRoot, "backups", "n8n");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(backupsDir, `step10-main-workflows-update-${stamp}.json`);

const TARGETS = [
  { file: "wf_collect_trends.json", name: "wf_collect_trends", id: "AsORoSwQOE4ABSmb" },
  { file: "wf_normalize_terms.json", name: "wf_normalize_terms", id: "b2000002-0002-4002-8002-000000000002" },
  { file: "wf_enrich_marketplace.json", name: "wf_enrich_marketplace", id: "0jY0awmaJn8RMY8q" },
  { file: "wf_score_and_cluster.json", name: "wf_score_and_cluster", id: "d4000004-0004-4004-8004-000000000002" },
  { file: "wf_publish_queue.json", name: "wf_publish_queue", id: "WcJaRbT1v4GE1Dv9" },
];

const SETTINGS_ALLOWED = new Set([
  "executionOrder",
  "saveExecutionProgress",
  "saveManualExecutions",
  "saveDataErrorExecution",
  "saveDataSuccessExecution",
  "executionTimeout",
  "timezone",
  "availableInMCP",
  "errorWorkflow",
  "callerPolicy",
  "callerIds",
]);

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.join(repoRoot, ".env"));
loadDotEnv(path.join(repoRoot, ".env.local"));

const apiBase = (process.env.N8N_API_URL || process.env.N8N_BASE_URL || "").trim().replace(/\/+$/, "");
const apiKey = (process.env.N8N_API_KEY || "").trim();
if (!apiBase || !apiKey) {
  console.error("missing N8N_API_URL/N8N_BASE_URL or N8N_API_KEY");
  process.exit(2);
}

function sanitize(value) {
  if (value == null) return value;
  if (typeof value === "string") return apiKey ? value.split(apiKey).join("[REDACTED]") : value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = /authorization|credential|password|token|secret|api.?key|headers?/i.test(key) ? "[REDACTED]" : sanitize(val);
    }
    return out;
  }
  return value;
}

async function api(endpoint, opts = {}) {
  const res = await fetch(`${apiBase}${endpoint}`, {
    method: opts.method || "GET",
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-N8N-API-KEY": apiKey,
    },
  });
  const text = await res.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; }
  catch { payload = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function localWorkflow(target) {
  const data = JSON.parse(fs.readFileSync(path.join(repoRoot, "n8n", target.file), "utf8"));
  const wf = (Array.isArray(data) ? data : [data]).find((item) => item.name === target.name);
  if (!wf) throw new Error(`local workflow not found: ${target.name}`);
  return wf;
}

function filteredSettings(localSettings = {}, liveSettings = {}) {
  const merged = { ...liveSettings, ...localSettings };
  const out = {};
  for (const [key, value] of Object.entries(merged)) {
    if (SETTINGS_ALLOWED.has(key)) out[key] = value;
  }
  return out;
}

(async () => {
  const results = [];
  for (const target of TARGETS) {
    const local = localWorkflow(target);
    const before = await api(`/api/v1/workflows/${encodeURIComponent(target.id)}`);
    const payload = {
      name: local.name,
      nodes: local.nodes,
      connections: local.connections,
      settings: filteredSettings(local.settings, before.settings),
    };
    const updated = await api(`/api/v1/workflows/${encodeURIComponent(target.id)}`, {
      method: "PUT",
      body: payload,
    });
    const after = await api(`/api/v1/workflows/${encodeURIComponent(target.id)}`);
    results.push({
      name: target.name,
      id: target.id,
      updateId: updated?.id || target.id,
      activeBefore: before.active,
      activeAfter: after.active,
      availableInMCP: after.settings?.availableInMCP,
      errorWorkflow: after.settings?.errorWorkflow || "",
      nodeCount: after.nodes?.length || 0,
    });
  }
  const artifact = { updatedAt: new Date().toISOString(), results };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(sanitize(artifact), null, 2)}\n`);
  console.log(JSON.stringify({ artifact: outPath, results }, null, 2));
})().catch((e) => {
  console.error(JSON.stringify(sanitize({ error: e.message, status: e.status, payload: e.payload }), null, 2));
  process.exit(1);
});
