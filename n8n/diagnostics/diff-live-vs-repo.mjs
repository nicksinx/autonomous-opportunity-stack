#!/usr/bin/env node
/**
 * Compare every n8n/wf_*.json (repo) vs the matching workflow in a live
 * snapshot (default: backups/n8n/closeout-snapshot.json). Live is treated
 * as source of truth. Reports drift on `nodes` (parameters + type +
 * typeVersion + credentials.postgres ref), `connections`, and `settings`
 * (allow-listed keys only).
 *
 * Usage:
 *   node n8n/diagnostics/diff-live-vs-repo.mjs
 *   node n8n/diagnostics/diff-live-vs-repo.mjs --snapshot backups/n8n/closeout-snapshot.json
 *
 * Exit 0 = parity, exit 1 = drift detected.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const wfDir = path.join(repoRoot, "n8n");

const args = process.argv.slice(2);
const snapArgIdx = args.indexOf("--snapshot");
const snapshotPath = snapArgIdx >= 0
  ? path.resolve(args[snapArgIdx + 1])
  : path.join(repoRoot, "backups", "n8n", "closeout-snapshot.json");

if (!fs.existsSync(snapshotPath)) {
  console.error(`snapshot not found: ${snapshotPath}`);
  process.exit(2);
}

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const liveByName = new Map();
for (const w of snapshot) {
  if (w && w.name) liveByName.set(w.name, w);
}

// Settings keys we compare. callerPolicy and callerIds are intentionally
// excluded: n8n adds callerPolicy="workflowsFromSameOwner" by default at
// import time, and that default is not something we want to commit to repo.
const SETTINGS_ALLOWLIST = new Set([
  "executionOrder",
  "timezone",
  "errorWorkflow",
  "saveDataErrorExecution",
  "saveDataSuccessExecution",
  "saveExecutionProgress",
  "saveManualExecutions",
]);

function pickAllowlisted(settings) {
  if (!settings || typeof settings !== "object") return {};
  const out = {};
  for (const k of Object.keys(settings)) {
    if (SETTINGS_ALLOWLIST.has(k)) out[k] = settings[k];
  }
  return out;
}

// Strip `id` from credential refs - n8n injects a per-instance credential id
// at import time. The repo only carries `name`; that match is what matters.
function normaliseCredentials(creds) {
  if (!creds || typeof creds !== "object") return {};
  const out = {};
  for (const [credType, ref] of Object.entries(creds)) {
    if (ref && typeof ref === "object") {
      out[credType] = { name: ref.name };
    } else {
      out[credType] = ref;
    }
  }
  return out;
}

function normaliseNode(n) {
  if (!n || typeof n !== "object") return null;
  return {
    name: n.name,
    type: n.type,
    typeVersion: n.typeVersion,
    parameters: n.parameters ?? {},
    credentials: n.credentials ?? {},
  };
}

function buildNodeMap(wf) {
  const m = new Map();
  for (const n of wf.nodes || []) {
    if (n && n.name) m.set(n.name, normaliseNode(n));
  }
  return m;
}

function deepEqual(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const sorted = {};
    for (const k of Object.keys(v).sort()) sorted[k] = canon(v[k]);
    return sorted;
  }
  return v;
}

function loadRepoWorkflows() {
  const out = [];
  for (const f of fs.readdirSync(wfDir).sort()) {
    if (!f.startsWith("wf_") || !f.endsWith(".json")) continue;
    const fp = path.join(wfDir, f);
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    const list = Array.isArray(data) ? data : [data];
    for (const wf of list) {
      out.push({ file: path.relative(repoRoot, fp), wf });
    }
  }
  return out;
}

function diffWorkflow(repo, live) {
  const issues = [];
  const repoNodes = buildNodeMap(repo);
  const liveNodes = buildNodeMap(live);

  const allNames = new Set([...repoNodes.keys(), ...liveNodes.keys()]);
  for (const name of allNames) {
    const r = repoNodes.get(name);
    const l = liveNodes.get(name);
    if (!r) {
      issues.push({ kind: "node-only-in-live", node: name });
      continue;
    }
    if (!l) {
      issues.push({ kind: "node-only-in-repo", node: name });
      continue;
    }
    if (r.type !== l.type) {
      issues.push({ kind: "node-type-mismatch", node: name, repo: r.type, live: l.type });
    }
    if (r.typeVersion !== l.typeVersion) {
      issues.push({ kind: "typeVersion-mismatch", node: name, repo: r.typeVersion, live: l.typeVersion });
    }
    if (!deepEqual(r.parameters, l.parameters)) {
      issues.push({ kind: "parameters-drift", node: name });
    }
    const repoCredKey = JSON.stringify(canon(normaliseCredentials(r.credentials)));
    const liveCredKey = JSON.stringify(canon(normaliseCredentials(l.credentials)));
    if (repoCredKey !== liveCredKey) {
      issues.push({ kind: "credentials-drift", node: name, repo: normaliseCredentials(r.credentials), live: normaliseCredentials(l.credentials) });
    }
  }

  if (!deepEqual(repo.connections || {}, live.connections || {})) {
    issues.push({ kind: "connections-drift" });
  }

  const repoSettings = pickAllowlisted(repo.settings);
  const liveSettings = pickAllowlisted(live.settings);
  if (!deepEqual(repoSettings, liveSettings)) {
    issues.push({ kind: "settings-drift", repo: repoSettings, live: liveSettings });
  }

  return issues;
}

const repoWorkflows = loadRepoWorkflows();
const report = { ok: true, snapshot: path.relative(repoRoot, snapshotPath), workflows: [] };

for (const { file, wf } of repoWorkflows) {
  const live = liveByName.get(wf.name);
  if (!live) {
    report.ok = false;
    report.workflows.push({ file, name: wf.name, status: "missing-on-live" });
    continue;
  }
  const issues = diffWorkflow(wf, live);
  if (!issues.length) {
    report.workflows.push({ file, name: wf.name, status: "parity", liveId: live.id });
  } else {
    report.ok = false;
    report.workflows.push({ file, name: wf.name, status: "drift", liveId: live.id, issues });
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
