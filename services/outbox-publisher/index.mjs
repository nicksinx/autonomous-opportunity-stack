#!/usr/bin/env node
/**
 * Polls workflow_outbox and marks rows complete after a stub dispatch (stage_run_logs + console).
 * Uses FOR UPDATE SKIP LOCKED within a transaction.
 */
import pg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

dotenv.config({ path: path.join(repoRoot, ".env.postgres") });
dotenv.config({ path: path.join(repoRoot, ".env") });

const POLL_MS = Number(process.env.OUTBOX_POLL_MS || 2000);
const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS || 5);
const BATCH = Number(process.env.OUTBOX_BATCH || 25);

function pool() {
  const uri = process.env.DATABASE_URI || process.env.DATABASE_URI_ADMIN;
  if (!uri) {
    console.error("DATABASE_URI required");
    process.exit(1);
  }
  return new pg.Pool({ connectionString: uri, max: 4 });
}

async function dispatch(client, row) {
  const logId = `outbox_${row.event_id}`;
  await client.query(
    `INSERT INTO stage_run_logs (
      log_id, run_id, workflow_name, stage_name, event_type,
      started_at, ended_at, duration_ms, rows_in, rows_out,
      error_count, status, error_summary, attempt_number,
      parent_log_id, metadata_json
    ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 0, 1, 1, 0, $6, '', 1, NULL, $7::jsonb)
    ON CONFLICT DO NOTHING`,
    [
      logId,
      null,
      "outbox_publisher",
      "dispatch",
      "start",
      "success",
      JSON.stringify({
        event_id: row.event_id,
        aggregate_type: row.aggregate_type,
        schema_version: row.schema_version,
        outbox_event_type: row.event_type,
      }),
    ],
  );
  await client.query(
    `INSERT INTO stage_run_logs (
      log_id, run_id, workflow_name, stage_name, event_type,
      started_at, ended_at, duration_ms, rows_in, rows_out,
      error_count, status, error_summary, attempt_number,
      parent_log_id, metadata_json
    ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 0, 1, 1, 0, $6, '', 1, $7, $8::jsonb)
    ON CONFLICT DO NOTHING`,
    [
      `${logId}_end`,
      null,
      "outbox_publisher",
      "dispatch",
      "end",
      "success",
      logId,
      JSON.stringify({
        event_id: row.event_id,
        aggregate_type: row.aggregate_type,
        schema_version: row.schema_version,
        outbox_event_type: row.event_type,
      }),
    ],
  );
  console.info(
    JSON.stringify({
      published: true,
      event_id: row.event_id,
      event_type: row.event_type,
    }),
  );
}

async function cycle(p) {
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT event_id, aggregate_type, aggregate_id, event_type, payload, schema_version, retry_count
       FROM workflow_outbox
       WHERE status = 'pending' AND scheduled_at <= NOW()
       ORDER BY scheduled_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [BATCH],
    );
    for (const row of rows) {
      await client.query(
        `UPDATE workflow_outbox SET status = 'processing' WHERE event_id = $1`,
        [row.event_id],
      );
    }
    await client.query("COMMIT");

    for (const row of rows) {
      const c2 = await p.connect();
      try {
        await c2.query("BEGIN");
        await dispatch(c2, row);
        await c2.query(
          `UPDATE workflow_outbox SET status = 'complete', processed_at = NOW() WHERE event_id = $1`,
          [row.event_id],
        );
        await c2.query("COMMIT");
      } catch (e) {
        await c2.query("ROLLBACK").catch(() => {});
        const next = Number(row.retry_count || 0) + 1;
        const dead = next >= MAX_ATTEMPTS;
        await p.query(
          dead
            ? `UPDATE workflow_outbox SET status = 'deadletter', retry_count = $2 WHERE event_id = $1`
            : `UPDATE workflow_outbox SET status = 'pending', retry_count = $2 WHERE event_id = $1`,
          [row.event_id, next],
        );
        await p.query(
          `INSERT INTO stage_run_logs (
            log_id, run_id, workflow_name, stage_name, event_type,
            started_at, ended_at, duration_ms, rows_in, rows_out,
            error_count, status, error_summary, attempt_number,
            parent_log_id, metadata_json
          ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 0, 1, 0, 1, $6, $7, $8, NULL, $9::jsonb)
          ON CONFLICT DO NOTHING`,
          [
            `outbox_${row.event_id}_error_${Date.now()}`,
            null,
            "outbox_publisher",
            "dispatch",
            "error",
            dead ? "error" : "warn",
            String(e?.message || e),
            next,
            JSON.stringify({
              event_id: row.event_id,
              aggregate_type: row.aggregate_type,
              outbox_event_type: row.event_type,
              deadletter: dead,
            }),
          ],
        ).catch(() => {});
        console.error("outbox dispatch failed", row.event_id, e?.message || e);
      } finally {
        c2.release();
      }
    }
  } finally {
    client.release();
  }
}

async function main() {
  const p = pool();
  let stopping = false;
  const shutdown = async () => {
    stopping = true;
    await p.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  while (!stopping) {
    try {
      await cycle(p);
    } catch (e) {
      console.error("outbox cycle", e?.message || e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
