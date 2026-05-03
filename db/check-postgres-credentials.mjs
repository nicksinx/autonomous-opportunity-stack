#!/usr/bin/env node
/**
 * Verify Postgres credentials from env without printing passwords.
 *
 * Loads env in the same order as import-workflows.mjs:
 *   .env → .env.local → .env.postgres (later files only set keys still undefined).
 * Within each file, last assignment wins for duplicate keys.
 *
 * Tests each non-empty URI:
 *   DATABASE_URI        — typically pod_app
 *   DATABASE_URI_ADMIN  — typically pod_admin (optional)
 *
 * Usage:
 *   node db/check-postgres-credentials.mjs
 *   node db/check-postgres-credentials.mjs --json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
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

function maskConnectionString(uri) {
  try {
    const u = new URL(uri);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable URI)";
  }
}

async function tryConnect(label, uri) {
  const trimmed = (uri || "").trim();
  if (!trimmed) {
    return { label, skipped: true, ok: null, detail: "not set" };
  }
  const pool = new pg.Pool({ connectionString: trimmed, max: 1 });
  try {
    const res = await pool.query(
      "SELECT current_user AS user, current_database() AS database",
    );
    const row = res.rows[0];
    return {
      label,
      skipped: false,
      ok: true,
      detail: `user=${row.user} database=${row.database}`,
      maskedUri: maskConnectionString(trimmed),
    };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    return {
      label,
      skipped: false,
      ok: false,
      detail: msg,
      maskedUri: maskConnectionString(trimmed),
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main() {
  const json = process.argv.includes("--json");

  loadDotEnv(path.join(repoRoot, ".env"));
  loadDotEnv(path.join(repoRoot, ".env.local"));
  loadDotEnv(path.join(repoRoot, ".env.postgres"));

  const appUri = process.env.DATABASE_URI;
  const adminUri = process.env.DATABASE_URI_ADMIN;

  const results = await Promise.all([
    tryConnect("DATABASE_URI (app role)", appUri),
    tryConnect("DATABASE_URI_ADMIN (admin role)", adminUri),
  ]);

  const failures = results.filter((r) => !r.skipped && r.ok === false);
  const ran = results.filter((r) => !r.skipped);

  if (!ran.length) {
    const msg =
      "No Postgres URIs configured. Set DATABASE_URI and/or DATABASE_URI_ADMIN in .env or .env.postgres.";
    if (json) console.log(JSON.stringify({ ok: false, error: msg, results }, null, 2));
    else console.error(msg);
    process.exit(2);
  }

  if (json) {
    console.log(JSON.stringify({ ok: failures.length === 0, results }, null, 2));
  } else {
    console.log("Postgres credential checks\n");
    for (const r of results) {
      if (r.skipped) {
        console.log(`${r.label}: skipped (${r.detail})`);
        continue;
      }
      const line = r.ok ? "OK" : "FAILED";
      console.log(`${r.label}: ${line}`);
      console.log(`  URI (masked): ${r.maskedUri}`);
      console.log(`  ${r.ok ? "Connected as" : "Error"}: ${r.detail}`);
      console.log("");
    }
    if (failures.length) {
      console.error(`${failures.length} connection(s) failed.`);
      process.exit(1);
    }
    console.log("All configured URIs connected successfully.");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
