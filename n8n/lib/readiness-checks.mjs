/**
 * Layer 2 readiness checks — pure data + small helpers.
 *
 * Each check is `{ id, section, category, title, run(ctx) -> Result }`
 * Result shape: `{ status, evidence, fixHint?, refs? }`
 *   status: pass | fail | partial | deferred | skipped | unknown
 *
 * Sections: must | should | defer | decision
 * Categories: schema | contract | workflow | observability | testing | service | docs | cleanup
 *
 * Helpers (`parseDecisions`, `extractDecisionRecords`) are exported for tests.
 */
import fs from "node:fs";
import path from "node:path";

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

export const STATUSES = ["pass", "fail", "partial", "deferred", "skipped", "unknown"];

/** Build a small ctx-bound helper bag. */
export function makeCtx({ pool, repoRoot, decisions, runTests, skipDb }) {
  return {
    pool,
    repoRoot,
    decisions,
    runTests: !!runTests,
    skipDb: !!skipDb,
    abs: (rel) => path.join(repoRoot, rel),
    exists: (rel) => fs.existsSync(path.join(repoRoot, rel)),
    read: (rel) => {
      const p = path.join(repoRoot, rel);
      try { return fs.readFileSync(p, "utf8"); } catch { return null; }
    },
    readJson: (rel) => {
      const raw = (() => { try { return fs.readFileSync(path.join(repoRoot, rel), "utf8"); } catch { return null; } })();
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
  };
}

function ok(evidence, refs) { return { status: "pass", evidence, refs: refs || [] }; }
function bad(evidence, fixHint, refs) { return { status: "fail", evidence, fixHint, refs: refs || [] }; }
function partial(evidence, fixHint, refs) { return { status: "partial", evidence, fixHint, refs: refs || [] }; }
function deferred(evidence, refs) { return { status: "deferred", evidence, refs: refs || [] }; }
function skipped(evidence) { return { status: "skipped", evidence, refs: [] }; }

// --------------------------------------------------------------------------
// Postgres helpers (no-op when ctx.pool is null)
// --------------------------------------------------------------------------

async function tableInfo(pool, name) {
  if (!pool) return null;
  const cols = await pool.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  if (!cols.rows.length) return { exists: false };
  return {
    exists: true,
    columns: new Map(cols.rows.map((r) => [r.column_name, r])),
    columnCount: cols.rows.length,
  };
}

async function viewExists(pool, name) {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = $1
     UNION SELECT 1 FROM pg_matviews WHERE schemaname = 'public' AND matviewname = $1`,
    [name],
  );
  return r.rows.length > 0;
}

async function relkind(pool, name) {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT relkind FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    [name],
  );
  return r.rows[0]?.relkind || null;
}

async function indexExists(pool, table, indexNameLike) {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1 AND indexname ILIKE $2`,
    [table, indexNameLike],
  );
  return r.rows.map((x) => x.indexname);
}

function normalizeConstraintColumnList(cols) {
  if (cols == null) return [];
  if (Array.isArray(cols)) return cols.map(String);
  if (typeof cols === "string") {
    const s = cols.trim();
    if (s.startsWith("{") && s.endsWith("}")) {
      const inner = s.slice(1, -1);
      if (!inner) return [];
      return inner.split(",").map((x) => x.replace(/^"|"$/g, "").trim());
    }
    return [cols];
  }
  return [];
}

async function uniqueOnColumns(pool, table, columns) {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT con.conname,
            ARRAY(SELECT a.attname
                    FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a
                      ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                   ORDER BY k.ord) AS cols
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1
        AND con.contype = 'u'`,
    [table],
  );
  const want = columns.slice().sort().join(",");
  return r.rows.some((row) => {
    const got = normalizeConstraintColumnList(row.cols)
      .slice()
      .sort()
      .join(",");
    return got === want;
  });
}

async function fkExists(pool, table, column) {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
      WHERE n.nspname = 'public' AND c.relname = $1
        AND con.contype = 'f' AND a.attname = $2`,
    [table, column],
  );
  return r.rows.length > 0;
}

async function checkConstraintMentions(pool, table, mustInclude) {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND con.contype = 'c'`,
    [table],
  );
  return r.rows.some((row) => mustInclude.every((tok) => String(row.def).includes(tok)));
}

// --------------------------------------------------------------------------
// LAYER2_DECISIONS.md parser
// --------------------------------------------------------------------------

const DECISION_KEYS = [
  "contract_version_policy",
  "identity_strategy",
  "replay_strategy",
  "state_machine_ownership",
  "outbox_consumer_model",
  "schema_namespacing",
  "compatibility_surface",
  "hard_block_risk_policy",
  "confidence_threshold",
  "clustering_strategy",
  "first_outbox_consumer",
  "vestigial_js_modules",
  "handedit_policy",
];

/** Split body into per-decision blocks based on `## decision: <id>` headings. */
export function extractDecisionRecords(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return new Map();
  const lines = markdown.split(/\r?\n/);
  const out = new Map();
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) {
      out.set(current, buf.join("\n").trim());
      buf = [];
    }
  };
  for (const line of lines) {
    const m = /^##\s+decision:\s*([a-z0-9_]+)\s*$/i.exec(line);
    if (m) {
      flush();
      current = m[1].toLowerCase();
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return out;
}

/** Parse a decision body (the lines under one `## decision: X` heading). */
export function parseDecisionBody(body) {
  const out = { status: null, owner: null, resolution: null, decided_at: null };
  if (!body) return out;
  for (const line of body.split(/\r?\n/)) {
    const m = /^([a-z_]+)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2];
    if (k in out) out[k] = v;
  }
  return out;
}

/** Top-level: returns Map<id, { status, owner, resolution, decided_at }>. */
export function parseDecisions(markdown) {
  const blocks = extractDecisionRecords(markdown);
  const out = new Map();
  for (const id of DECISION_KEYS) {
    out.set(id, parseDecisionBody(blocks.get(id) || ""));
  }
  return out;
}

// --------------------------------------------------------------------------
// MUST checks
// --------------------------------------------------------------------------

const mustChecks = [
  // ----- schema -----
  {
    id: "must.schema.canonical_signals_table",
    section: "must",
    category: "schema",
    title: "canonical_signals table with required columns and unique key",
    refs: [{ kind: "file", path: "db/migrations/0006_canonical_signals.sql" }],
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const t = await tableInfo(ctx.pool, "canonical_signals");
      if (!t?.exists) return bad("table missing", "Apply db/migrations/0006_canonical_signals.sql");
      const minCols = 22;
      const required = ["signal_id", "contract_version", "source_type", "source_name", "lineage", "dedupe_key", "status"];
      const missing = required.filter((c) => !t.columns.has(c));
      const uq = await uniqueOnColumns(ctx.pool, "canonical_signals", ["dedupe_key", "contract_version"]);
      const idx = (await indexExists(ctx.pool, "canonical_signals", "%status%")) || [];
      const evidence = `${t.columnCount} cols (>=${minCols}); UNIQUE(dedupe_key,contract_version)=${uq}; status idx=${idx.length > 0}`;
      if (missing.length) return bad(`missing columns: ${missing.join(", ")}`);
      if (t.columnCount < minCols) return partial(`only ${t.columnCount} cols, expected >= ${minCols}`, "Add missing spec §10.1 columns");
      if (uq === false) return bad(`UNIQUE (dedupe_key, contract_version) not present`, "ALTER TABLE canonical_signals ADD CONSTRAINT ...");
      return ok(evidence);
    },
  },
  {
    id: "must.schema.workflow_outbox_table",
    section: "must",
    category: "schema",
    title: "workflow_outbox table with status+scheduled index",
    refs: [{ kind: "file", path: "db/migrations/0007_workflow_outbox.sql" }],
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const t = await tableInfo(ctx.pool, "workflow_outbox");
      if (!t?.exists) return bad("table missing");
      const required = ["event_id", "aggregate_type", "aggregate_id", "event_type", "payload", "schema_version", "scheduled_at", "processed_at", "retry_count", "status"];
      const missing = required.filter((c) => !t.columns.has(c));
      if (missing.length) return bad(`missing columns: ${missing.join(", ")}`);
      const idxStatus = (await indexExists(ctx.pool, "workflow_outbox", "%status%scheduled%")) || [];
      const idxAgg = (await indexExists(ctx.pool, "workflow_outbox", "%aggregate%")) || [];
      const ev = `cols=${t.columnCount}; idx(status,scheduled)=${idxStatus.length > 0}; idx(aggregate)=${idxAgg.length > 0}`;
      if (!idxStatus.length || !idxAgg.length) return partial(ev, "Add the two indexes from spec §12.6");
      return ok(ev);
    },
  },
  {
    id: "must.schema.scoring_runs_table",
    section: "must",
    category: "schema",
    title: "scoring_runs table with trigger_type/status check constraints",
    refs: [{ kind: "file", path: "db/migrations/0008_scoring_runs.sql" }],
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const t = await tableInfo(ctx.pool, "scoring_runs");
      if (!t?.exists) return bad("table missing");
      const triggerCheck = await checkConstraintMentions(ctx.pool, "scoring_runs", ["trigger_type", "replay"]);
      const statusCheck = await checkConstraintMentions(ctx.pool, "scoring_runs", ["status", "running"]);
      const idx = (await indexExists(ctx.pool, "scoring_runs", "%status%")) || [];
      const ev = `cols=${t.columnCount}; trigger_type CHECK=${triggerCheck}; status CHECK=${statusCheck}; idx=${idx.length > 0}`;
      if (!triggerCheck || !statusCheck) return partial(ev, "Add CHECK constraints per spec §12.5");
      return ok(ev);
    },
  },
  {
    id: "must.schema.opportunity_score_runid_uniqueness",
    section: "must",
    category: "schema",
    title: "opportunity_score keyed by (opportunity_id, scoring_run_id), legacy retained",
    refs: [{ kind: "file", path: "db/migrations/0009_layer2_entities.sql" }, { kind: "file", path: "db/migrations/0010_legacy_compat_views.sql" }],
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const t = await tableInfo(ctx.pool, "opportunity_score");
      if (!t?.exists) return bad("opportunity_score table missing");
      const uq = await uniqueOnColumns(ctx.pool, "opportunity_score", ["opportunity_id", "scoring_run_id"]);
      const legacyKind = await relkind(ctx.pool, "opportunity_scores_legacy");
      const ev = `UNIQUE(opportunity_id,scoring_run_id)=${uq}; opportunity_scores_legacy.relkind=${legacyKind}`;
      if (!uq) return bad(ev, "ALTER TABLE opportunity_score ADD CONSTRAINT uq_opportunity_score_run UNIQUE(opportunity_id, scoring_run_id)");
      if (legacyKind !== "r") return partial(ev, "Confirm Option B applied — opportunity_scores_legacy should exist as a table");
      return ok(ev);
    },
  },
  {
    id: "must.schema.raw_signals_canonical_fk",
    section: "must",
    category: "schema",
    title: "raw_signals.canonical_id FK + idx_raw_signals_canonical",
    refs: [{ kind: "file", path: "db/migrations/0005_lineage_and_source_type.sql" }],
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const t = await tableInfo(ctx.pool, "raw_signals");
      if (!t?.exists) return bad("raw_signals missing");
      const hasCol = t.columns.has("canonical_id");
      const fk = hasCol ? await fkExists(ctx.pool, "raw_signals", "canonical_id") : false;
      const idx = (await indexExists(ctx.pool, "raw_signals", "%canonical%")) || [];
      const ev = `column=${hasCol}; FK=${fk}; idx=${idx.join(",") || "none"}`;
      if (!hasCol || !fk) return bad(ev, "Add column + FK per migration 0005");
      if (!idx.length) return partial(ev, "CREATE INDEX idx_raw_signals_canonical ON raw_signals(canonical_id)");
      return ok(ev);
    },
  },
  {
    id: "must.schema.sources_config_source_type",
    section: "must",
    category: "schema",
    title: "sources_config.source_type column + 6 expected mappings",
    refs: [{ kind: "file", path: "db/migrations/0005_lineage_and_source_type.sql" }],
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const t = await tableInfo(ctx.pool, "sources_config");
      if (!t?.exists) return bad("sources_config missing");
      if (!t.columns.has("source_type")) return bad("source_type column missing");
      const r = await ctx.pool.query("SELECT source_name, source_type FROM sources_config ORDER BY source_name");
      const expect = {
        google_trends: "search",
        pinterest_trends: "social",
        tiktok_creative: "social",
        etsy_autocomplete: "marketplace",
        amazon_movers: "marketplace",
        google_kw_planner: "search",
      };
      const have = Object.fromEntries(r.rows.map((row) => [row.source_name, row.source_type]));
      const wrong = Object.entries(expect).filter(([n, st]) => have[n] !== st).map(([n, st]) => `${n} expected=${st} got=${have[n] ?? "missing"}`);
      const ev = `${r.rows.length} rows; ${wrong.length} mismatches`;
      if (wrong.length) return partial(`${ev}: ${wrong.join("; ")}`, "Re-seed via 0005 / 0013 to align source_type");
      return ok(ev);
    },
  },

  // ----- contract -----
  {
    id: "must.contract.schema_file",
    section: "must",
    category: "contract",
    title: "db/contracts/canonical_signal_v1.json present and parses",
    refs: [{ kind: "file", path: "db/contracts/canonical_signal_v1.json" }],
    async run(ctx) {
      if (!ctx.exists("db/contracts/canonical_signal_v1.json")) return bad("file missing");
      const j = ctx.readJson("db/contracts/canonical_signal_v1.json");
      if (!j || typeof j !== "object") return bad("file present but not valid JSON");
      const required = j.required || j.requiredFields || j.properties;
      if (!required) return partial("JSON parses but no `required`/`properties` field", "Convert to JSON Schema with required fields");
      return ok(`parsed; keys=${Object.keys(j).join(",")}`);
    },
  },
  {
    id: "must.contract.validator_module",
    section: "must",
    category: "contract",
    title: "db/contract_validator.mjs exports validateCanonicalSignal",
    refs: [{ kind: "file", path: "db/contract_validator.mjs" }],
    async run(ctx) {
      if (!ctx.exists("db/contract_validator.mjs")) return bad("file missing");
      try {
        const mod = await import(ctx.abs("db/contract_validator.mjs"));
        if (typeof mod.validateCanonicalSignal !== "function") return bad("export missing");
        const r = mod.validateCanonicalSignal({});
        if (!r || typeof r.ok !== "boolean") return bad("validator returned bad shape");
        return ok(`validator returns {ok,reasons}; sample reasons=${(r.reasons || []).length}`);
      } catch (e) {
        return bad(`import threw: ${e.message}`);
      }
    },
  },
  {
    id: "must.contract.intake_writes_canonical",
    section: "must",
    category: "contract",
    title: "wf_normalize_terms writes canonical_signals",
    refs: [{ kind: "file", path: "n8n/wf_normalize_terms.json" }],
    async run(ctx) {
      const raw = ctx.read("n8n/wf_normalize_terms.json");
      if (!raw) return bad("workflow JSON missing");
      const has = /INSERT\s+INTO\s+canonical_signals|UPSERT\s+canonical_signals/i.test(raw);
      if (!has) return bad("no INSERT/UPSERT into canonical_signals", "Wire intake stage to populate canonical_signals (Phase 2)");
      return ok("INSERT/UPSERT canonical_signals SQL string found");
    },
  },
  {
    id: "must.contract.version_policy_documented",
    section: "must",
    category: "contract",
    title: "contract_version policy documented in db/README.md",
    refs: [{ kind: "file", path: "db/README.md" }],
    async run(ctx) {
      const raw = ctx.read("db/README.md");
      if (!raw) return bad("db/README.md missing");
      if (!/contract_version/i.test(raw)) return bad("no `contract_version` mention in db/README.md", "Document version stamping policy");
      return ok("contract_version mentioned in db/README.md");
    },
  },
  {
    id: "must.contract.source_type_seeded",
    section: "must",
    category: "contract",
    title: "sources_config seeded mapping correct (DB)",
    async run(ctx) {
      // This duplicates must.schema.sources_config_source_type for traceability; call shared check-style.
      if (!ctx.pool) return skipped("--skip-db");
      const r = await ctx.pool.query("SELECT source_name, source_type FROM sources_config ORDER BY source_name");
      const have = r.rows.map((row) => `${row.source_name}->${row.source_type}`).join(", ");
      const required = ["google_trends", "pinterest_trends", "tiktok_creative", "etsy_autocomplete", "amazon_movers", "google_kw_planner"];
      const missing = required.filter((n) => !r.rows.find((x) => x.source_name === n));
      if (missing.length) return bad(`missing seed: ${missing.join(", ")}`);
      return ok(have);
    },
  },

  // ----- workflow -----
  {
    id: "must.workflow.no_hardcoded_sources",
    section: "must",
    category: "workflow",
    title: "scorer hot path has no hardcoded source_name string switches",
    refs: [{ kind: "file", path: "n8n/build_score_and_cluster_workflow.mjs" }, { kind: "file", path: "n8n/layer2_score_code.js" }],
    async run(ctx) {
      const files = ["n8n/build_score_and_cluster_workflow.mjs", "n8n/layer2_score_code.js"];
      const offending = [];
      const sources = ["google_trends", "pinterest_trends", "tiktok_creative", "amazon_movers", "etsy_autocomplete"];
      for (const f of files) {
        const raw = ctx.read(f);
        if (!raw) continue;
        for (const s of sources) {
          // Allow occurrences inside SQL strings that look like sources_config seed comments / WHERE source = 'X'
          // Heuristic: flag JS-level switch usages: `signalSources.has('X')` / `=== 'X'` / `.filter(... 'X')`
          const switchLike = new RegExp(`\\.(has|includes)\\(['\"]${s}['\"]\\)|===\\s*['\"]${s}['\"]|filter\\([^)]*['\"]${s}['\"]`, "g");
          const matches = raw.match(switchLike) || [];
          if (matches.length) offending.push(`${f}: ${matches.join(" | ")}`);
        }
      }
      if (offending.length) return bad(`hardcoded source switches: ${offending.length}`, "Replace with canonical_signals.source_type lookups", offending.map((s) => ({ kind: "match", text: s })));
      return ok("no JS-level source-name switches in scorer hot path");
    },
  },
  {
    id: "must.workflow.cluster_members_written",
    section: "must",
    category: "workflow",
    title: "wf_score_and_cluster writes cluster_members_v2",
    refs: [{ kind: "file", path: "n8n/wf_score_and_cluster.json" }],
    async run(ctx) {
      const raw = ctx.read("n8n/wf_score_and_cluster.json");
      if (!raw) return bad("wf_score_and_cluster.json missing");
      if (!/INSERT\s+INTO\s+cluster_members_v2/i.test(raw)) return bad("no INSERT INTO cluster_members_v2", "Add cluster_members_v2 insert in score+cluster builder");
      let dbHint = "";
      if (ctx.pool) {
        const tv2 = await ctx.pool.query("SELECT COUNT(*)::int AS n FROM trend_cluster_v2").catch(() => ({ rows: [{ n: 0 }] }));
        const cm2 = await ctx.pool.query("SELECT COUNT(*)::int AS n FROM cluster_members_v2").catch(() => ({ rows: [{ n: 0 }] }));
        const tn = Number(tv2.rows[0]?.n || 0);
        const cn = Number(cm2.rows[0]?.n || 0);
        dbHint = `; trend_cluster_v2=${tn}, cluster_members_v2=${cn}`;
        if (tn > 0 && cn === 0) return partial(`SQL present${dbHint}`, "trend_cluster_v2 has rows but cluster_members_v2 is empty — verify writer transaction");
      }
      return ok(`INSERT INTO cluster_members_v2 present${dbHint}`);
    },
  },
  {
    id: "must.workflow.scoring_run_per_execution",
    section: "must",
    category: "workflow",
    title: "wf_score_and_cluster opens one scoring_runs row per execution",
    refs: [{ kind: "file", path: "n8n/wf_score_and_cluster.json" }],
    async run(ctx) {
      const raw = ctx.read("n8n/wf_score_and_cluster.json");
      if (!raw) return bad("wf_score_and_cluster.json missing");
      const ins = /INSERT\s+INTO\s+scoring_runs/i.test(raw);
      const ret = /RETURNING\s+scoring_run_id/i.test(raw);
      if (!ins || !ret) return bad(`INSERT scoring_runs=${ins}; RETURNING scoring_run_id=${ret}`);
      let dbHint = "";
      if (ctx.pool) {
        const recent = await ctx.pool.query(
          "SELECT COUNT(*)::int AS n FROM scoring_runs WHERE started_at >= NOW() - INTERVAL '7 days'",
        ).catch(() => ({ rows: [{ n: 0 }] }));
        dbHint = `; scoring_runs(7d)=${recent.rows[0]?.n}`;
      }
      return ok(`scoring_runs INSERT + RETURNING present${dbHint}`);
    },
  },
  {
    id: "must.workflow.outbox_events_in_scorer",
    section: "must",
    category: "workflow",
    title: "wf_score_and_cluster emits workflow_outbox events",
    refs: [{ kind: "file", path: "n8n/wf_score_and_cluster.json" }],
    async run(ctx) {
      const raw = ctx.read("n8n/wf_score_and_cluster.json");
      if (!raw) return bad("wf_score_and_cluster.json missing");
      if (!/INSERT\s+INTO\s+workflow_outbox/i.test(raw)) return bad("no INSERT INTO workflow_outbox in scorer");
      let dbHint = "";
      if (ctx.pool) {
        const r = await ctx.pool.query(
          `SELECT event_type, COUNT(*)::int AS n
             FROM workflow_outbox
            WHERE scheduled_at >= NOW() - INTERVAL '7 days'
            GROUP BY event_type`,
        ).catch(() => ({ rows: [] }));
        const byType = Object.fromEntries(r.rows.map((x) => [x.event_type, Number(x.n)]));
        dbHint = `; outbox(7d)=${JSON.stringify(byType)}`;
        if (r.rows.length === 0) {
          return partial(`SQL present${dbHint}`, "No outbox events in last 7d — run wf_score_and_cluster to verify");
        }
      }
      return ok(`SQL present${dbHint}`);
    },
  },
  {
    id: "must.workflow.no_mirror_writes",
    section: "must",
    category: "workflow",
    title: "no dual_write_mirror_log writes in any wf_*.json",
    async run(ctx) {
      const dir = ctx.abs("n8n");
      const offending = [];
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!/^wf_.*\.json$/.test(f)) continue;
          const raw = fs.readFileSync(path.join(dir, f), "utf8");
          if (/dual_write_mirror_log/.test(raw)) offending.push(f);
        }
      } catch (e) {
        return bad(`cannot scan n8n/: ${e.message}`);
      }
      if (offending.length) return bad(`writes still present in: ${offending.join(", ")}`, "Strip dual_write_mirror_log writes from these workflows");
      return ok("no wf_*.json file mentions dual_write_mirror_log");
    },
  },
  {
    id: "must.workflow.publish_queue_consumes_outbox",
    section: "must",
    category: "workflow",
    title: "wf_publish_queue reads from workflow_outbox; no fallback_scores CTE",
    refs: [{ kind: "file", path: "n8n/wf_publish_queue.json" }],
    async run(ctx) {
      const raw = ctx.read("n8n/wf_publish_queue.json");
      if (!raw) return bad("wf_publish_queue.json missing");
      const usesOutbox = /workflow_outbox/.test(raw) && /opportunity_approved_for_creative/.test(raw);
      const hasFallback = /fallback_scores/i.test(raw);
      if (!usesOutbox) return bad("wf_publish_queue does not reference workflow_outbox + opportunity_approved_for_creative", "Switch publish queue source to outbox per Phase 4");
      if (hasFallback) return partial("outbox source present, but legacy fallback_scores CTE remains", "Remove fallback_scores CTE");
      return ok("wf_publish_queue reads outbox, no fallback_scores");
    },
  },
  {
    id: "must.workflow.outbox_publisher_present",
    section: "must",
    category: "workflow",
    title: "services/outbox-publisher exists and npm script registered",
    refs: [{ kind: "file", path: "services/outbox-publisher/index.mjs" }, { kind: "file", path: "package.json" }],
    async run(ctx) {
      if (!ctx.exists("services/outbox-publisher/index.mjs")) return bad("services/outbox-publisher/index.mjs missing");
      const pkg = ctx.readJson("package.json");
      const has = !!pkg?.scripts?.["outbox:publish"];
      if (!has) return bad("npm script outbox:publish missing");
      return ok("publisher and npm run outbox:publish present");
    },
  },

  // ----- observability -----
  ...buildViewChecks([
    "v_canonical_signal_health",
    "v_scoring_run_health",
    "v_workflow_outbox_health",
    "v_lineage_explorer",
    "v_score_factor_breakdown",
    "v_review_queue",
    "v_approved_opportunities",
  ], "must"),
  {
    id: "must.observability.phase1_gate_extended",
    section: "must",
    category: "observability",
    title: "phase1-gate.mjs REQUIRED_TABLES includes Layer 2 entities",
    refs: [{ kind: "file", path: "n8n/phase1-gate.mjs" }],
    async run(ctx) {
      const raw = ctx.read("n8n/phase1-gate.mjs");
      if (!raw) return bad("phase1-gate.mjs missing");
      const required = ["canonical_signals", "workflow_outbox", "scoring_runs", "opportunity_candidate", "opportunity_score", "opportunity_score_factor", "trend_cluster_v2"];
      const missing = required.filter((t) => !new RegExp(`name:\\s*['\"]${t}['\"]`).test(raw));
      if (missing.length) return bad(`REQUIRED_TABLES missing: ${missing.join(", ")}`, "Add entries to REQUIRED_TABLES in phase1-gate.mjs");
      return ok(`REQUIRED_TABLES contains all ${required.length} Layer 2 tables`);
    },
  },
  {
    id: "must.observability.gates_7_and_8_implemented",
    section: "must",
    category: "observability",
    title: "phase1-gate.mjs defines gate7CheckOutboxHealth + gate8CheckCanonicalSignalContract",
    refs: [{ kind: "file", path: "n8n/phase1-gate.mjs" }],
    async run(ctx) {
      const raw = ctx.read("n8n/phase1-gate.mjs");
      if (!raw) return bad("phase1-gate.mjs missing");
      const g7 = /gate7CheckOutboxHealth/.test(raw);
      const g8 = /gate8CheckCanonicalSignalContract/.test(raw);
      if (!g7 || !g8) return bad(`gate7=${g7}; gate8=${g8}`);
      return ok("gate7 + gate8 defined");
    },
  },

  // ----- testing -----
  {
    id: "must.testing.contract_test",
    section: "must",
    category: "testing",
    title: "tests/contract.test.mjs present",
    refs: [{ kind: "file", path: "tests/contract.test.mjs" }],
    async run(ctx) {
      if (!ctx.exists("tests/contract.test.mjs")) return bad("tests/contract.test.mjs missing");
      return ok("contract test file present");
    },
  },
  {
    id: "must.testing.replay_invariant_test",
    section: "must",
    category: "testing",
    title: "replay invariant test (tests/replay.test.mjs)",
    async run(ctx) {
      if (!ctx.exists("tests/replay.test.mjs")) return partial("tests/replay.test.mjs not found", "Add a tests/replay.test.mjs that asserts (opportunity_id, scoring_run_id) appends rather than no-ops");
      return ok("replay test file present");
    },
  },
  {
    id: "must.testing.cycle_guard",
    section: "must",
    category: "testing",
    title: "n8n workflow cycle-guard validation",
    async run(ctx) {
      if (!ctx.runTests) return skipped("--run-tests not set");
      const r = await runNpm(ctx, ["run", "n8n:validate"]);
      return r.ok ? ok("npm run n8n:validate exited 0") : bad(`exit ${r.code}: ${r.stderr.slice(0, 240)}`);
    },
  },
  {
    id: "must.testing.npm_test_green",
    section: "must",
    category: "testing",
    title: "npm run test passes",
    async run(ctx) {
      if (!ctx.runTests) return skipped("--run-tests not set");
      const r = await runNpm(ctx, ["run", "test"]);
      return r.ok ? ok("npm run test exited 0") : bad(`exit ${r.code}: ${r.stderr.slice(0, 240)}`);
    },
  },
];

// --------------------------------------------------------------------------
// SHOULD checks
// --------------------------------------------------------------------------

const shouldChecks = [
  {
    id: "should.schema.first_class_risk_flags",
    section: "should",
    category: "schema",
    title: "canonical_signals has risk_flags / audience_hint / seasonality_hint as columns",
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const t = await tableInfo(ctx.pool, "canonical_signals");
      if (!t?.exists) return bad("canonical_signals missing");
      const want = ["risk_flags", "audience_hint", "seasonality_hint"];
      const missing = want.filter((c) => !t.columns.has(c));
      if (missing.length) return bad(`missing: ${missing.join(", ")}`);
      return ok(`all 3 columns present`);
    },
  },
  {
    id: "should.schema.confidence_score_column",
    section: "should",
    category: "schema",
    title: "opportunity_score.confidence_score (NOT NULL)",
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const t = await tableInfo(ctx.pool, "opportunity_score");
      if (!t?.exists) return bad("opportunity_score missing");
      const c = t.columns.get("confidence_score");
      if (!c) return bad("confidence_score column missing");
      const isNotNull = c.is_nullable === "NO";
      if (!isNotNull) return partial("confidence_score nullable", "ALTER COLUMN SET NOT NULL");
      return ok("confidence_score NOT NULL");
    },
  },
  {
    id: "should.schema.readiness_status_column",
    section: "should",
    category: "schema",
    title: "opportunity_candidate.readiness_status with 8 lifecycle states",
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const t = await tableInfo(ctx.pool, "opportunity_candidate");
      if (!t?.exists) return bad("opportunity_candidate missing");
      if (!t.columns.has("readiness_status")) return bad("readiness_status column missing");
      const wantStates = ["new", "ready_for_scoring", "scoring", "scored", "needs_review", "approved_for_creative", "rejected", "archived"];
      const allCovered = await checkConstraintMentions(ctx.pool, "opportunity_candidate", wantStates);
      if (!allCovered) return partial("CHECK does not enumerate all 8 states", "Update CHECK constraint per spec §13.1");
      return ok("CHECK covers 8 lifecycle states");
    },
  },
  {
    id: "should.schema.factor_reason_evidence_refs",
    section: "should",
    category: "schema",
    title: "opportunity_score_factor has factor_reason + evidence",
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const t = await tableInfo(ctx.pool, "opportunity_score_factor");
      if (!t?.exists) return bad("opportunity_score_factor missing");
      const want = ["factor_reason", "evidence"];
      const missing = want.filter((c) => !t.columns.has(c));
      if (missing.length) return bad(`missing: ${missing.join(", ")}`);
      return ok("factor_reason + evidence present");
    },
  },
  {
    id: "should.workflow.outbox_driven_inter_workflow",
    section: "should",
    category: "workflow",
    title: "downstream workflows are outbox-driven, not cron-only",
    async run(ctx) {
      const pq = ctx.read("n8n/wf_publish_queue.json") || "";
      const briefs = ctx.read("n8n/wf_generate_range_briefs_and_phrase_expansion.json") || "";
      const pqOutbox = /workflow_outbox/.test(pq);
      const briefsApproved = /v_approved_opportunities|workflow_outbox/.test(briefs);
      if (pqOutbox && briefsApproved) return ok("publish_queue + briefs both consume outbox/approved view");
      if (pqOutbox || briefsApproved) return partial(`pq=${pqOutbox}; briefs=${briefsApproved}`, "Wire briefs to v_approved_opportunities or outbox");
      return bad("neither downstream workflow consumes outbox/approved view");
    },
  },
  {
    id: "should.workflow.no_handedits_helper",
    section: "should",
    category: "workflow",
    title: "n8n/_apply_pg_handedits.mjs absent",
    async run(ctx) {
      if (ctx.exists("n8n/_apply_pg_handedits.mjs")) return bad("file still present", "Delete n8n/_apply_pg_handedits.mjs once hand-edits folded into builders");
      return ok("file removed");
    },
  },
  {
    id: "should.workflow.vestigial_js_archived",
    section: "should",
    category: "workflow",
    title: "11 vestigial CommonJS modules moved under archive/legacy-modules/",
    async run(ctx) {
      const modules = [
        "scoringEngine.js", "opportunityBuilder.js", "clusterScoringEngine.js", "clusterMergeSplit.js",
        "clusterHistoryTracker.js", "clusteringPayloadBuilder.js", "weightCalibrator.js", "scoringConfigLoader.js",
        "normalizationAuditor.js", "observabilityEnvelope.js", "sourceContractValidator.js",
      ];
      const stillRoot = modules.filter((m) => ctx.exists(m));
      const archived = modules.filter((m) => ctx.exists(`archive/legacy-modules/${m}`));
      if (stillRoot.length) return bad(`still at root: ${stillRoot.join(", ")}`, "git mv into archive/legacy-modules/");
      if (archived.length < modules.length) return partial(`archived ${archived.length}/${modules.length}`, "Some modules missing from archive");
      return ok(`all ${modules.length} modules archived`);
    },
  },
  {
    id: "should.compat.trend_scores_is_view",
    section: "should",
    category: "schema",
    title: "trend_scores is a view; trend_scores_legacy is the table",
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const tsKind = await relkind(ctx.pool, "trend_scores");
      const legKind = await relkind(ctx.pool, "trend_scores_legacy");
      const ev = `trend_scores=${tsKind}; trend_scores_legacy=${legKind}`;
      if (tsKind === "v" && legKind === "r") return ok(ev);
      return partial(ev, "Apply Option B: rename original to *_legacy and create view");
    },
  },
  {
    id: "should.observability.score_distribution_views",
    section: "should",
    category: "observability",
    title: "score-distribution-by-source-family view present",
    async run(ctx) {
      if (ctx.exists("db/views/v_score_distribution_by_source_family.sql")) return ok("view file present");
      return partial("view missing", "Add db/views/v_score_distribution_by_source_family.sql for spec §22");
    },
  },
  {
    id: "should.observability.deadletter_alerting",
    section: "should",
    category: "observability",
    title: "v_workflow_outbox_health exposes deadletter_count",
    async run(ctx) {
      const raw = ctx.read("db/views/v_workflow_outbox_health.sql");
      if (!raw) return bad("view file missing");
      if (!/deadletter/i.test(raw)) return partial("view defined but no deadletter column", "Add deadletter_count to v_workflow_outbox_health");
      return ok("view exposes deadletter signal");
    },
  },
];

// --------------------------------------------------------------------------
// DEFER checks (informational; never fail the gate)
// --------------------------------------------------------------------------

const deferChecks = [
  {
    id: "defer.api.fastify_server",
    section: "defer",
    category: "service",
    title: "Layer 2 HTTP API server with required routes",
    async run(ctx) {
      const raw = ctx.read("services/api/server.mjs");
      if (!raw) return deferred("services/api/server.mjs not present");
      const wantRoutes = [
        /\.post\(\s*["']\/scoring\/runs/, /\.post\(\s*["']\/scoring\/replay/,
        /\.get\(\s*["']\/opportunities\/:id["']/, /\.get\(\s*["']\/opportunities\/:id\/scores/,
        /\.get\(\s*["']\/opportunities["']/,
      ];
      const missing = wantRoutes.filter((r) => !r.test(raw)).map((r) => r.toString());
      if (missing.length) return partial(`routes missing: ${missing.length}`, "Add the missing route(s)");
      return ok("all 5 spec §19.3 routes declared");
    },
  },
  {
    id: "defer.api.token_auth",
    section: "defer",
    category: "service",
    title: "API token auth via LAYER2_API_TOKEN",
    async run(ctx) {
      const raw = ctx.read("services/api/server.mjs");
      if (!raw) return deferred("API not present");
      if (!/LAYER2_API_TOKEN/.test(raw)) return partial("LAYER2_API_TOKEN not referenced", "Add bearer-token check in onRequest hook");
      return ok("LAYER2_API_TOKEN referenced");
    },
  },
  {
    id: "defer.cluster.deterministic_engine",
    section: "defer",
    category: "service",
    title: "Deterministic clustering engine (services/cluster-engine + flag)",
    async run(ctx) {
      const svc = ctx.exists("services/cluster-engine/index.mjs");
      const lib = ctx.exists("n8n/lib/clusterer.mjs");
      const code = ctx.read("n8n/cluster_code.js") || "";
      const flagAware = /CLUSTER_ENGINE/.test(code);
      if (!svc) return deferred("services/cluster-engine not present");
      if (!lib || !flagAware) return partial(`svc=${svc}; lib=${lib}; flag=${flagAware}`, "Add CLUSTER_ENGINE env switch in n8n cluster code");
      return ok("services/cluster-engine + lib + CLUSTER_ENGINE flag present");
    },
  },
  {
    id: "defer.cluster.strategy_view",
    section: "defer",
    category: "observability",
    title: "v_cluster_strategy_comparison view present",
    async run(ctx) {
      if (ctx.exists("db/views/v_cluster_strategy_comparison.sql")) return ok("view file present");
      return deferred("view file not present");
    },
  },
  {
    id: "defer.weights.calibrator",
    section: "defer",
    category: "service",
    title: "Weight calibrator (service + history table + view)",
    async run(ctx) {
      const svc = ctx.exists("services/weight-calibrator/index.mjs");
      const mig = ctx.exists("db/migrations/0011_score_weight_history.sql");
      const view = ctx.exists("db/views/v_score_weight_history.sql");
      if (!svc) return deferred("services/weight-calibrator not present");
      if (!mig || !view) return partial(`svc=${svc}; mig=${mig}; view=${view}`, "Add migration and view if missing");
      return ok("calibrator + migration + view all present");
    },
  },
  {
    id: "defer.review.ui",
    section: "defer",
    category: "service",
    title: "Review queue (UI route + lifecycle log + view)",
    async run(ctx) {
      const raw = ctx.read("services/api/server.mjs") || "";
      const route = /\.get\(\s*["']\/review/.test(raw);
      const dec = /\.post\(\s*["']\/opportunities\/:id\/decision/.test(raw);
      const mig = ctx.exists("db/migrations/0012_opportunity_lifecycle_log.sql");
      const view = ctx.exists("db/views/v_lifecycle_history.sql");
      const all = route && dec && mig && view;
      if (all) return ok("review UI + decision route + lifecycle log + view present");
      if (route || dec || mig || view) return partial(`route=${route}; decision=${dec}; migration=${mig}; view=${view}`, "Wire missing parts");
      return deferred("review UI not present");
    },
  },
  {
    id: "defer.multi_source.csv",
    section: "defer",
    category: "service",
    title: "CSV importer + onboarding doc",
    async run(ctx) {
      const svc = ctx.exists("services/csv-importer/index.mjs");
      const map = ctx.exists("db/contracts/source-mappings/csv.json");
      const seed = ctx.exists("db/migrations/0013_seed_csv_source.sql");
      const doc = ctx.exists("docs/onboarding-a-new-source.md");
      if (svc && map && seed && doc) return ok("CSV importer + mapping + seed + doc present");
      if (svc || map || seed || doc) return partial(`svc=${svc}; map=${map}; seed=${seed}; doc=${doc}`, "Add the missing parts");
      return deferred("CSV multi-source not started");
    },
  },
  {
    id: "defer.cleanup.dual_write_mirror_table",
    section: "defer",
    category: "cleanup",
    title: "dual_write_mirror_log retired (renamed to *_legacy; drop candidate)",
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const live = await tableInfo(ctx.pool, "dual_write_mirror_log");
      const legacy = await tableInfo(ctx.pool, "dual_write_mirror_log_legacy");

      // Final state — the follow-up `0016` DROP migration has run.
      if (!live?.exists && !legacy?.exists) return ok("table dropped");

      // Mid-state — `0015_retire_dual_write_mirror_log.sql` has run; the live
      // name is gone and only the *_legacy table remains for forensics.
      if (!live?.exists && legacy?.exists) {
        const mr = await ctx.pool
          .query("SELECT MAX(created_at) AS m FROM dual_write_mirror_log_legacy")
          .catch(() => ({ rows: [{ m: null }] }));
        const last = mr.rows[0]?.m;
        const lastIso = last ? new Date(last).toISOString() : "never";
        return ok(`renamed to dual_write_mirror_log_legacy; last write: ${lastIso}`);
      }

      // Migration 0015 hasn't been applied yet — surface the un-renamed table.
      const mr = await ctx.pool
        .query("SELECT MAX(created_at) AS m FROM dual_write_mirror_log")
        .catch(() => ({ rows: [{ m: null }] }));
      const last = mr.rows[0]?.m;
      const lastIso = last ? new Date(last).toISOString() : "never";
      return deferred(
        `live table still present; last write: ${lastIso}. Apply 0015_retire_dual_write_mirror_log.sql to rename it.`,
      );
    },
  },
  {
    id: "defer.cleanup.dormant_cluster_tables",
    section: "defer",
    category: "cleanup",
    title: "Dormant cluster tables (cluster_history / cluster_review_queue / cluster_metrics)",
    async run(ctx) {
      if (!ctx.pool) return skipped("--skip-db");
      const counts = {};
      for (const t of ["cluster_history", "cluster_review_queue", "cluster_metrics"]) {
        const r = await ctx.pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`).catch(() => ({ rows: [{ n: -1 }] }));
        counts[t] = Number(r.rows[0]?.n);
      }
      return deferred(`row counts: ${JSON.stringify(counts)}`);
    },
  },
  {
    id: "defer.identity.uuid_canonical_id",
    section: "defer",
    category: "schema",
    title: "Replace slugify(term) canonical_id with UUID (Layer 2 v2)",
    async run() { return deferred("explicitly deferred per checklist"); },
  },
  {
    id: "defer.namespace.schemas",
    section: "defer",
    category: "schema",
    title: "Schema namespacing (intake./scoring./workflow./analytics.)",
    async run(ctx) {
      const dec = ctx.decisions?.get("schema_namespacing");
      if (dec?.status === "deferred") return deferred(`decision recorded as deferred (owner=${dec.owner || "?"})`);
      return deferred("not yet decided / not yet executed");
    },
  },
];

// --------------------------------------------------------------------------
// DECISION checks (parsed from LAYER2_DECISIONS.md)
// --------------------------------------------------------------------------

const decisionChecks = DECISION_KEYS.map((id) => ({
  id: `decision.${id}`,
  section: "decision",
  category: "docs",
  title: `Decision recorded: ${id}`,
  refs: [{ kind: "file", path: "LAYER2_DECISIONS.md" }],
  async run(ctx) {
    const dec = ctx.decisions?.get(id);
    if (!dec) return bad("decision block missing", "Add `## decision: " + id + "` section to LAYER2_DECISIONS.md");
    const { status, owner, resolution } = dec;
    const statusOk = ["resolved", "deferred"].includes(String(status || "").toLowerCase());
    if (!statusOk) return bad(`status=${status || "missing"}; owner=${owner || "?"}`, "Set status: resolved (or deferred) with owner + resolution");
    if (!owner || !resolution) return partial(`status=${status}; owner=${owner || "missing"}; resolution=${(resolution || "").slice(0, 60) || "missing"}`, "Provide owner and resolution");
    return ok(`status=${status}; owner=${owner}`);
  },
}));

// --------------------------------------------------------------------------
// View-check builder
// --------------------------------------------------------------------------

function buildViewChecks(views, section) {
  return views.map((v) => ({
    id: `${section}.observability.view_${v}`,
    section,
    category: "observability",
    title: `view ${v} present`,
    refs: [{ kind: "file", path: `db/views/${v}.sql` }],
    async run(ctx) {
      const fileOk = ctx.exists(`db/views/${v}.sql`);
      if (!ctx.pool) {
        return fileOk ? ok(`SQL file present (no DB)`) : bad("SQL file missing");
      }
      const dbOk = await viewExists(ctx.pool, v);
      if (!fileOk && !dbOk) return bad("view missing in repo and DB");
      if (fileOk && !dbOk) return partial("SQL present but view not loaded", "node db/run_migrations.mjs --views");
      return ok(`view exists in DB${fileOk ? " and repo" : ""}`);
    },
  }));
}

// --------------------------------------------------------------------------
// Test runner glue
// --------------------------------------------------------------------------

async function runNpm(ctx, args) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn("npm", args, { cwd: ctx.repoRoot, env: process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    child.on("error", (e) => resolve({ ok: false, code: -1, stdout, stderr: String(e) }));
  });
}

// --------------------------------------------------------------------------
// Public surface
// --------------------------------------------------------------------------

export const ALL_CHECKS = [
  ...mustChecks,
  ...shouldChecks,
  ...deferChecks,
  ...decisionChecks,
];

export function checksBySection(section) {
  return ALL_CHECKS.filter((c) => c.section === section);
}

export { DECISION_KEYS };
