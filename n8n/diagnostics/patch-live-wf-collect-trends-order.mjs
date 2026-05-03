#!/usr/bin/env node
/**
 * Patch live wf_collect_trends connection ordering so workflow_runs is written
 * before FK-dependent audit tables. Does not activate/deactivate workflows.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const backupsDir = path.join(repoRoot, "backups", "n8n");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(backupsDir, `wf_collect_trends-live-order-patch-${stamp}.json`);

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
  console.error("missing N8N_API_URL / N8N_API_KEY");
  process.exit(2);
}

function sanitize(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    let out = value;
    if (apiKey) out = out.split(apiKey).join("[REDACTED]");
    return out;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/authorization|credential|password|token|secret|api.?key|headers?/i.test(key)) out[key] = "[REDACTED]";
      else out[key] = sanitize(val);
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
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function patchedConnections(connections) {
  return {
    ...connections,
    "Append raw_signals (batch)": {
      main: [[{ node: "Build run log", type: "main", index: 0 }]],
    },
    "Append workflow_runs (success)": {
      main: [[
        { node: "Build source_health rows", type: "main", index: 0 },
        { node: "Build stage_run_logs", type: "main", index: 0 },
        { node: "Build raw_signals mirror rows", type: "main", index: 0 },
      ]],
    },
  };
}

function updatePayload(wf) {
  const settings = wf.settings || {};
  const keptSettings = {};
  for (const key of [
    "executionOrder",
    "availableInMCP",
    "timezone",
    "errorWorkflow",
    "saveExecutionProgress",
    "saveManualExecutions",
    "saveDataErrorExecution",
    "saveDataSuccessExecution",
    "executionTimeout",
    "callerPolicy",
    "callerIds",
  ]) {
    if (settings[key] !== undefined) keptSettings[key] = settings[key];
  }
  return {
    name: wf.name,
    nodes: wf.nodes.map((node) => {
      if (node.name === "Append raw_signals (batch)") {
        return {
          ...node,
          parameters: {
            ...node.parameters,
            operation: "upsert",
            columns: {
              ...node.parameters.columns,
              matchingColumns: ["signal_id"],
            },
          },
        };
      }
      if (node.name === "Append workflow_runs (success)") {
        return {
          ...node,
          parameters: {
            ...node.parameters,
            operation: "upsert",
            columns: {
              ...node.parameters.columns,
              matchingColumns: ["run_id"],
            },
          },
        };
      }
      return {
        ...node,
      };
    }),
    connections: patchedConnections(wf.connections || {}),
    settings: keptSettings,
  };
}

(async () => {
  const before = await api("/api/v1/workflows/AsORoSwQOE4ABSmb");
  const payload = updatePayload(before);
  const result = {
    patchedAt: new Date().toISOString(),
    workflowId: before.id,
    name: before.name,
    activeBefore: before.active,
    settingsBefore: before.settings,
    beforeConnections: {
      appendRawSignals: before.connections?.["Append raw_signals (batch)"],
      appendWorkflowRuns: before.connections?.["Append workflow_runs (success)"] || null,
    },
    beforeRawSignalsNode: before.nodes?.find((node) => node.name === "Append raw_signals (batch)")?.parameters,
    beforeWorkflowRunsNode: before.nodes?.find((node) => node.name === "Append workflow_runs (success)")?.parameters,
    update: null,
    after: null,
  };
  let updated;
  try {
    updated = await api(`/api/v1/workflows/${encodeURIComponent(before.id)}`, {
      method: "PUT",
      body: payload,
    });
  } catch (e) {
    result.update = { ok: false, status: e.status, payload: e.payload };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(sanitize(result), null, 2)}\n`);
    console.log(JSON.stringify({ ok: false, artifact: outPath, status: e.status, payload: sanitize(e.payload) }, null, 2));
    process.exit(1);
  }
  const after = await api(`/api/v1/workflows/${encodeURIComponent(before.id)}`);
  result.update = { ok: true, updatedId: updated?.id || before.id };
  result.after = {
    active: after.active,
    settings: after.settings,
    appendRawSignals: after.connections?.["Append raw_signals (batch)"],
    appendWorkflowRuns: after.connections?.["Append workflow_runs (success)"] || null,
    rawSignalsNode: after.nodes?.find((node) => node.name === "Append raw_signals (batch)")?.parameters,
    workflowRunsNode: after.nodes?.find((node) => node.name === "Append workflow_runs (success)")?.parameters,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(sanitize(result), null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    artifact: outPath,
    activeBefore: before.active,
    activeAfter: after.active,
    availableInMCP: after.settings?.availableInMCP,
    errorWorkflow: after.settings?.errorWorkflow,
    appendRawSignals: result.after.appendRawSignals,
    appendWorkflowRuns: result.after.appendWorkflowRuns,
    rawSignalsOperation: result.after.rawSignalsNode?.operation,
    rawSignalsMatchingColumns: result.after.rawSignalsNode?.columns?.matchingColumns,
    workflowRunsOperation: result.after.workflowRunsNode?.operation,
    workflowRunsMatchingColumns: result.after.workflowRunsNode?.columns?.matchingColumns,
  }, null, 2));
})();
