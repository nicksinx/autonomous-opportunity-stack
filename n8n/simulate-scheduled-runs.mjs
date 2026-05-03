#!/usr/bin/env node
/**
 * Trigger scheduled main workflows on a running n8n instance through MCP
 * (same effect as waiting for Schedule Trigger, but immediate). Skips
 * error-handler workflows and webhook-only workflows (e.g. wf_phrase_expansion).
 *
 * Requires n8n MCP access:
 *   N8N_MCP_URL   — MCP HTTP endpoint, e.g. https://host/mcp-server/http
 *   N8N_MCP_TOKEN — Instance-level MCP access token
 *
 * Optional:
 *   N8N_SCHEDULED_WORKFLOWS — comma-separated names (default: repo scheduled mains)
 *
 * Usage:
 *   node n8n/simulate-scheduled-runs.mjs --dry-run
 *   node n8n/simulate-scheduled-runs.mjs
 */

import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const DEFAULT_NAMES = [
  "wf_collect_trends",
  "wf_normalize_terms",
  "wf_enrich_marketplace",
  "wf_score_and_cluster",
  "wf_generate_range_briefs",
];
const MCP_TIMEOUT_MS = 30_000;
const MCP_MAX_RETRIES = 3;

const LIVE_WORKFLOW_IDS = {
  wf_collect_trends: "AsORoSwQOE4ABSmb",
  wf_normalize_terms: "0oHTYICyghlyqwRX",
  wf_score_and_cluster: "FzwunYIiBc76MFJp",
  wf_enrich_marketplace: "0jY0awmaJn8RMY8q",
  wf_generate_range_briefs: "HfUHI8bSMxO6KzFU",
};

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function baseUrl() {
  const u = (process.env.N8N_API_URL || process.env.N8N_BASE_URL || "").trim().replace(/\/+$/, "");
  return u;
}

function mcpUrl() {
  const u = (process.env.N8N_MCP_URL || "").trim().replace(/\/+$/, "");
  return u;
}

function mcpToken() {
  return (process.env.N8N_MCP_TOKEN || "").trim();
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Accept: "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text };
  }
  if (!res.ok) {
    const msg = body?.message || body?._raw || res.statusText;
    throw new Error(`${res.status} ${url}: ${msg}`);
  }
  return body;
}

function parseMcpSse(body) {
  const lines = String(body || "").split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (!payload) continue;
    try {
      return JSON.parse(payload);
    } catch {
      return { raw: payload };
    }
  }
  return { raw: String(body || "") };
}

async function listAllWorkflows() {
  const result = await mcpCallWithRetry("search_workflows", { limit: 200 });
  return Array.isArray(result?.data) ? result.data : [];
}

async function mcpCall(name, args = {}, id = Date.now()) {
  const url = mcpUrl();
  if (!url) throw new Error("Set N8N_MCP_URL to the MCP HTTP endpoint.");
  if (!mcpToken()) throw new Error("Set N8N_MCP_TOKEN to the instance-level MCP token.");

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

  const parsedUrl = new URL(url);
  const requestImpl = parsedUrl.protocol === "http:" ? http.request : https.request;
  const body = await new Promise((resolve, reject) => {
    const req = requestImpl(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: "POST",
        timeout: MCP_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${mcpToken()}`,
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

  const parsed = parseMcpSse(body.text);
  if (body.statusCode >= 400) {
    const msg = parsed?.error?.message || parsed?.raw || "request failed";
    throw new Error(`${body.statusCode} ${url}: ${msg}`);
  }
  if (parsed.error) throw new Error(`${name} error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  return parsed.result?.structuredContent ?? parsed.result ?? parsed;
}

async function mcpCallWithRetry(name, args = {}, retries = MCP_MAX_RETRIES) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      return await mcpCall(name, args, Date.now() + i);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retryable =
        msg.includes("timeout") ||
        msg.includes("429") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("504");
      if (i < retries && retryable) {
        await new Promise((r) => setTimeout(r, 700 * i));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error(`${name} failed`);
}

function pickWorkflowId(workflows, wantName) {
  const matches = workflows.filter((w) => w && w.name === wantName);
  if (matches.length === 0) return { id: null, warning: null };
  if (matches.length === 1) return { id: matches[0].id, warning: null };
  const sorted = [...matches].sort((a, b) => (b.nodes?.length || 0) - (a.nodes?.length || 0));
  return {
    id: sorted[0].id,
    warning: `multiple workflows named "${wantName}"; using id ${sorted[0].id} (${sorted[0].nodes?.length || 0} nodes)`,
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const spreadArg = process.argv.find((arg) => arg.startsWith("--spread-ms="));
  const spreadMs = spreadArg ? Number(spreadArg.slice("--spread-ms=".length)) : 15000;
  loadDotEnv(path.join(repoRoot, ".env"));

  const root = baseUrl();
  const names = (process.env.N8N_SCHEDULED_WORKFLOWS || DEFAULT_NAMES.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!root && !mcpUrl()) {
    console.error("Set N8N_API_URL or N8N_BASE_URL (instance URL, e.g. https://host).");
    process.exit(1);
  }
  if (!dryRun && (!mcpUrl() || !mcpToken())) {
    console.error("Set N8N_MCP_URL and N8N_MCP_TOKEN to execute workflows. Use --dry-run to only print the plan.");
    process.exit(1);
  }

  console.log(`Instance: ${root || mcpUrl()}`);
  console.log(`Workflows to run: ${names.join(", ")}`);
  console.log(`Start spread: ${spreadMs}ms`);
  if (dryRun) {
    console.log("\n--dry-run: no API calls.");
    process.exit(0);
  }

  const results = [];
  const workflows = await listAllWorkflows();

  for (const name of names) {
    const { id, warning } = pickWorkflowId(workflows, name);
    const selectedId = id || LIVE_WORKFLOW_IDS[name] || null;
    if (!id) {
      if (selectedId) {
        try {
          const exec = await mcpCallWithRetry("execute_workflow", {
            workflowId: selectedId,
          });
          results.push({
            name,
            ok: true,
            workflowId: selectedId,
            executionId: exec?.executionId ?? exec?.id ?? exec,
            note: "used live workflow ID fallback",
          });
          continue;
        } catch (e) {
          results.push({ name, ok: false, workflowId: selectedId, error: String(e.message || e) });
          continue;
        }
      }
      results.push({ name, ok: false, error: "not found on instance" });
      if (warning) console.warn(warning);
      continue;
    }
    if (warning) console.warn(warning);
    try {
      const exec = await mcpCallWithRetry("execute_workflow", {
        workflowId: id,
        executionMode: "manual",
      });
      if (exec?.status === "error") {
        results.push({
          name,
          ok: false,
          workflowId: id,
          error: exec.error || "execution failed",
        });
        continue;
      }

      let executionDetails = null;
      if (exec?.executionId) {
        try {
          executionDetails = await pollExecution(id, exec.executionId);
        } catch (pollErr) {
          executionDetails = { error: String(pollErr.message || pollErr) };
        }
      }
      results.push({
        name,
        ok: true,
        workflowId: id,
        executionId: exec?.executionId ?? exec?.id ?? exec,
        execution: executionDetails,
      });
    } catch (e) {
      results.push({ name, ok: false, workflowId: id, error: String(e.message || e) });
    }

    if (name !== names[names.length - 1] && spreadMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, spreadMs));
    }
  }

  console.log("\nResults:");
  for (const r of results) {
    if (r.ok) {
      const exec = r.execution?.execution || r.execution || {};
      const status = exec.status || r.execution?.status || "unknown";
      const started = exec.startedAt || "";
      const stopped = exec.stoppedAt || "";
      const extra = [started ? `started=${started}` : "", stopped ? `stopped=${stopped}` : ""]
        .filter(Boolean)
        .join(" ");
      console.log(
        `  OK   ${r.name}  execution=${JSON.stringify(r.executionId)} status=${status}${extra ? ` ${extra}` : ""}`,
      );
    } else {
      console.log(`  FAIL ${r.name}  ${r.error || "unknown"}`);
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  process.exit(failed ? 1 : 0);
}

async function pollExecution(workflowId, executionId) {
  let last = null;
  for (let i = 0; i < 60; i++) {
    last = await mcpCall("get_execution", {
      workflowId,
      executionId,
      includeData: false,
    });
    const status = last?.execution?.status || last?.status || "unknown";
    if (["success", "error", "canceled", "crashed"].includes(status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return last;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
