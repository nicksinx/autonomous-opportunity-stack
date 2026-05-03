#!/usr/bin/env node
/**
 * Build a node-type baseline report for live n8n workflows. Reads either the
 * live API or a snapshot file (--snapshot path).
 *
 * Output rows: { name, id, active, postgres, googleSheets, code, http,
 *                postgresCredentialNames }.
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

const args = process.argv.slice(2);
const snapArgIdx = args.indexOf("--snapshot");
const outArgIdx = args.indexOf("--out");
const snapshotFile = snapArgIdx >= 0 ? args[snapArgIdx + 1] : null;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const defaultOut = path.join(repoRoot, "backups", "n8n", `baseline-${stamp}.json`);
const outPath = outArgIdx >= 0 ? args[outArgIdx + 1] : defaultOut;

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
          "X-N8N-API-KEY": opts.apiKey || "",
        },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 800)}`));
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

async function loadFromApi() {
  const apiUrl = (process.env.N8N_API_URL || process.env.N8N_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = (process.env.N8N_API_KEY || "").trim();
  if (!apiUrl || !apiKey) throw new Error("missing N8N_API_URL/KEY");
  const all = [];
  let cursor = "";
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ limit: "250" });
    if (cursor) q.set("cursor", cursor);
    const data = await fetchJson(`${apiUrl}/api/v1/workflows?${q}`, { apiKey });
    const items = Array.isArray(data?.data) ? data.data : [];
    for (const w of items) all.push(w);
    cursor = String(data?.nextCursor || "");
    if (!cursor) break;
  }
  const full = [];
  for (const w of all) {
    full.push(await fetchJson(`${apiUrl}/api/v1/workflows/${encodeURIComponent(w.id)}`, { apiKey }));
  }
  return full;
}

function loadFromSnapshot(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function summarize(wf) {
  const nodes = Array.isArray(wf?.nodes) ? wf.nodes : [];
  let pg = 0, gs = 0, code = 0, http = 0;
  const pgCreds = new Set();
  for (const n of nodes) {
    const t = n?.type || "";
    if (t === "n8n-nodes-base.postgres") {
      pg += 1;
      const credName = n?.credentials?.postgres?.name;
      if (credName) pgCreds.add(credName);
    } else if (t === "n8n-nodes-base.googleSheets") {
      gs += 1;
    } else if (t === "n8n-nodes-base.code") {
      code += 1;
    } else if (t === "n8n-nodes-base.httpRequest") {
      http += 1;
    }
  }
  return {
    name: wf?.name,
    id: wf?.id,
    active: !!wf?.active,
    postgres: pg,
    googleSheets: gs,
    code,
    http,
    postgresCredentialNames: Array.from(pgCreds),
  };
}

(async () => {
  const data = snapshotFile ? loadFromSnapshot(snapshotFile) : await loadFromApi();
  const rows = data.map(summarize).filter((r) => r && r.name);
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const activeWf = rows.filter((r) => r.active);
  const activeWithGoogleSheets = activeWf.filter((r) => r.googleSheets > 0);
  const wfTargets = rows.filter((r) => /^wf_/.test(r.name || ""));
  const duplicates = (() => {
    const counts = new Map();
    for (const r of rows) {
      if (!r.active) continue;
      counts.set(r.name, (counts.get(r.name) || 0) + 1);
    }
    return Array.from(counts.entries()).filter(([, c]) => c > 1).map(([name, count]) => ({ name, count }));
  })();
  const summary = {
    source: snapshotFile ? `snapshot:${snapshotFile}` : "api:live",
    workflows: rows.length,
    activeWorkflows: activeWf.length,
    activeWithGoogleSheets: activeWithGoogleSheets.length,
    activeWfTargets: wfTargets.filter((r) => r.active).length,
    duplicateActiveNames: duplicates,
    rows,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({
    out: outPath,
    workflows: summary.workflows,
    activeWorkflows: summary.activeWorkflows,
    activeWithGoogleSheets: summary.activeWithGoogleSheets,
    duplicateActiveNames: summary.duplicateActiveNames,
  }, null, 2));
})().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
