#!/usr/bin/env node
/**
 * Snapshot every n8n workflow on the live instance to a JSON file under
 * `backups/n8n/`.
 *
 * Required env: N8N_API_URL (or N8N_BASE_URL), N8N_API_KEY.
 * Usage: node n8n/snapshot-workflows.mjs [--out path]
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

const args = process.argv.slice(2);
const outArgIdx = args.indexOf("--out");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const defaultOut = path.join(repoRoot, "backups", "n8n", `snapshot-${stamp}.json`);
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
          "X-N8N-API-KEY": apiKey,
          ...(opts.headers || {}),
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
          try {
            resolve(JSON.parse(buf));
          } catch (_e) {
            resolve(buf);
          }
        });
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

async function listAll() {
  const all = [];
  let cursor = "";
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ limit: "250" });
    if (cursor) q.set("cursor", cursor);
    const data = await fetchJson(`${apiUrl}/api/v1/workflows?${q}`);
    const items = Array.isArray(data?.data) ? data.data : [];
    for (const w of items) all.push(w);
    cursor = String(data?.nextCursor || "");
    if (!cursor) break;
  }
  return all;
}

async function fetchFull(id) {
  return fetchJson(`${apiUrl}/api/v1/workflows/${encodeURIComponent(id)}`);
}

(async () => {
  const list = await listAll();
  const full = [];
  for (const w of list) {
    try {
      full.push(await fetchFull(w.id));
    } catch (e) {
      full.push({ id: w.id, name: w.name, error: String(e?.message || e) });
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(full, null, 2));
  console.log(JSON.stringify({ snapshot: outPath, count: full.length }, null, 2));
})().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
