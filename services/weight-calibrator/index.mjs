#!/usr/bin/env node
/**
 * Uses aggregate marketplace outcomes (conversion_rate_pct) as a coarse signal.
 * Applies a bounded step to score_weights rows when enough feedback exists.
 */
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(root, ".env.postgres") });
dotenv.config({ path: path.join(root, ".env") });

const uri = process.env.DATABASE_URI || "";
const MIN_SAMPLES = Number(process.env.WEIGHT_CALIB_MIN_SAMPLES || 30);
const MAX_STEP = Number(process.env.WEIGHT_CALIB_MAX_STEP || 0.02);

if (!uri) {
  console.error("DATABASE_URI required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: uri });

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

async function main() {
  const client = await pool.connect();
  try {
    const stat = await client.query(`
      SELECT COUNT(*)::int AS n,
             AVG(conversion_rate_pct)::numeric AS avg_conv
      FROM performance_feedback
      WHERE conversion_rate_pct IS NOT NULL
        AND feedback_date >= CURRENT_DATE - INTERVAL '120 days'
    `);
    const n = Number(stat.rows[0]?.n || 0);
    const avgConv = Number(stat.rows[0]?.avg_conv || 0);

    if (n < MIN_SAMPLES) {
      console.info(
        JSON.stringify({
          ok: true,
          skipped: true,
          feedback_rows_with_conversion: n,
          min_required: MIN_SAMPLES,
        }),
      );
      return;
    }

    const target = clamp(avgConv / 100, 0.05, 0.35);
    const runId = crypto.randomUUID();
    let updates = 0;

    const dims = await client.query(`SELECT dimension, weight FROM score_weights WHERE enabled = TRUE`);
    const demand = dims.rows.find((r) => String(r.dimension) === "demand_strength");
    if (!demand) {
      console.info(JSON.stringify({ ok: true, skipped: true, reason: "no_demand_strength_row" }));
      return;
    }
    const dimension = "demand_strength";
    const oldW = Number(demand.weight);
    let newW = oldW + clamp(target - oldW, -MAX_STEP, MAX_STEP);
    if (newW < 0) newW = 0;

    await client.query(
      `INSERT INTO score_weight_history (dimension, prior_weight, new_weight, trigger_run_id, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [dimension, oldW, newW, runId, `avg_conversion_pct=${avgConv.toFixed(2)} samples=${n}`],
    );
    await client.query(`UPDATE score_weights SET weight = $2 WHERE dimension = $1`, [dimension, newW]);
    updates = 1;

    console.info(JSON.stringify({ ok: true, feedback_samples: n, avg_conversion_pct: avgConv, updates, runId }));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
