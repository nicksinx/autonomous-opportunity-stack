#!/usr/bin/env node
import fs from "fs";
import http from "http";
import https from "https";
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.join(repoRoot, ".env"));
loadDotEnv(path.join(repoRoot, ".env.local"));

const endpoint = (process.env.N8N_MCP_URL || "").trim();
const token = (process.env.N8N_MCP_TOKEN || "").trim();
if (!endpoint || !token) throw new Error("N8N_MCP_URL and N8N_MCP_TOKEN are required");

const url = new URL(endpoint);
const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} });
const requestImpl = url.protocol === "http:" ? http.request : https.request;

const response = await new Promise((resolve, reject) => {
  const req = requestImpl(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30000,
    },
    (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve({ statusCode: res.statusCode, text }));
    },
  );
  req.on("timeout", () => req.destroy(new Error("MCP request timeout")));
  req.on("error", reject);
  req.write(body);
  req.end();
});

function parseEnvelope(text) {
  for (const line of String(text || "").split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

const payload = parseEnvelope(response.text);
const tools = Array.isArray(payload?.result?.tools) ? payload.result.tools : [];
console.log(JSON.stringify({
  statusCode: response.statusCode,
  toolCount: tools.length,
  tools: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ? Object.keys(tool.inputSchema.properties || {}) : [],
  })),
}, null, 2));
