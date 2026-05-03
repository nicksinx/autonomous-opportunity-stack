#!/usr/bin/env node
/**
 * CSV → canonical_signals (validated). Usage:
 *   node services/csv-importer/index.mjs path/to/file.csv
 *
 * Expects header row: topic (maps to normalized_topic & dedupe_key slug).
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import dotenv from "dotenv";
import { validateCanonicalSignal } from "../../db/contract_validator.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(root, ".env.postgres") });
dotenv.config({ path: path.join(root, ".env") });

const CONTRACT = "2026-05-01";
const SOURCE_NAME = "csv_upload";

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function signalIdFor(dedupe) {
  const h = crypto.createHash("sha256").update(`${dedupe}|${CONTRACT}`).digest("hex").slice(0, 16);
  return `cs_${h}_${CONTRACT}`;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const obj = {};
    headers.forEach((h, j) => {
      obj[h] = cols[j] ?? "";
    });
    rows.push(obj);
  }
  return { headers, rows };
}

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error("Usage: node services/csv-importer/index.mjs <file.csv>");
    process.exit(1);
  }
  const csvPath = path.resolve(process.cwd(), fileArg);
  const raw = fs.readFileSync(csvPath, "utf8");
  const { rows } = parseCsv(raw);

  const uri = process.env.DATABASE_URI || "";
  if (!uri) {
    console.error("DATABASE_URI required");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: uri });

  let inserted = 0;
  for (const r of rows) {
    const topic = String(r.topic || r.term || r.normalized_topic || "").trim();
    if (!topic) continue;
    const dk = slugify(topic);
    const row = {
      signal_id: signalIdFor(dk),
      contract_version: CONTRACT,
      source_type: "csv",
      source_name: SOURCE_NAME,
      source_record_id: dk,
      intake_run_id: `csv_${Date.now()}`,
      observed_at: new Date().toISOString(),
      ingested_at: new Date().toISOString(),
      normalized_topic: topic,
      normalized_niche: String(r.niche || "unknown"),
      normalized_sub_niche: null,
      audience_hint: {},
      product_type_hints: {},
      trend_metrics: {},
      sentiment_metrics: {},
      competition_metrics: {},
      seasonality_hint: {},
      enrichment: {},
      risk_flags: {},
      quality_score: null,
      lineage: { normalized_term_id: `norm_${dk}`, raw_signal_ids: [], intake_run_id: `csv_${Date.now()}` },
      dedupe_key: dk,
      status: "ready",
    };
    const v = validateCanonicalSignal(row);
    if (!v.ok) {
      console.warn("skip invalid row", dk, v.reasons);
      continue;
    }
    await pool.query(
      `INSERT INTO canonical_signals (
        signal_id, contract_version, source_type, source_name, source_record_id,
        intake_run_id, observed_at, ingested_at, normalized_topic, normalized_niche, normalized_sub_niche,
        audience_hint, product_type_hints, trend_metrics, sentiment_metrics, competition_metrics,
        seasonality_hint, enrichment, risk_flags, quality_score, lineage, dedupe_key, status
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,
        $17::jsonb,$18::jsonb,$19::jsonb,$20,$21::jsonb,$22,$23
      )
      ON CONFLICT (dedupe_key, contract_version) DO NOTHING`,
      [
        row.signal_id,
        row.contract_version,
        row.source_type,
        row.source_name,
        row.source_record_id,
        row.intake_run_id,
        row.observed_at,
        row.ingested_at,
        row.normalized_topic,
        row.normalized_niche,
        row.normalized_sub_niche,
        JSON.stringify(row.audience_hint),
        JSON.stringify(row.product_type_hints),
        JSON.stringify(row.trend_metrics),
        JSON.stringify(row.sentiment_metrics),
        JSON.stringify(row.competition_metrics),
        JSON.stringify(row.seasonality_hint),
        JSON.stringify(row.enrichment),
        JSON.stringify(row.risk_flags),
        row.quality_score,
        JSON.stringify(row.lineage),
        row.dedupe_key,
        row.status,
      ],
    );
    inserted++;
  }

  await pool.end();
  console.info(JSON.stringify({ ok: true, file: csvPath, rows_in: rows.length, inserted }));
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
