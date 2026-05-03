#!/usr/bin/env node
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const backupsDir = path.join(repoRoot, "backups", "n8n");

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
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = val;
  }
}

loadDotEnv(path.join(repoRoot, ".env"));
loadDotEnv(path.join(repoRoot, ".env.local"));

const label = process.argv[2] || "metadata";
const sheetId = process.env.SHEETS_ID || "1hw0ZBypwMfc8ivpQ-CQlhDfVJK9w5PqnageeIAzUdvE";
const token = (process.env.GOOGLE_SHEETS_TOKEN || "").trim();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(backupsDir, `step13-${label}-drive-metadata-${stamp}.json`);

if (!token) {
  const payload = { status: "TOKEN_MISSING", sheetId, generatedAt: new Date().toISOString() };
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ status: payload.status, artifact: outPath }, null, 2));
  process.exit(2);
}

const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sheetId)}`);
url.searchParams.set("fields", "id,name,modifiedTime,modifiedByMeTime,lastModifyingUser");

const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const text = await res.text();
let body;
try {
  body = text ? JSON.parse(text) : null;
} catch {
  body = { raw: text };
}

const payload = {
  status: res.ok ? "OK" : `HTTP_${res.status}`,
  httpStatus: res.status,
  generatedAt: new Date().toISOString(),
  sheetId,
  body,
};

fs.mkdirSync(backupsDir, { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({
  status: payload.status,
  artifact: outPath,
  modifiedTime: body?.modifiedTime || null,
  modifiedByMeTime: body?.modifiedByMeTime || null,
}, null, 2));

if (!res.ok) process.exit(res.status === 401 ? 3 : 1);
