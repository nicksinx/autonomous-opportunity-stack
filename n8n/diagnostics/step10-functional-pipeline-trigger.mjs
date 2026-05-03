#!/usr/bin/env node
/**
 * Step 10: Functional pipeline trigger.
 *
 * Read-only with respect to workflow definitions: verifies target workflows,
 * triggers the chain sequentially, waits for terminal execution status, and
 * writes evidence artifacts under backups/n8n/.
 */

import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const backupsDir = path.join(repoRoot, "backups", "n8n");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const attemptPath = path.join(backupsDir, `step10-attempt-${stamp}.json`);
const successPath = path.join(backupsDir, `step10-execution-chain-${stamp}.json`);
const failurePath = path.join(backupsDir, `step10-execution-failure-${stamp}.json`);

const TARGETS = [
  { name: "wf_collect_trends", expectedId: "AsORoSwQOE4ABSmb" },
  { name: "wf_normalize_terms", expectedId: "b2000002-0002-4002-8002-000000000002" },
  { name: "wf_enrich_marketplace", expectedId: "0jY0awmaJn8RMY8q" },
  { name: "wf_score_and_cluster", expectedId: "d4000004-0004-4004-8004-000000000002" },
  { name: "wf_publish_queue", expectedId: "WcJaRbT1v4GE1Dv9" },
];

const HTTP_TIMEOUT_MS = Number(process.env.N8N_STEP10_HTTP_TIMEOUT_MS || 30000);
const POLL_INTERVAL_MS = Number(process.env.N8N_STEP10_POLL_INTERVAL_MS || 5000);
const PER_WORKFLOW_TIMEOUT_MS = Number(process.env.N8N_STEP10_TIMEOUT_MS || 15 * 60 * 1000);
const TERMINAL_STATUSES = new Set(["success", "error", "canceled", "crashed", "failed"]);
const SUCCESS_STATUSES = new Set(["success"]);

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
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.join(repoRoot, ".env"));
loadDotEnv(path.join(repoRoot, ".env.local"));

const apiBase = (process.env.N8N_API_URL || process.env.N8N_BASE_URL || "").trim().replace(/\/+$/, "");
const apiKey = (process.env.N8N_API_KEY || "").trim();
const mcpEndpoint = (process.env.N8N_MCP_URL || "").trim().replace(/\/+$/, "");
const mcpToken = (process.env.N8N_MCP_TOKEN || "").trim();

const attempt = {
  generatedAt: new Date().toISOString(),
  status: "RUNNING",
  chosenExecutionPath: null,
  workflowMapping: [],
  mismatches: [],
  partialExecutionsLaunched: [],
  perWorkflow: [],
  notes: [],
};

function safeString(value) {
  let out = typeof value === "string" ? value : JSON.stringify(value);
  if (!out) return "";
  for (const secret of [apiKey, mcpToken]) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  out = out.replace(/(X-N8N-API-KEY["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[REDACTED]");
  out = out.replace(/(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[^"',\s}]+/gi, "$1[REDACTED]");
  out = out.replace(/(password|token|api[_-]?key|secret)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1$2[REDACTED]");
  return out;
}

function sanitize(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    const s = safeString(value);
    return s.length > 5000 ? `${s.slice(0, 5000)}...[truncated]` : s;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/password|token|secret|api.?key|authorization/i.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = sanitize(val);
      }
    }
    return out;
  }
  return value;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(sanitize(data), null, 2)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpJson(endpoint, opts = {}) {
  if (!apiBase) throw new Error("N8N_API_URL / N8N_BASE_URL is missing");
  if (!apiKey) throw new Error("N8N_API_KEY is missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  const url = `${apiBase}${endpoint}`;
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      body: opts.body,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-N8N-API-KEY": apiKey,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.payload = payload;
      err.endpoint = endpoint;
      throw err;
    }
    return { status: res.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function listApiWorkflows() {
  const all = [];
  let cursor = "";
  for (let page = 0; page < 50; page += 1) {
    const q = new URLSearchParams({ limit: "250" });
    if (cursor) q.set("cursor", cursor);
    const { payload } = await httpJson(`/api/v1/workflows?${q}`);
    const items = Array.isArray(payload?.data) ? payload.data : [];
    all.push(...items);
    cursor = String(payload?.nextCursor || "");
    if (!cursor) break;
  }
  return all;
}

async function fetchApiWorkflow(id) {
  const { payload } = await httpJson(`/api/v1/workflows/${encodeURIComponent(id)}`);
  return payload;
}

function resolveExecutionId(payload) {
  return (
    payload?.executionId ||
    payload?.id ||
    payload?.data?.executionId ||
    payload?.data?.id ||
    payload?.execution?.id ||
    null
  );
}

function executionStatus(payload) {
  const status = payload?.status || payload?.execution?.status;
  if (status) return String(status);
  if (payload?.finished === true) return "success";
  if (payload?.stoppedAt || payload?.execution?.stoppedAt) return "finished";
  return "unknown";
}

function executionStartedAt(payload) {
  return payload?.startedAt || payload?.execution?.startedAt || "";
}

function executionStoppedAt(payload) {
  return payload?.stoppedAt || payload?.finishedAt || payload?.execution?.stoppedAt || "";
}

async function executeViaPublicApi(workflowId) {
  const endpoint = `/api/v1/workflows/${encodeURIComponent(workflowId)}/execute`;
  const { payload } = await httpJson(endpoint, { method: "POST", body: "{}" });
  return { endpoint, payload, executionId: resolveExecutionId(payload) };
}

async function pollViaPublicApi(executionId, deadlineMs) {
  const endpoint = `/api/v1/executions/${encodeURIComponent(executionId)}?includeData=false`;
  let lastPayload = null;
  while (Date.now() < deadlineMs) {
    const { payload } = await httpJson(endpoint);
    lastPayload = payload;
    const status = executionStatus(payload);
    const stoppedAt = executionStoppedAt(payload);
    if (TERMINAL_STATUSES.has(status) || (status === "finished" && stoppedAt)) {
      return { status: status === "finished" ? "success" : status, payload };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { status: "timeout", payload: lastPayload };
}

function parseMcpEnvelope(text) {
  const lines = String(text || "").split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice("data: ".length).trim();
    if (!data) continue;
    try {
      return JSON.parse(data);
    } catch {
      return { raw: data };
    }
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

async function mcpCall(toolName, args = {}) {
  if (!mcpEndpoint) throw new Error("N8N_MCP_URL is missing");
  if (!mcpToken) throw new Error("N8N_MCP_TOKEN is missing");

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  const url = new URL(mcpEndpoint);
  const requestImpl = url.protocol === "http:" ? http.request : https.request;
  const response = await new Promise((resolve, reject) => {
    const req = requestImpl(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        timeout: HTTP_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${mcpToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("MCP request timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  const envelope = parseMcpEnvelope(response.text);
  if (response.statusCode >= 400) {
    const err = new Error(`MCP HTTP ${response.statusCode}`);
    err.payload = envelope;
    throw err;
  }
  if (envelope?.error) {
    const err = new Error(envelope.error.message || "MCP error");
    err.payload = envelope;
    throw err;
  }
  const result = envelope?.result?.structuredContent ?? envelope?.result ?? envelope;
  return { payload: result, rawEnvelope: envelope };
}

async function executeViaMcp(workflowId) {
  const response = await mcpCall("execute_workflow", { workflowId, executionMode: "manual" });
  return {
    endpoint: "MCP tool execute_workflow",
    payload: response.payload,
    executionId: resolveExecutionId(response.payload),
  };
}

async function pollViaMcp(workflowId, executionId, deadlineMs) {
  let lastPayload = null;
  while (Date.now() < deadlineMs) {
    const { payload } = await mcpCall("get_execution", {
      workflowId,
      executionId,
      includeData: false,
    });
    lastPayload = payload;
    const status = executionStatus(payload);
    if (TERMINAL_STATUSES.has(status)) return { status, payload };
    await sleep(POLL_INTERVAL_MS);
  }
  return { status: "timeout", payload: lastPayload };
}

async function preflight() {
  const list = await listApiWorkflows();
  const byExactName = new Map();
  for (const workflow of list) {
    if (!byExactName.has(workflow.name)) byExactName.set(workflow.name, []);
    byExactName.get(workflow.name).push(workflow);
  }

  const resolved = [];
  for (const target of TARGETS) {
    const matches = byExactName.get(target.name) || [];
    if (!matches.length) {
      throw Object.assign(new Error(`Missing workflow by exact name: ${target.name}`), {
        failureKind: "preflight",
        failingWorkflow: target.name,
        reason: "workflow not found by exact name",
      });
    }
    const live = matches.find((w) => String(w.id) === target.expectedId) || matches[0];
    const full = await fetchApiWorkflow(live.id);
    const record = {
      name: target.name,
      expectedId: target.expectedId,
      liveId: live.id,
      active: !!full.active,
      idMismatch: live.id !== target.expectedId,
    };
    if (record.idMismatch) attempt.mismatches.push(record);
    if (!full.active) {
      throw Object.assign(new Error(`Workflow is not active: ${target.name}`), {
        failureKind: "preflight",
        failingWorkflow: target.name,
        reason: "workflow exists but is inactive",
        payload: record,
      });
    }
    resolved.push({ ...target, id: live.id, active: true });
    attempt.workflowMapping.push(record);
  }
  return resolved;
}

function isUnsupportedPublicExecuteError(error) {
  return error?.status === 405 || error?.status === 404 || /method not allowed|unsupported/i.test(safeString(error?.payload || error?.message));
}

function isMcpAvailabilityError(error) {
  return /not available|available.*mcp|mcp.*available|not found|unknown workflow|workflow.*not.*found/i.test(
    safeString(error?.payload || error?.message || error),
  );
}

async function launchAndPoll(workflow, pathName) {
  const row = {
    name: workflow.name,
    workflowId: workflow.id,
    path: pathName,
    startTime: new Date().toISOString(),
    stopTime: null,
    executionId: null,
    terminalStatus: null,
    executeResponse: null,
    pollResponse: null,
  };
  attempt.perWorkflow.push(row);
  writeJson(attemptPath, attempt);

  const launched =
    pathName === "public_api" ? await executeViaPublicApi(workflow.id) : await executeViaMcp(workflow.id);
  row.executeResponse = launched.payload;
  row.executionId = launched.executionId;
  if (String(launched.payload?.status || "").toLowerCase() === "error") {
    throw Object.assign(new Error(launched.payload?.error || "execution tool returned error"), {
      failureKind: "failure",
      failingWorkflow: workflow.name,
      endpoint: launched.endpoint,
      payload: launched.payload,
      row,
    });
  }
  if (!row.executionId) {
    throw Object.assign(new Error("execution did not return an executionId"), {
      failureKind: "failure",
      failingWorkflow: workflow.name,
      endpoint: launched.endpoint,
      payload: launched.payload,
      row,
    });
  }
  attempt.partialExecutionsLaunched.push({
    name: workflow.name,
    workflowId: workflow.id,
    executionId: launched.executionId,
    path: pathName,
    launchedAt: row.startTime,
  });

  const deadline = Date.now() + PER_WORKFLOW_TIMEOUT_MS;
  const polled =
    pathName === "public_api"
      ? await pollViaPublicApi(row.executionId, deadline)
      : await pollViaMcp(workflow.id, row.executionId, deadline);
  row.pollResponse = polled.payload;
  row.terminalStatus = polled.status;
  row.stopTime = new Date().toISOString();
  writeJson(attemptPath, attempt);

  if (!SUCCESS_STATUSES.has(polled.status)) {
    throw Object.assign(new Error(`terminal status ${polled.status}`), {
      failureKind: "failure",
      failingWorkflow: workflow.name,
      endpoint: pathName === "public_api" ? "/api/v1/executions/:id" : "MCP tool get_execution",
      payload: polled.payload,
      row,
    });
  }
  return row;
}

function remediationChecklist() {
  return [
    "In n8n UI, open each of the 5 workflows.",
    "Enable MCP availability for each workflow (workflow settings).",
    "Ensure workflow remains active.",
    "Re-run Step 10.",
  ];
}

async function main() {
  fs.mkdirSync(backupsDir, { recursive: true });
  writeJson(attemptPath, attempt);

  const workflows = await preflight();
  writeJson(attemptPath, attempt);

  let pathName = "public_api";
  attempt.chosenExecutionPath = "public_api";
  try {
    const first = await launchAndPoll(workflows[0], "public_api");
    attempt.notes.push("Public API execute path succeeded for first workflow; continuing with public_api.");
    writeJson(attemptPath, attempt);
  } catch (error) {
    if (!isUnsupportedPublicExecuteError(error)) throw error;
    attempt.notes.push({
      message: "Public API execute path unsupported; switching to MCP execute path.",
      endpoint: "/api/v1/workflows/:id/execute",
      response: error.payload || error.message,
    });
    attempt.perWorkflow = [];
    attempt.partialExecutionsLaunched = [];
    pathName = "mcp";
    attempt.chosenExecutionPath = "mcp";
    writeJson(attemptPath, attempt);
  }

  const startIndex = pathName === "public_api" ? 1 : 0;
  for (let i = startIndex; i < workflows.length; i += 1) {
    try {
      await launchAndPoll(workflows[i], pathName);
    } catch (error) {
      if (pathName === "mcp" && isMcpAvailabilityError(error)) {
        attempt.status = "BLOCKED";
        const failure = {
          status: "BLOCKED",
          failingWorkflow: error.failingWorkflow || workflows[i].name,
          workflowId: workflows[i].id,
          endpointOrTool: error.endpoint || "MCP tool execute_workflow/get_execution",
          reason: "MCP workflow availability block",
          responsePayload: error.payload || error.message,
          partialExecutionsLaunched: attempt.partialExecutionsLaunched,
          remediation: remediationChecklist(),
          attemptArtifact: attemptPath,
        };
        attempt.blocked = failure;
        writeJson(attemptPath, attempt);
        writeJson(failurePath, failure);
        console.log(JSON.stringify({
          status: "BLOCKED",
          failureArtifact: failurePath,
          attemptArtifact: attemptPath,
          failingWorkflow: failure.failingWorkflow,
          partialExecutionsLaunched: attempt.partialExecutionsLaunched.length,
          remediation: remediationChecklist(),
        }, null, 2));
        process.exit(2);
      }
      throw error;
    }
  }

  attempt.status = "PASS";
  writeJson(attemptPath, attempt);
  const success = {
    status: "PASS",
    chosenExecutionPath: attempt.chosenExecutionPath,
    workflowMapping: attempt.workflowMapping,
    executions: attempt.perWorkflow.map((row) => ({
      name: row.name,
      workflowId: row.workflowId,
      executionId: row.executionId,
      startTime: row.startTime,
      stopTime: row.stopTime,
      terminalStatus: row.terminalStatus,
      n8nStartedAt: executionStartedAt(row.pollResponse),
      n8nStoppedAt: executionStoppedAt(row.pollResponse),
    })),
    attemptArtifact: attemptPath,
  };
  writeJson(successPath, success);
  console.log(JSON.stringify({
    status: "PASS",
    chosenExecutionPath: attempt.chosenExecutionPath,
    attemptArtifact: attemptPath,
    successArtifact: successPath,
    executions: success.executions.map((e) => ({
      workflow: e.name,
      executionId: e.executionId,
      status: e.terminalStatus,
    })),
  }, null, 2));
}

main().catch((error) => {
  attempt.status = error.failureKind === "blocked" ? "BLOCKED" : "FAIL";
  const failure = {
    status: attempt.status,
    failingWorkflow: error.failingWorkflow || null,
    endpointOrTool: error.endpoint || null,
    reason: error.reason || error.message || "unknown failure",
    responsePayload: error.payload || null,
    partialExecutionsLaunched: attempt.partialExecutionsLaunched,
    attemptArtifact: attemptPath,
  };
  attempt.failure = failure;
  writeJson(attemptPath, attempt);
  writeJson(failurePath, failure);
  console.log(JSON.stringify({
    status: failure.status,
    failingWorkflow: failure.failingWorkflow,
    reason: failure.reason,
    attemptArtifact: attemptPath,
    failureArtifact: failurePath,
    partialExecutionsLaunched: attempt.partialExecutionsLaunched.length,
  }, null, 2));
  process.exit(failure.status === "BLOCKED" ? 2 : 1);
});
