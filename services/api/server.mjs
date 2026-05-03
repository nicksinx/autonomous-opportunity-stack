#!/usr/bin/env node
/**
 * Layer 2 HTTP API (spec §19.3) — Bearer token via LAYER2_API_TOKEN (except GET /healthz).
 */
import Fastify from "fastify";
import pg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(root, ".env.postgres") });
dotenv.config({ path: path.join(root, ".env") });

const TOKEN = process.env.LAYER2_API_TOKEN || "";

function pool() {
  const uri = process.env.DATABASE_URI || "";
  if (!uri) throw new Error("DATABASE_URI required");
  return new pg.Pool({ connectionString: uri });
}

const p = pool();
const app = Fastify({ logger: false });

app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/healthz" || req.url.startsWith("/healthz?")) return;
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : h;
  if (!TOKEN || tok !== TOKEN) {
    reply.code(401);
    return reply.send({ error: "unauthorized" });
  }
});

app.get("/healthz", async () => ({ ok: true }));

app.post("/scoring/runs", async (req, reply) => {
  const body = req.body || {};
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO scoring_runs (trigger_type, trigger_ref, scoring_version, scope, status)
       VALUES ('manual', $1, coalesce($2, '1.0.0'), coalesce($3::jsonb, '{}'::jsonb), 'pending')
       RETURNING scoring_run_id, status`,
      [body.trigger_ref || null, body.scoring_version || null, body.scope ? JSON.stringify(body.scope) : null],
    );
    const rid = rows[0].scoring_run_id;
    await client.query(
      `INSERT INTO workflow_outbox (aggregate_type, aggregate_id, event_type, payload, schema_version)
       VALUES ('scoring_run', $1, 'trend_batch_ready', $2::jsonb, 'v1')`,
      [String(rid), JSON.stringify({ scoring_run_id: rid, trigger: "manual" })],
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    reply.code(500);
    return { error: String(e.message || e) };
  } finally {
    client.release();
  }
});

app.post("/scoring/replay", async (req, reply) => {
  const body = req.body || {};
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO scoring_runs (trigger_type, trigger_ref, scoring_version, scope, status)
       VALUES ('replay', $1, coalesce($2, '1.0.0'), coalesce($3::jsonb, '{}'::jsonb), 'pending')
       RETURNING scoring_run_id, status`,
      [body.trigger_ref || null, body.scoring_version || null, body.scope ? JSON.stringify(body.scope) : null],
    );
    const rid = rows[0].scoring_run_id;
    await client.query(
      `INSERT INTO workflow_outbox (aggregate_type, aggregate_id, event_type, payload, schema_version)
       VALUES ('scoring_run', $1, 'trend_batch_ready', $2::jsonb, 'v1')`,
      [String(rid), JSON.stringify({ scoring_run_id: rid, trigger: "replay" })],
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    reply.code(500);
    return { error: String(e.message || e) };
  } finally {
    client.release();
  }
});

app.get("/opportunities", async (req) => {
  const st = (req.query || {}).status || "approved_for_creative";
  const { rows } = await p.query(
    `SELECT * FROM opportunity_candidate WHERE readiness_status = $1 ORDER BY updated_at DESC LIMIT 100`,
    [st],
  );
  return { items: rows };
});

app.get("/opportunities/:id", async (req, reply) => {
  const { rows: oc } = await p.query(`SELECT * FROM opportunity_candidate WHERE opportunity_id = $1`, [
    req.params.id,
  ]);
  if (!oc.length) return reply.code(404).send({ error: "not_found" });
  const { rows: sc } = await p.query(
    `SELECT * FROM opportunity_score WHERE opportunity_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [req.params.id],
  );
  const fac =
    sc.length > 0
      ? (await p.query(`SELECT * FROM opportunity_score_factor WHERE score_id = $1`, [sc[0].score_id])).rows
      : [];
  return { candidate: oc[0], latest_score: sc[0] || null, factors: fac };
});

app.get("/opportunities/:id/scores", async (req, reply) => {
  const { rows: oc } = await p.query(`SELECT opportunity_id FROM opportunity_candidate WHERE opportunity_id = $1`, [
    req.params.id,
  ]);
  if (!oc.length) return reply.code(404).send({ error: "not_found" });
  const { rows } = await p.query(
    `SELECT * FROM opportunity_score WHERE opportunity_id = $1 ORDER BY created_at DESC`,
    [req.params.id],
  );
  return { items: rows };
});

app.post("/opportunities/:id/decision", async (req, reply) => {
  const body = req.body || {};
  const decision = body.decision;
  const note = body.note || null;
  const statusMap = {
    approve: "approved_for_creative",
    reject: "rejected",
    review: "needs_review",
  };
  const to = statusMap[decision];
  if (!to) return reply.code(400).send({ error: "invalid_decision", allowed: Object.keys(statusMap) });

  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const { rows: cur } = await client.query(
      `SELECT readiness_status FROM opportunity_candidate WHERE opportunity_id = $1 FOR UPDATE`,
      [req.params.id],
    );
    if (!cur.length) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "not_found" });
    }
    await client.query(
      `INSERT INTO opportunity_lifecycle_log (opportunity_id, from_status, to_status, actor, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, cur[0].readiness_status, to, "api", note],
    );
    await client.query(`UPDATE opportunity_candidate SET readiness_status = $2, updated_at = NOW() WHERE opportunity_id = $1`, [
      req.params.id,
      to,
    ]);
    const evt =
      to === "approved_for_creative"
        ? "opportunity_approved_for_creative"
        : to === "rejected"
          ? "opportunity_rejected"
          : "opportunity_needs_review";
    await client.query(
      `INSERT INTO workflow_outbox (aggregate_type, aggregate_id, event_type, payload, schema_version)
       VALUES ('opportunity', $1, $2, $3::jsonb, 'v1')`,
      [req.params.id, evt, JSON.stringify({ from: cur[0].readiness_status, to, note })],
    );
    await client.query("COMMIT");
    return { ok: true, readiness_status: to };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

app.get("/review", async (req, reply) => {
  const { rows } = await p.query(
    `SELECT opportunity_id, title, primary_niche, risk_level, readiness_status, latest_score, latest_confidence, updated_at
     FROM v_review_queue ORDER BY updated_at DESC LIMIT 100`,
  );
  const rowsHtml = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.opportunity_id)}</td><td>${esc(r.title)}</td><td>${esc(r.readiness_status)}</td><td>${r.latest_score ?? ""}</td></tr>`,
    )
    .join("");
  reply.type("text/html");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Review queue</title></head><body>
<h1>Review queue</h1>
<table border="1" cellpadding="6"><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Score</th></tr></thead><tbody>${rowsHtml}</tbody></table>
<p>POST decision via API: <code>/opportunities/{id}/decision</code></p>
</body></html>`;
});

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

const port = Number(process.env.LAYER2_API_PORT || 3847);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.info(`Layer 2 API listening on ${port}`);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
