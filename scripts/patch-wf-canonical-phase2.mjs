/**
 * Phase 2: insert Read sources_config; append canonical_signals build + upsert after Append normalized_terms.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wfPath = path.join(__dirname, "..", "n8n/wf_normalize_terms.json");

const CONTRACT_VERSION = "2026-05-01";

const buildCanonicalJsCode = `const CONTRACT_VERSION = ${JSON.stringify(CONTRACT_VERSION)};
function slugify(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}
function normalizeText(text) { return String(text || '').replace(/\\\\s+/g, ' ').trim(); }
function looksLikeJunk(term) {
  const t = String(term || '').trim();
  if (!t || t.length < 3 || t.length > 60) return true;
  if (/[A-Z]/.test(t) && !/\\\\s/.test(t)) return true;
  if (/[:{}<>]/.test(t)) return true;
  return false;
}
function hashDedupe(s) {
  let h = 0;
  const x = String(s || '');
  for (let i = 0; i < x.length; i++) { h = (h << 5) - h + x.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}
function tokenize(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9\\\\s]+/g, ' ').split(/\\\\s+/).filter(Boolean);
}
function deriveAudience(termLower) {
  const IDENTITY_WORDS = ["mom","dad","teacher","nurse","dog","cat","wife","husband","grandma","grandpa","auntie","uncle","sister","brother","friend","girl","guy","queen","king","boss","lover","fan","nerd","geek","pro","hero","rebel","doctor","lawyer","chef","baker","runner","hiker","gamer","reader","gardener","crafter"];
  const tk = new Set(tokenize(termLower));
  for (const t of IDENTITY_WORDS) { if (tk.has(t)) return { audience_tags: [t], primary_audience: t }; }
  return { audience_tags: [] };
}
function deriveSeasonality(termLower) {
  const OCCASION_WORDS = ["birthday","christmas","halloween","valentine","mother","father","wedding","anniversary","graduation","baby","shower","new year","easter","thanksgiving","holiday","party"];
  const tk = new Set(tokenize(termLower));
  for (const t of OCCASION_WORDS) { if (tk.has(t)) return { flags: [t], has_occasion: true }; }
  return { flags: [], has_occasion: false };
}
function deriveRisk(termLower) {
  const BRAND = ["disney","marvel","nfl","nba","mlb","nhl","taylor","swift","beyonce","kardashian","trump","biden","harry","styles","billie","eilish","pokemon","minecraft","roblox","fortnite","barbie","nike","adidas","supreme","gucci","nasa","ncaa"];
  const NEWS = ["election","war","shooting","flood","earthquake","covid","pandemic","terrorist","riot","protest","hostage"];
  const tk = new Set(tokenize(termLower));
  const hit = [];
  for (const t of BRAND) if (tk.has(t)) hit.push(t);
  if (hit.length) return { level: 'high', matched_terms: hit, has_high_risk: true };
  const n = [];
  for (const t of NEWS) if (tk.has(t)) n.push(t);
  if (n.length) return { level: 'moderate', matched_terms: n, has_high_risk: false };
  return { level: 'low', matched_terms: [], has_high_risk: false };
}

const rawSignals = $('Read raw_signals').all().map((it) => it.json || {}).filter((r) => String(r.signal_id || '').trim() && String(r.signal_id).trim() !== '__empty__');
const cfgRows = $('Read sources_config').all().map((it) => it.json || {});
const typeBySource = {};
for (const c of cfgRows) {
  const sn = String(c.source_name || '').trim();
  if (sn) typeBySource[sn] = String(c.source_type || 'unknown');
}
const sidecars = $('Build normalized terms').all().map((it) => it.json || {}).filter((j) => j.__sidecar || j.__noRows);
const sidecar = sidecars[sidecars.length - 1] || {};
const runMeta = sidecar.__runMeta || {};
const intakeRunId = runMeta.run_id || '';

const byCanon = new Map();
for (const raw of rawSignals) {
  const term = normalizeText(raw.term);
  if (looksLikeJunk(term)) continue;
  const sid = String(raw.signal_id || '').trim();
  if (!sid || sid === '__empty__') continue;
  const canonicalId = 'norm_' + slugify(term);
  if (!byCanon.has(canonicalId)) byCanon.set(canonicalId, { signal_ids: [], sources: [], observed: [] });
  const b = byCanon.get(canonicalId);
  b.signal_ids.push(sid);
  b.sources.push(String(raw.source || '').trim());
  b.observed.push(raw.date_collected);
}

const normRows = $('Filter normalized rows').all().map((it) => it.json || {}).filter((j) => j.canonical_id);
const out = [];
for (const row of normRows) {
  const canonicalId = String(row.canonical_id || '').trim();
  if (!canonicalId) continue;
  const dedupeKey = canonicalId.startsWith('norm_') ? canonicalId.slice(5) : canonicalId;
  const agg = byCanon.get(canonicalId) || { signal_ids: [], sources: [], observed: [] };
  const sources = agg.sources.filter(Boolean);
  const primarySource = sources[0] || 'google_trends';
  const sourceType = typeBySource[primarySource] || 'unknown';
  const termLower = String(row.canonical_term || dedupeKey || '').toLowerCase();
  const audience = deriveAudience(termLower);
  const season = deriveSeasonality(termLower);
  const risk = deriveRisk(termLower);
  const lineage = {
    raw_signal_ids: [...new Set(agg.signal_ids)],
    normalized_term_id: canonicalId,
    intake_run_id: intakeRunId,
  };
  const signalId = 'cs_' + hashDedupe(dedupeKey + '|' + CONTRACT_VERSION) + '_' + CONTRACT_VERSION;
  let observedAt = null;
  for (const o of agg.observed) {
    const d = new Date(o);
    if (Number.isFinite(d.getTime())) {
      if (!observedAt || d < observedAt) observedAt = d;
    }
  }
  out.push({
    signal_id: signalId,
    contract_version: CONTRACT_VERSION,
    source_type: sourceType,
    source_name: primarySource,
    source_record_id: null,
    intake_run_id: intakeRunId,
    observed_at: observedAt ? observedAt.toISOString() : null,
    ingested_at: new Date().toISOString(),
    normalized_topic: String(row.canonical_term || ''),
    normalized_niche: String(row.primary_category || ''),
    normalized_sub_niche: null,
    audience_hint: JSON.stringify(audience),
    product_type_hints: JSON.stringify([]),
    trend_metrics: JSON.stringify({ source_family_counts: {} }),
    sentiment_metrics: JSON.stringify(null),
    competition_metrics: JSON.stringify(null),
    seasonality_hint: JSON.stringify(season),
    enrichment: JSON.stringify(null),
    risk_flags: JSON.stringify(risk),
    quality_score: null,
    lineage: JSON.stringify(lineage),
    dedupe_key: dedupeKey,
    status: risk.has_high_risk ? 'quarantined' : 'ready',
  });
}
return [{ json: { canonical_signals_rows: out } }];`;

const upsertSql = `INSERT INTO canonical_signals (
  signal_id, contract_version, source_type, source_name, source_record_id, intake_run_id,
  observed_at, ingested_at, normalized_topic, normalized_niche, normalized_sub_niche,
  audience_hint, product_type_hints, trend_metrics, sentiment_metrics, competition_metrics,
  seasonality_hint, enrichment, risk_flags, quality_score, lineage, dedupe_key, status
)
SELECT
  signal_id, contract_version, source_type, source_name, source_record_id, intake_run_id,
  observed_at::timestamptz, ingested_at::timestamptz, normalized_topic, normalized_niche, normalized_sub_niche,
  audience_hint::jsonb, product_type_hints::jsonb, trend_metrics::jsonb, sentiment_metrics::jsonb, competition_metrics::jsonb,
  seasonality_hint::jsonb, enrichment::jsonb, risk_flags::jsonb, quality_score::numeric,
  lineage::jsonb, dedupe_key, status
FROM jsonb_to_recordset($1::jsonb) AS t(
  signal_id text, contract_version text, source_type text, source_name text, source_record_id text, intake_run_id text,
  observed_at text, ingested_at text, normalized_topic text, normalized_niche text, normalized_sub_niche text,
  audience_hint text, product_type_hints text, trend_metrics text, sentiment_metrics text, competition_metrics text,
  seasonality_hint text, enrichment text, risk_flags text, quality_score text, lineage text, dedupe_key text, status text
)
ON CONFLICT (dedupe_key, contract_version) DO UPDATE SET
  signal_id = EXCLUDED.signal_id,
  source_type = EXCLUDED.source_type,
  source_name = EXCLUDED.source_name,
  intake_run_id = EXCLUDED.intake_run_id,
  observed_at = EXCLUDED.observed_at,
  ingested_at = EXCLUDED.ingested_at,
  normalized_topic = EXCLUDED.normalized_topic,
  normalized_niche = EXCLUDED.normalized_niche,
  audience_hint = EXCLUDED.audience_hint,
  seasonality_hint = EXCLUDED.seasonality_hint,
  risk_flags = EXCLUDED.risk_flags,
  lineage = EXCLUDED.lineage,
  status = EXCLUDED.status,
  updated_at = NOW()`;

const data = JSON.parse(fs.readFileSync(wfPath, "utf8"));
const wf = data.find((w) => w.name === "wf_normalize_terms");
if (!wf) throw new Error("wf_normalize_terms missing");

const readSources = {
  parameters: {
    operation: "executeQuery",
    query: "SELECT source_name, source_type, enabled FROM sources_config",
    options: {},
  },
  id: "b2000002-0002-4002-8002-000000000037",
  name: "Read sources_config",
  type: "n8n-nodes-base.postgres",
  typeVersion: 2.6,
  position: [550, 0],
  credentials: { postgres: { name: "Postgres - POD Research" } },
};

const buildCanon = {
  parameters: {
    mode: "runOnceForAllItems",
    language: "javaScript",
    jsCode: buildCanonicalJsCode,
  },
  id: "b2000002-0002-4002-8002-000000000038",
  name: "Build canonical_signals rows",
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: [1540, 120],
};

const upsertCanon = {
  parameters: {
    operation: "executeQuery",
    query: upsertSql,
    options: {
      queryReplacement: "={{ JSON.stringify($json.canonical_signals_rows || []) }}",
    },
  },
  id: "b2000002-0002-4002-8002-000000000039",
  name: "Upsert canonical_signals",
  type: "n8n-nodes-base.postgres",
  typeVersion: 2.6,
  position: [1760, 120],
  credentials: { postgres: { name: "Postgres - POD Research" } },
};

wf.nodes.push(readSources, buildCanon, upsertCanon);

const conn = wf.connections;
conn["Read normalized_terms"] = {
  main: [[{ node: "Read sources_config", type: "main", index: 0 }]],
};
conn["Read sources_config"] = {
  main: [[{ node: "Build normalized terms", type: "main", index: 0 }]],
};
conn["Append normalized_terms"] = {
  main: [[{ node: "Build canonical_signals rows", type: "main", index: 0 }]],
};
conn["Build canonical_signals rows"] = {
  main: [[{ node: "Upsert canonical_signals", type: "main", index: 0 }]],
};

fs.writeFileSync(wfPath, JSON.stringify(data, null, 2), "utf8");
console.log("Phase 2 canonical patch applied:", wfPath);
