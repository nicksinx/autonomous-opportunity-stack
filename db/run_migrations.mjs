#!/usr/bin/env node
/**
 * POD Trend Research — Postgres migration runner.
 *
 * Behavior:
 *   1. Connects with DATABASE_URI_ADMIN (admin role; default from .env.postgres.example).
 *   2. Ensures `_migrations` registry table exists (filename + applied_at).
 *   3. Applies each db/migrations/*.sql in lexical order, in a single transaction
 *      per file. Skips files already in `_migrations`.
 *   4. Re-applies db/views/*.sql idempotently (`CREATE OR REPLACE VIEW`), in a
 *      single transaction.
 *
 * Usage:
 *   node db/run_migrations.mjs           # apply pending migrations + views
 *   node db/run_migrations.mjs --status  # report applied vs pending
 *   node db/run_migrations.mjs --views   # only refresh views (no migrations)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Load env: prefer .env.postgres, fall back to .env.
dotenv.config({ path: path.join(repoRoot, ".env.postgres") });
dotenv.config({ path: path.join(repoRoot, ".env") });

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const VIEWS_DIR = path.join(__dirname, "views");

function parseArgs(argv) {
  return {
    status: argv.includes("--status"),
    viewsOnly: argv.includes("--views"),
  };
}

function listSqlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function readSql(dir, filename) {
  return fs.readFileSync(path.join(dir, filename), "utf8");
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum    TEXT
    );
  `);
}

async function listApplied(client) {
  const { rows } = await client.query(
    "SELECT filename FROM _migrations ORDER BY filename",
  );
  return new Set(rows.map((r) => r.filename));
}

async function applyMigration(client, filename, sql) {
  console.log(`  -> applying ${filename}`);
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query(
      "INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
      [filename],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

async function applyViews(client) {
  const files = listSqlFiles(VIEWS_DIR);
  if (!files.length) {
    console.log("(no view files in db/views/)");
    return;
  }
  console.log(`Refreshing ${files.length} view file(s)...`);
  await client.query("BEGIN");
  try {
    for (const f of files) {
      console.log(`  -> ${f}`);
      await client.query(readSql(VIEWS_DIR, f));
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uri =
    process.env.DATABASE_URI_ADMIN ||
    process.env.DATABASE_URI ||
    "";
  if (!uri) {
    console.error(
      "ERROR: DATABASE_URI_ADMIN (or DATABASE_URI) must be set. " +
        "See .env.postgres.example.",
    );
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: uri });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await listApplied(client);
    const all = listSqlFiles(MIGRATIONS_DIR);
    const pending = all.filter((f) => !applied.has(f));

    if (args.status) {
      console.log(`Applied (${applied.size}):`);
      for (const f of all) {
        if (applied.has(f)) console.log(`  [x] ${f}`);
      }
      console.log(`\nPending (${pending.length}):`);
      for (const f of pending) console.log(`  [ ] ${f}`);
      return;
    }

    if (!args.viewsOnly) {
      if (!pending.length) {
        console.log("No pending migrations.");
      } else {
        console.log(`Applying ${pending.length} migration(s)...`);
        for (const f of pending) {
          await applyMigration(client, f, readSql(MIGRATIONS_DIR, f));
        }
      }
    }

    await applyViews(client);
    console.log("OK");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
