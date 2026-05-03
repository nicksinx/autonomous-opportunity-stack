#!/usr/bin/env node
/**
 * Read-only n8n workflow deletion-risk audit.
 *
 * Required env: N8N_API_URL (or N8N_BASE_URL), N8N_API_KEY.
 * Outputs:
 * - backups/n8n/workflow-audit-<timestamp>.json
 * - backups/n8n/workflow-deletion-review-<timestamp>.md
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const backupsDir = path.join(repoRoot, "backups", "n8n");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const auditPath = path.join(backupsDir, `workflow-audit-${timestamp}.json`);
const reviewPath = path.join(backupsDir, `workflow-deletion-review-${timestamp}.md`);
const staleDays = 90;
const timeoutMs = Number(process.env.N8N_AUDIT_TIMEOUT_MS || 15000);

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

const apiUrl = (process.env.N8N_API_URL || process.env.N8N_BASE_URL || "")
  .trim()
  .replace(/\/+$/, "");
const apiKey = (process.env.N8N_API_KEY || "").trim();

if (!apiUrl) {
  console.error("missing N8N_API_URL / N8N_BASE_URL env");
  process.exit(2);
}
if (!apiKey) {
  console.error("missing N8N_API_KEY env");
  process.exit(2);
}

function redactErrorMessage(message) {
  let s = String(message || "");
  if (apiKey) s = s.split(apiKey).join("[REDACTED_API_KEY]");
  return s.replace(/X-N8N-API-KEY:\s*[^,\s}]+/gi, "X-N8N-API-KEY: [REDACTED]");
}

async function fetchJson(endpoint, { allow404 = false } = {}) {
  const url = `${apiUrl}${endpoint}`;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-N8N-API-KEY": apiKey,
        },
        signal: controller.signal,
      });
      const body = await res.text();
      if (allow404 && res.status === 404) return { unavailable: true, status: 404 };
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
      }
      if (!body) return null;
      try {
        return JSON.parse(body);
      } catch (_e) {
        return body;
      }
    } catch (e) {
      lastErr = e;
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(redactErrorMessage(lastErr?.message || lastErr));
}

async function listAllWorkflows() {
  const all = [];
  let cursor = "";
  const failures = [];
  for (let page = 0; page < 50; page += 1) {
    const q = new URLSearchParams({ limit: "250" });
    if (cursor) q.set("cursor", cursor);
    try {
      const data = await fetchJson(`/api/v1/workflows?${q}`);
      const items = Array.isArray(data?.data) ? data.data : [];
      all.push(...items);
      cursor = String(data?.nextCursor || "");
      if (!cursor) break;
    } catch (e) {
      failures.push({ endpoint: "/api/v1/workflows", error: redactErrorMessage(e?.message || e) });
      break;
    }
  }
  return { all, failures };
}

async function fetchFullWorkflows(list) {
  const full = [];
  const failures = [];
  for (const w of list) {
    try {
      full.push(await fetchJson(`/api/v1/workflows/${encodeURIComponent(w.id)}`));
    } catch (e) {
      failures.push({
        id: w.id,
        name: w.name,
        endpoint: `/api/v1/workflows/${w.id}`,
        error: redactErrorMessage(e?.message || e),
      });
    }
  }
  return { full, failures };
}

async function fetchExecutions(workflowId, status) {
  const q = new URLSearchParams({ workflowId: String(workflowId), limit: "5" });
  if (status) q.set("status", status);
  return fetchJson(`/api/v1/executions?${q}`, { allow404: true });
}

async function fetchExecutionSummary(workflows) {
  const byId = new Map();
  let unavailable = false;
  const failures = [];
  for (const wf of workflows) {
    const id = wf?.id;
    const summary = {
      lastAnyFinishedAt: "",
      lastAnyStatus: "",
      lastSuccessFinishedAt: "",
      signal: "executions_api",
    };
    try {
      const any = await fetchExecutions(id);
      if (any?.unavailable) {
        unavailable = true;
        summary.signal = "weak_updatedAt";
        byId.set(id, summary);
        continue;
      }
      const anyItems = Array.isArray(any?.data) ? any.data : [];
      const latestAny = anyItems[0];
      if (latestAny) {
        summary.lastAnyFinishedAt = latestAny.finishedAt || latestAny.stoppedAt || latestAny.updatedAt || "";
        summary.lastAnyStatus = executionStatus(latestAny);
      }

      const success = await fetchExecutions(id, "success");
      if (success?.unavailable) {
        unavailable = true;
        summary.signal = "weak_updatedAt";
      } else {
        const successItems = Array.isArray(success?.data) ? success.data : [];
        const latestSuccess = successItems[0];
        if (latestSuccess) {
          summary.lastSuccessFinishedAt =
            latestSuccess.finishedAt || latestSuccess.stoppedAt || latestSuccess.updatedAt || "";
        }
      }
    } catch (e) {
      failures.push({ id, error: redactErrorMessage(e?.message || e) });
      summary.signal = "weak_updatedAt";
    }
    byId.set(id, summary);
  }
  return { byId, unavailable, failures };
}

function executionStatus(execution) {
  if (execution?.status) return String(execution.status);
  if (execution?.finished === true) return "success";
  if (execution?.stoppedAt || execution?.finishedAt) return "finished";
  return "";
}

function nodeCredentials(node) {
  const out = [];
  const credentials = node?.credentials || {};
  for (const [type, value] of Object.entries(credentials)) {
    if (!value || typeof value !== "object") continue;
    out.push({
      type,
      name: typeof value.name === "string" ? value.name : "",
    });
  }
  return out.filter((c) => c.name || c.type);
}

function strippedWorkflow(wf) {
  const nodes = Array.isArray(wf?.nodes) ? wf.nodes : [];
  return {
    id: wf?.id,
    name: wf?.name,
    active: !!wf?.active,
    createdAt: wf?.createdAt || "",
    updatedAt: wf?.updatedAt || "",
    tags: Array.isArray(wf?.tags)
      ? wf.tags.map((t) => (typeof t === "string" ? t : t?.name || t?.id || "")).filter(Boolean)
      : [],
    nodes: nodes.map((n) => ({
      type: n?.type || "",
      credentials: nodeCredentials(n),
    })),
    settings: wf?.settings || {},
  };
}

function countNodeTypes(nodes) {
  const counts = {
    googleSheets: 0,
    postgres: 0,
    httpRequest: 0,
    code: 0,
    triggers: 0,
  };
  for (const n of nodes) {
    const type = String(n?.type || "");
    if (type === "n8n-nodes-base.googleSheets") counts.googleSheets += 1;
    if (type === "n8n-nodes-base.postgres") counts.postgres += 1;
    if (type === "n8n-nodes-base.httpRequest") counts.httpRequest += 1;
    if (type === "n8n-nodes-base.code") counts.code += 1;
    if (isTriggerType(type)) counts.triggers += 1;
  }
  return counts;
}

function isTriggerType(type) {
  const lower = String(type || "").toLowerCase();
  return (
    lower.endsWith("trigger") ||
    lower.includes(".webhook") ||
    lower.includes("manualtrigger") ||
    lower.includes("scheduletrigger") ||
    lower.includes("executeworkflowtrigger")
  );
}

function credentialNames(nodes) {
  const names = new Set();
  for (const n of nodes) {
    for (const c of nodeCredentials(n)) {
      if (c.name) names.add(c.name);
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function workflowBucket(wf, duplicateNames) {
  const name = String(wf?.name || "");
  if (duplicateNames.has(name)) return "duplicate_name";
  if (/error handler/i.test(name)) return "error_handler";
  if (/(legacy|old|backup|copy|deprecated|\(legacy)/i.test(name)) return "legacy_renamed";
  if (/^wf_/.test(name) && /(collect|normalize|enrich|score|publish|ingest|feedback|briefs|phrase)/i.test(name)) {
    return "pipeline_wf_*";
  }
  if (/(experiment|experimental|test|scratch|sandbox|poc|demo)/i.test(name)) return "experimental";
  return "unknown";
}

function canonicalPipeline(wf) {
  const name = String(wf?.name || "");
  if (/error handler/i.test(name)) return false;
  if (/(legacy|old|backup|copy|deprecated|\(legacy)/i.test(name)) return false;
  return /^wf_/.test(name) && /(collect|normalize|enrich|score|publish|ingest|feedback|briefs|phrase)/i.test(name);
}

function publicWebhookRisk(wf) {
  const nodes = Array.isArray(wf?.nodes) ? wf.nodes : [];
  return nodes.some((n) => {
    const type = String(n?.type || "").toLowerCase();
    if (!type.includes("webhook")) return false;
    const pathValue = n?.parameters?.path || n?.webhookId || "";
    return Boolean(pathValue);
  });
}

function buildReferenceGraph(workflows) {
  const byId = new Map(workflows.map((wf) => [String(wf?.id), wf]));
  const references = new Map();
  for (const wf of workflows) references.set(String(wf?.id), []);

  for (const source of workflows) {
    const sourceId = String(source?.id);
    const settings = source?.settings || {};
    const errorWorkflowId = settings.errorWorkflow || settings.errorWorkflowId;
    if (errorWorkflowId && byId.has(String(errorWorkflowId))) {
      references.get(String(errorWorkflowId)).push({
        sourceId,
        sourceName: source?.name || "",
        kind: "error handler",
      });
    }

    const serializedNodes = JSON.stringify(source?.nodes || []);
    for (const target of workflows) {
      const targetId = String(target?.id);
      if (targetId === sourceId) continue;
      if (serializedNodes.includes(targetId)) {
        references.get(targetId).push({
          sourceId,
          sourceName: source?.name || "",
          kind: "node reference",
        });
      }
    }
  }
  return references;
}

function lastActivityDate(wf, exec) {
  if (exec?.signal === "weak_updatedAt") return wf?.updatedAt || "";
  return exec?.lastSuccessFinishedAt || exec?.lastAnyFinishedAt || "";
}

function daysSince(dateString) {
  if (!dateString) return Infinity;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return Infinity;
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function recommendationFor(row) {
  const rationale = [];
  let recommendation = "REVIEW";
  let confidence = "low";

  if (row.active) rationale.push("Active workflow; deletion is out of scope without deactivation and an operational window.");
  if (row.isCanonicalPipeline) rationale.push("Matches the canonical `wf_*` project pipeline naming family.");
  if (row.isErrorHandlerTarget) rationale.push("Referenced as an error workflow by another workflow.");
  if (row.references.length > 0 && !row.isErrorHandlerTarget) rationale.push("Referenced by another workflow.");
  if (row.webhookRisk) rationale.push("Contains a webhook node with a configured path; inbound/public-facing risk needs review.");
  if (row.recent) {
    rationale.push(
      row.execSignal === "weak_updatedAt"
        ? `Recent updatedAt fallback signal within ${staleDays} days.`
        : `Recent execution signal within ${staleDays} days.`,
    );
  }
  if (row.bucket === "duplicate_name" && !row.isErrorHandlerTarget) {
    rationale.push("Duplicate workflow name group; requires human disambiguation.");
  }
  if (row.bucket === "error_handler" && !row.isErrorHandlerTarget) {
    rationale.push("Looks like an error handler but was not detected as a current errorWorkflow target.");
  }

  if (row.active || row.isCanonicalPipeline || row.isErrorHandlerTarget || row.recent) {
    recommendation = "KEEP";
    confidence = row.execSignal === "executions_api" ? "high" : "medium";
  } else if (
    !row.active &&
    !row.webhookRisk &&
    row.references.length === 0 &&
    ["legacy_renamed", "experimental"].includes(row.bucket) &&
    !row.recent
  ) {
    recommendation = "CANDIDATE_DELETE";
    confidence = row.execSignal === "executions_api" ? "medium" : "low";
    rationale.push("Inactive, stale, unreferenced, and name suggests legacy or experimental workflow.");
  } else {
    recommendation = "REVIEW";
    confidence = row.execSignal === "executions_api" ? "medium" : "low";
    if (!rationale.length) rationale.push("Inactive but lacks enough naming or dependency evidence to recommend deletion.");
  }

  return { recommendation, confidence, rationale };
}

function mdEscape(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

function formatCounts(counts) {
  return `gs:${counts.googleSheets}, pg:${counts.postgres}, http:${counts.httpRequest}, code:${counts.code}, triggers:${counts.triggers}`;
}

function formatReferences(refs) {
  if (!refs.length) return "";
  return refs.map((r) => `${r.sourceName || r.sourceId} (${r.kind})`).join("; ");
}

function uniqueNameCounts(workflows) {
  const counts = new Map();
  for (const wf of workflows) counts.set(wf?.name || "", (counts.get(wf?.name || "") || 0) + 1);
  return new Set(Array.from(counts.entries()).filter(([, count]) => count > 1).map(([name]) => name));
}

function buildRows(workflows, execById, references) {
  const duplicateNames = uniqueNameCounts(workflows);
  return workflows
    .map((wf) => {
      const nodes = Array.isArray(wf?.nodes) ? wf.nodes : [];
      const exec = execById.get(wf?.id) || { signal: "weak_updatedAt" };
      const refs = references.get(String(wf?.id)) || [];
      const counts = countNodeTypes(nodes);
      const bucket = workflowBucket(wf, duplicateNames);
      const activity = lastActivityDate(wf, exec);
      const recent = daysSince(activity) <= staleDays;
      const base = {
        id: wf?.id,
        name: wf?.name || "",
        active: !!wf?.active,
        primaryNodeTypes: counts,
        credentialNames: credentialNames(nodes),
        bucket,
        createdAt: wf?.createdAt || "",
        updatedAt: wf?.updatedAt || "",
        lastAnyFinishedAt: exec.lastAnyFinishedAt || "",
        lastAnyStatus: exec.lastAnyStatus || "",
        lastSuccessFinishedAt: exec.lastSuccessFinishedAt || "",
        execSignal: exec.signal || "weak_updatedAt",
        references: refs,
        isErrorHandlerTarget: refs.some((r) => r.kind === "error handler"),
        isCanonicalPipeline: canonicalPipeline(wf),
        webhookRisk: publicWebhookRisk(wf),
        recent,
      };
      return { ...base, ...recommendationFor(base) };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function buildMarkdown(rows, meta) {
  const recommendationCounts = rows.reduce((acc, row) => {
    acc[row.recommendation] = (acc[row.recommendation] || 0) + 1;
    return acc;
  }, {});
  const neverAutoDelete = rows.filter((r) => r.active || r.isCanonicalPipeline);
  const dependencyLines = rows
    .filter((r) => r.references.length)
    .map((r) => `- ${r.name} (${r.id}) is referenced by ${formatReferences(r.references)}.`);

  const lines = [];
  lines.push(`# n8n Workflow Deletion Review`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: ${apiUrl.replace(/\/\/[^/@]+@/, "//[redacted]@")}`);
  lines.push(`Workflow list count: ${meta.listCount}`);
  lines.push(`Full workflow count: ${meta.fullCount}`);
  lines.push(`HTTP failures: ${meta.httpFailures.length}`);
  lines.push(`Execution recency signal: ${meta.executionUnavailable ? "weak_updatedAt fallback for unavailable executions API" : "executions_api where available"}`);
  lines.push("");
  lines.push(`## Executive summary`);
  lines.push("");
  lines.push(`- KEEP: ${recommendationCounts.KEEP || 0}`);
  lines.push(`- REVIEW: ${recommendationCounts.REVIEW || 0}`);
  lines.push(`- CANDIDATE_DELETE: ${recommendationCounts.CANDIDATE_DELETE || 0}`);
  lines.push(`- Stale threshold: ${staleDays} days`);
  lines.push("");
  lines.push(`## Full review table`);
  lines.push("");
  lines.push("| id | name | active | primary_node_types | credential_names | bucket | last_any | last_success | references | recommendation | confidence | rationale |");
  lines.push("|---|---|---:|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.name,
        row.active ? "true" : "false",
        formatCounts(row.primaryNodeTypes),
        row.credentialNames.join(", "),
        row.bucket,
        row.lastAnyFinishedAt ? `${row.lastAnyFinishedAt} ${row.lastAnyStatus ? `(${row.lastAnyStatus})` : ""}` : `none (${row.execSignal})`,
        row.lastSuccessFinishedAt || `none (${row.execSignal})`,
        formatReferences(row.references),
        row.recommendation,
        row.confidence,
        row.rationale.join("; "),
      ].map(mdEscape).join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }
  lines.push("");
  lines.push(`## Heuristics`);
  lines.push("");
  lines.push("- `pipeline_wf_*`: name starts with `wf_` and matches this project's collect, normalize, enrich, score, publish, ingest, feedback, briefs, or phrase-expansion family.");
  lines.push("- `error_handler`: name contains `Error Handler`.");
  lines.push("- `legacy_renamed`: name contains legacy, old, backup, copy, deprecated, or `(legacy`.");
  lines.push("- `duplicate_name`: two or more workflows share the same exact name; all workflows in that group are flagged.");
  lines.push("- `experimental`: name suggests experiment, test, scratch, sandbox, POC, or demo.");
  lines.push("- `unknown`: none of the above matched.");
  lines.push("");
  lines.push(`## Dependency graph summary`);
  lines.push("");
  if (dependencyLines.length) lines.push(...dependencyLines);
  else lines.push("- No cross-workflow references detected by settings and serialized-node string scan.");
  lines.push("");
  lines.push(`## Never auto-delete`);
  lines.push("");
  if (neverAutoDelete.length) {
    for (const row of neverAutoDelete) {
      const why = [row.active ? "active" : "", row.isCanonicalPipeline ? "canonical pipeline name" : ""].filter(Boolean).join(", ");
      lines.push(`- ${row.name} (${row.id}) - ${why}`);
    }
  } else {
    lines.push("- None identified.");
  }
  lines.push("");
  lines.push(`## Ordered deletion plan for later approval`);
  lines.push("");
  lines.push("1. Keep this snapshot and review file as rollback/reference artifacts.");
  lines.push("2. For each approved candidate, deactivate first if it is active; active deletion is intentionally out of scope for this audit.");
  lines.push("3. Verify no schedules, webhook paths, errorWorkflow settings, Execute Workflow nodes, or HTTP/Code references point to the workflow.");
  lines.push("4. Delete only the explicitly approved workflow IDs.");
  lines.push("5. Re-run this audit and compare counts after deletion.");
  lines.push("");
  lines.push(`## Checkpoints`);
  lines.push("");
  lines.push(`- Row count matches list endpoint: ${meta.listCount === meta.fullCount ? "yes" : "no"}`);
  lines.push(`- Zero HTTP failures: ${meta.httpFailures.length === 0 ? "yes" : "no"}`);
  if (meta.httpFailures.length) {
    for (const failure of meta.httpFailures) {
      lines.push(`- Failure: ${mdEscape(failure.id || failure.endpoint)} ${mdEscape(failure.error)}`);
    }
  }
  if (meta.executionFailures.length) {
    lines.push(`- Execution lookup failures: ${meta.executionFailures.length}; affected workflows use weak updatedAt signal.`);
  }
  if (/ngrok/i.test(apiUrl)) {
    lines.push("- Note: API URL appears to use ngrok; slow or hung API calls are possible, so this script used timeouts and one retry.");
  }
  lines.push("");
  return lines.join("\n");
}

(async () => {
  fs.mkdirSync(backupsDir, { recursive: true });

  const listed = await listAllWorkflows();
  const fetched = await fetchFullWorkflows(listed.all);
  const httpFailures = [...listed.failures, ...fetched.failures];
  const workflows = fetched.full;
  const audit = workflows.map(strippedWorkflow);
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));

  const executions = await fetchExecutionSummary(workflows);
  const references = buildReferenceGraph(workflows);
  const rows = buildRows(workflows, executions.byId, references);
  const review = buildMarkdown(rows, {
    listCount: listed.all.length,
    fullCount: workflows.length,
    httpFailures,
    executionFailures: executions.failures,
    executionUnavailable: executions.unavailable,
  });
  fs.writeFileSync(reviewPath, review);

  const counts = rows.reduce((acc, row) => {
    acc[row.recommendation] = (acc[row.recommendation] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({
    audit: auditPath,
    review: reviewPath,
    workflowsListed: listed.all.length,
    workflowsFetched: workflows.length,
    httpFailures: httpFailures.length,
    executionFailures: executions.failures.length,
    recommendations: counts,
  }, null, 2));
})().catch((e) => {
  console.error(redactErrorMessage(e?.stack || e));
  process.exit(1);
});
