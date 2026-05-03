#!/usr/bin/env node
/**
 * Import all `n8n/wf_*.json` workflow files into a running n8n instance via
 * REST API.
 *
 * Strips fields that n8n's create endpoint rejects (`active`, `tags`, `meta`,
 * `pinData`, `versionId`, `versionCounter`, `triggerCount`, `shared`,
 * `activeVersion`, `activeVersionId`, `isArchived`, `createdAt`, `updatedAt`,
 * `id` on first import). When a workflow with the same name already exists,
 * updates it via PUT instead of creating a duplicate.
 *
 * Required env:
 *   N8N_API_URL  e.g. https://n8n.example.com   (or http://localhost:5678)
 *   N8N_API_KEY  Personal API key with workflow:write scope
 *
 * Usage:
 *   node n8n/import-workflows.mjs --dry-run
 *   node n8n/import-workflows.mjs
 *   node n8n/import-workflows.mjs --only wf_collect_trends.json
 */

import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  /** Last assignment for a key in the file wins (avoids placeholder lines shadowing real values). */
  const fromFile = new Map();
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
    fromFile.set(key, val);
  }
  for (const [key, val] of fromFile) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.join(repoRoot, ".env"));
loadDotEnv(path.join(repoRoot, ".env.local"));
loadDotEnv(path.join(repoRoot, ".env.postgres"));

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length) : null;

/** n8n base URL with scheme (new URL() requires http:// or https://). */
function normalizeN8nApiUrl(raw) {
  let s = (raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s;
}

const apiUrl = normalizeN8nApiUrl(process.env.N8N_API_URL || "");
const apiKey = (process.env.N8N_API_KEY || "").trim();
if (!dryRun) {
  if (!apiUrl) {
    console.error("missing N8N_API_URL env (e.g. http://127.0.0.1:5678)");
    process.exit(2);
  }
  try {
    new URL(`${apiUrl}/api/v1/workflows`);
  } catch {
    console.error(
      "invalid N8N_API_URL — use a full URL with scheme, e.g. http://127.0.0.1:5678",
    );
    process.exit(2);
  }
  if (!apiKey) {
    console.error("missing N8N_API_KEY env (n8n Settings → API)");
    process.exit(2);
  }
}

const STRIP_KEYS = [
  "active", "tags", "meta", "pinData", "versionId", "activeVersionId",
  "activeVersion", "versionCounter", "triggerCount", "shared", "isArchived",
  "createdAt", "updatedAt", "id",
  // n8n POST/PUT workflow schema rejects root-level description on some versions
  "description",
];

// n8n REST API (v1) only accepts a fixed set of settings keys; anything else
// (e.g. UI-only flags such as `availableInMCP`, `binaryMode`, `timeSavedMode`)
// triggers `request/body/settings must NOT have additional properties`.
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

function sanitize(wf) {
  const out = {};
  for (const k of Object.keys(wf)) {
    if (STRIP_KEYS.includes(k)) continue;
    out[k] = wf[k];
  }
  if (out.settings && typeof out.settings === "object") {
    const filtered = {};
    for (const k of Object.keys(out.settings)) {
      if (SETTINGS_ALLOWED.has(k)) filtered[k] = out.settings[k];
    }
    out.settings = filtered;
  }
  return out;
}

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: opts.method || "GET",
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(opts.headers || {}),
        },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 1000)}`));
          }
          if (!buf) return resolve(null);
          try { resolve(JSON.parse(buf)); }
          catch (_e) { resolve(buf); }
        });
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

const headers = () => ({ "X-N8N-API-KEY": apiKey });

async function listExistingByName() {
  const map = new Map();
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ limit: "250" });
    if (cursor) q.set("cursor", cursor);
    const data = await fetchJson(`${apiUrl}/api/v1/workflows?${q}`, { headers: headers() });
    const items = Array.isArray(data?.data) ? data.data : [];
    for (const w of items) if (w?.name) map.set(w.name, w);
    cursor = String(data?.nextCursor || "");
    if (!cursor) break;
  }
  return map;
}

function listFiles() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.startsWith("wf_") && f.endsWith(".json"))
    .filter((f) => (only ? f === only : true))
    .map((f) => path.join(__dirname, f))
    .sort();
}

async function importOne(wfRaw, existing) {
  const wf = sanitize(wfRaw);
  const existingItem = existing.get(wf.name);
  if (existingItem) {
    if (dryRun) return { action: "would-update", name: wf.name, id: existingItem.id };
    const updated = await fetchJson(
      `${apiUrl}/api/v1/workflows/${encodeURIComponent(existingItem.id)}`,
      { method: "PUT", headers: headers(), body: wf },
    );
    return { action: "updated", name: wf.name, id: updated?.id || existingItem.id };
  }
  if (dryRun) return { action: "would-create", name: wf.name };
  const created = await fetchJson(`${apiUrl}/api/v1/workflows`, {
    method: "POST", headers: headers(), body: wf,
  });
  return { action: "created", name: wf.name, id: created?.id };
}

async function main() {
  const files = listFiles();
  if (!files.length) {
    console.error("No wf_*.json files found");
    process.exit(1);
  }
  let existing = new Map();
  if (!dryRun) existing = await listExistingByName();

  const results = [];
  for (const fp of files) {
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    const list = Array.isArray(data) ? data : [data];
    for (const wf of list) {
      try {
        const r = await importOne(wf, existing);
        results.push({ file: path.basename(fp), ...r });
      } catch (e) {
        results.push({
          file: path.basename(fp), name: wf?.name, action: "error",
          error: String(e?.message || e),
        });
      }
    }
  }

  console.log(JSON.stringify({ apiUrl: dryRun ? "(dry-run)" : apiUrl, results }, null, 2));
  const errors = results.filter((r) => r.action === "error");
  process.exit(errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
