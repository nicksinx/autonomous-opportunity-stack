#!/usr/bin/env node
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
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

const executionId = process.argv[2];
const apiBase = (process.env.N8N_API_URL || process.env.N8N_BASE_URL || "").trim().replace(/\/+$/, "");
const apiKey = (process.env.N8N_API_KEY || "").trim();

if (!executionId) throw new Error("Usage: node n8n/stop-execution.mjs <executionId>");
if (!apiBase) throw new Error("N8N_API_URL / N8N_BASE_URL is missing");
if (!apiKey) throw new Error("N8N_API_KEY is missing");

const res = await fetch(`${apiBase}/api/v1/executions/${encodeURIComponent(executionId)}/stop`, {
  method: "POST",
  headers: { accept: "application/json", "X-N8N-API-KEY": apiKey },
});
const text = await res.text();
let payload;
try {
  payload = text ? JSON.parse(text) : null;
} catch {
  payload = { raw: text };
}
console.log(JSON.stringify({ executionId, status: res.status, ok: res.ok, payload }, null, 2));
if (!res.ok) process.exit(1);
