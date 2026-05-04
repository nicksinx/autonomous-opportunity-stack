/**
 * Replay / rescoring invariant (Layer 2): one row per (opportunity_id, scoring_run_id).
 * Same candidate may have many scores — each replay uses a new scoring_run_id and appends
 * to opportunity_score; reusing a pair must violate UNIQUE (see LAYER2_DECISIONS replay_strategy).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(repoRoot, ".env.postgres") });
dotenv.config({ path: path.join(repoRoot, ".env") });

test("0009_layer2_entities.sql defines append-only score history key", () => {
  const sql = fs.readFileSync(
    path.join(repoRoot, "db/migrations/0009_layer2_entities.sql"),
    "utf8",
  );
  assert.match(sql, /uq_opportunity_score_run/);
  assert.match(sql, /UNIQUE \(opportunity_id, scoring_run_id\)/);
});

test("replay appends scores and rejects duplicate (opportunity_id, scoring_run_id)", async (t) => {
  const uri = (process.env.DATABASE_URI || "").trim();
  if (!uri) {
    t.skip("DATABASE_URI unset — skipping DB replay invariant check");
    return;
  }

  const pool = new pg.Pool({ connectionString: uri });
  const client = await pool.connect();
  const suffix = `replay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const canonicalId = `norm_${suffix}`;

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = intake, scoring, workflow, analytics, public");

    await client.query(
      `INSERT INTO normalized_terms (canonical_id, canonical_term, status)
       VALUES ($1, $2, 'active')`,
      [canonicalId, `replay test term ${suffix}`],
    );

    const candRes = await client.query(
      `INSERT INTO opportunity_candidate (
         candidate_version, title, primary_niche, risk_level, readiness_status, canonical_id
       ) VALUES ('1', $1, 'test_niche', 'low', 'new', $2)
       RETURNING opportunity_id`,
      [`Replay test ${suffix}`, canonicalId],
    );
    const opportunityId = candRes.rows[0].opportunity_id;

    const run1 = await client.query(
      `INSERT INTO scoring_runs (trigger_type, scoring_version, scope, status)
       VALUES ('replay', '1.0.0', '{}'::jsonb, 'success')
       RETURNING scoring_run_id`,
    );
    const run2 = await client.query(
      `INSERT INTO scoring_runs (trigger_type, scoring_version, scope, status)
       VALUES ('replay', '1.0.0', '{}'::jsonb, 'success')
       RETURNING scoring_run_id`,
    );
    const scoringRunId1 = run1.rows[0].scoring_run_id;
    const scoringRunId2 = run2.rows[0].scoring_run_id;

    await client.query(
      `INSERT INTO opportunity_score (
         opportunity_id, scoring_run_id, score_version, total_score, confidence_score,
         recommendation, summary_reason
       ) VALUES ($1, $2, '1.0.0', 50, 5, 'review', 'first run')`,
      [opportunityId, scoringRunId1],
    );
    await client.query(
      `INSERT INTO opportunity_score (
         opportunity_id, scoring_run_id, score_version, total_score, confidence_score,
         recommendation, summary_reason
       ) VALUES ($1, $2, '1.0.0', 60, 6, 'review', 'replay run')`,
      [opportunityId, scoringRunId2],
    );

    const countRes = await client.query(
      `SELECT count(*)::int AS n FROM opportunity_score WHERE opportunity_id = $1`,
      [opportunityId],
    );
    assert.equal(countRes.rows[0].n, 2);

    await assert.rejects(
      client.query(
        `INSERT INTO opportunity_score (
           opportunity_id, scoring_run_id, score_version, total_score, confidence_score,
           recommendation, summary_reason
         ) VALUES ($1, $2, '1.0.0', 70, 7, 'review', 'duplicate same run')`,
        [opportunityId, scoringRunId1],
      ),
      (err) => err && err.code === "23505",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
});
