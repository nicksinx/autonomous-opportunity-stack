#!/usr/bin/env node
/**
 * Inspect an n8n execution and write a sanitized artifact.
 *
 * Usage:
 *   node n8n/inspect-execution.mjs <workflowId> <executionId>
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.join(repoRoot, ".env"));
loadDotEnv(path.join(repoRoot, ".env.local"));

const [workflowId, executionId] = process.argv.slice(2);
if (!workflowId || !executionId) {
  console.error("Usage: node n8n/inspect-execution.mjs <workflowId> <executionId>");
  process.exit(2);
}

const apiBase = (process.env.N8N_API_URL || process.env.N8N_BASE_URL || "").trim().replace(/\/+$/, "");
const apiKey = (process.env.N8N_API_KEY || "").trim();
const mcpEndpoint = (process.env.N8N_MCP_URL || "").trim().replace(/\/+$/, "");
const mcpToken = (process.env.N8N_MCP_TOKEN || "").trim();

function redactString(value) {
  let out = String(value ?? "");
  for (const secret of [apiKey, mcpToken]) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  out = out.replace(/(authorization|x-n8n-api-key|api[_-]?key|token|password|secret)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1$2[REDACTED]");
  return out;
}

function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") {
    const redacted = redactString(value);
    return redacted.length > 4000 ? `${redacted.slice(0, 4000)}...[truncated]` : redacted;
  }
  if (typeof value !== "object") return value;
  if (depth > 8) return "[truncated-depth]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (/authorization|credential|password|token|secret|api.?key|headers?/i.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = sanitize(val, depth + 1);
    }
  }
  return out;
}

function parseMcpEnvelope(text) {
  for (const line of String(text || "").split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (!payload) continue;
    try {
      return JSON.parse(payload);
    } catch {
      return { raw: payload };
    }
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

async function mcpCall(toolName, args = {}) {
  if (!mcpEndpoint || !mcpToken) throw new Error("missing N8N_MCP_URL / N8N_MCP_TOKEN");
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
        timeout: 30000,
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
  if (response.statusCode >= 400 || envelope?.error) {
    throw new Error(redactString(envelope?.error?.message || response.text || `MCP HTTP ${response.statusCode}`));
  }
  return envelope?.result?.structuredContent ?? envelope?.result ?? envelope;
}

async function apiGetExecution() {
  if (!apiBase || !apiKey) throw new Error("missing N8N_API_URL / N8N_API_KEY");
  const url = `${apiBase}/api/v1/executions/${encodeURIComponent(executionId)}?includeData=true`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${redactString(text.slice(0, 1000))}`);
  return payload;
}

function findErrorDetails(payload) {
  const candidates = [];
  const seen = new Set();
  function walk(value, pathParts = []) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    const hasError = value.error || value.lastNodeExecuted || value.node || value.nodeName;
    const message = value.message || value.description || value.error?.message;
    if (hasError && message) {
      candidates.push({
        path: pathParts.join("."),
        node: value.node?.name || value.nodeName || value.lastNodeExecuted || value.error?.node?.name || "",
        message,
        description: value.description || value.error?.description || "",
        type: value.name || value.error?.name || "",
      });
    }
    for (const [key, val] of Object.entries(value)) walk(val, [...pathParts, key]);
  }
  walk(payload);
  return candidates.slice(0, 20);
}

(async () => {
  let source = "mcp";
  let payload;
  try {
    payload = await mcpCall("get_execution", {
      workflowId,
      executionId,
      includeData: true,
      truncateData: 5,
    });
  } catch (mcpError) {
    source = "public_api";
    payload = await apiGetExecution();
  }
  const artifact = {
    inspectedAt: new Date().toISOString(),
    source,
    workflowId,
    executionId,
    execution: sanitize(payload?.execution || {
      id: payload?.id,
      workflowId: payload?.workflowId,
      status: payload?.status,
      startedAt: payload?.startedAt,
      stoppedAt: payload?.stoppedAt,
      finished: payload?.finished,
    }),
    errorCandidates: sanitize(findErrorDetails(payload)),
    payload: sanitize(payload),
  };
  const outPath = path.join(backupsDir, `execution-${executionId}-inspection-${stamp}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({
    artifact: outPath,
    source,
    execution: artifact.execution,
    errorCandidates: artifact.errorCandidates,
  }, null, 2));
})().catch((e) => {
  console.error(redactString(e?.stack || e));
  process.exit(1);
});
