# POD Trend Research — Postgres data layer

Local Dockerised PostgreSQL backend for the POD Trend Research System. This
replaces the prior Google Sheets storage; see the parent [README](../README.md)
for the workflow / pipeline overview.

## Quick reference

| Command                         | What it does                                       |
| ------------------------------- | -------------------------------------------------- |
| `docker compose -f docker-compose.postgres.yml up -d` | Start the local-postgres container        |
| `npm run db:migrate`            | Apply pending SQL migrations + refresh views       |
| `node db/run_migrations.mjs --status` | Show applied vs pending migrations             |
| `node db/run_migrations.mjs --views`  | Reapply only the view definitions              |
| `npm run db:backfill`           | One-shot Sheets → Postgres backfill (parity report) |
| `npm run db:credentials-check` | Verify app/admin DB URIs connect (no password printed) |
| `npm run db:schema-columns`    | Verify Phase 1 tables match migration column baseline |
| `npm run db:psql`               | Open a psql shell as `pod_admin` inside the container |

## Prerequisites

1. Docker Desktop running.
2. Node.js ≥ 18.17 and `npm install` from the repo root (installs `pg`, `pg-format`, `dotenv`).
3. A `.env.postgres` file at the repo root. Copy [.env.postgres.example](../.env.postgres.example) and fill in real role passwords (see "Rotating role passwords" below). `.env.postgres` is git-ignored.
4. For the one-shot backfill only: `SHEETS_ID` and `GOOGLE_SHEETS_TOKEN` (sheets.readonly OAuth bearer) in `.env`.

## Container layout

The compose file `docker-compose.postgres.yml` starts a single `postgres:16`
service named `local-postgres`:

- DB:                 `pod_trends`
- Owner role:         `pod_admin`
- Application role:   `pod_app` (full CRUD on `public`)
- Listens on:         `127.0.0.1:5433` (host) → `5432` (container)
- Network:            `pod_local_net` (shared with `postgres-mcp` and any container-based n8n)

## Connection URIs

```
DATABASE_URI=postgresql://pod_app:<APP_PWD>@127.0.0.1:5433/pod_trends                # host -> container (host-mapped port)
DATABASE_URI=postgresql://pod_app:<APP_PWD>@local-postgres:5432/pod_trends           # container -> container on pod_local_net
DATABASE_URI_ADMIN=postgresql://pod_admin:<ADMIN_PWD>@127.0.0.1:5433/pod_trends      # admin (migrations + backfill)
```

`run_migrations.mjs` and `backfill_sheets_to_pg.mjs` both read
`DATABASE_URI_ADMIN` first (falling back to `DATABASE_URI`). n8n nodes use
`DATABASE_URI` (or the credential pointing at the same host:port and `pod_app`).

## Migration model

```
db/migrations/
  0001_init.sql                    -- all 25 tables (PKs, FKs, UNIQUEs, indexes, CHECKs, updated_at triggers)
  0002_seed_sources_config.sql     -- 6 seed rows for sources_config
  0003_seed_score_weights.sql      -- 9 seed rows for score_weights

db/views/
  v_dashboard_summary.sql          -- replaces the formula-driven dashboard tab + top-10 listing
  v_source_health_today.sql
  v_stage_run_health_24h.sql
  v_publish_queue_status.sql
  v_feedback_rollup.sql
```

`run_migrations.mjs` registers applied migrations in a `_migrations` table
(`filename`, `applied_at`). Pending files are applied in lex order, each in
its own transaction. Views are then re-applied with `CREATE OR REPLACE VIEW`,
so editing a view file and re-running the migrator is safe and idempotent.

To add a new migration, drop a new file under `db/migrations/` with a
strictly-increasing 4-digit prefix (e.g. `0004_add_funnel_table.sql`) and run
`npm run db:migrate`. **Do not edit migrations that have already been
applied** — write a follow-up file instead.

## `contract_version` on `canonical_signals`

Layer 2 stores a **single global** `contract_version` string on every row in
`canonical_signals` (for example `2026-05-01`). It identifies which version of
[`db/contracts/canonical_signal_v1.json`](../db/contracts/canonical_signal_v1.json)
the row was validated against. **Bump** `contract_version` only on **breaking**
changes: renaming or removing required fields, changing required semantics, or
changing the meaning of `dedupe_key`. Purely **additive** JSON fields may ship
without a version bump as long as validators accept unknown properties.
Per-source contract versions are **out of scope for v1**. The authoritative
policy notes live in [`LAYER2_DECISIONS.md`](../LAYER2_DECISIONS.md) under
`contract_version_policy`.

## Backfill (one-shot Sheets → Postgres)

`db/backfill_sheets_to_pg.mjs` reads each tab from the configured Sheet via
the Sheets API, type-coerces it, and bulk-inserts with
`ON CONFLICT DO NOTHING` (re-runnable). Tabs are processed in dependency
order so foreign keys resolve.

```
# Verify Sheets read-only token first:
GOOGLE_SHEETS_TOKEN=$(gcloud auth print-access-token)
SHEETS_ID=<workbook-id>

# Dry-run (reads only, reports counts; no writes):
node db/backfill_sheets_to_pg.mjs --dry-run

# Real backfill:
npm run db:backfill

# Backfill a subset only (comma-separated tab names):
node db/backfill_sheets_to_pg.mjs --only=raw_signals,trend_scores
```

The script ends with a parity report: Sheet row count vs Postgres row count,
per tab. Exit code is non-zero on any mismatch. The most common cause of a
401 / 403 here is an expired Sheets OAuth token — re-mint with
`gcloud auth print-access-token` (or your CI service account flow) and re-run.

### Skipping Sheets backfill

If you are not importing the legacy Google Sheet, **skip** root README step 4 and do not set `SHEETS_ID` / `GOOGLE_SHEETS_TOKEN`. The live pipeline fills Postgres via n8n only.

**Phase 1 gate (Gate 6):** `npm run n8n:phase1-gate` still expects **pipeline-generated** data in several tables (for example `marketplace_evidence` with `source=etsy_autocomplete`, `trend_scores`, `watchlist`). That data comes from **running the workflows** (`npm run n8n:simulate`, schedules, or manual Execute), not from Sheets backfill. Until those runs succeed, use `npm run n8n:phase1-gate -- --skip-phase3` if you only want to validate schema and workflow presence.

## psql one-liners

```bash
# CRUD shell as admin:
docker exec -it -u postgres local-postgres psql -U pod_admin -d pod_trends

# Schema overview:
\dt                           -- list tables
\d normalized_terms           -- describe a table (columns, indexes, FKs)
\dv                           -- list views

# Common diagnostics:
SELECT * FROM v_dashboard_summary;
SELECT * FROM v_source_health_today;
SELECT * FROM v_stage_run_health_24h;
SELECT count(*) FROM raw_signals WHERE date_collected >= NOW() - INTERVAL '24 hours';
SELECT tier, count(*) FROM opportunity_scores WHERE run_date = CURRENT_DATE GROUP BY tier;
```

## Backup and restore

```bash
# Full logical dump (data + schema):
docker exec -e PGPASSWORD='<ADMIN_PWD>' local-postgres \
  pg_dump -U pod_admin -d pod_trends -Fc -f /tmp/pod_trends.dump
docker cp local-postgres:/tmp/pod_trends.dump ./backups/pod_trends-$(date +%F).dump

# Restore from dump (drops + recreates objects):
docker cp ./backups/pod_trends-YYYY-MM-DD.dump local-postgres:/tmp/restore.dump
docker exec -e PGPASSWORD='<ADMIN_PWD>' local-postgres \
  pg_restore -U pod_admin -d pod_trends --clean --if-exists /tmp/restore.dump

# Schema-only export (great for code review):
docker exec -e PGPASSWORD='<ADMIN_PWD>' local-postgres \
  pg_dump -U pod_admin -d pod_trends --schema-only > db/snapshots/schema-$(date +%F).sql
```

## n8n credential + workflow import

After Postgres is up and migrated, configure n8n once:

1. **Create the credential** (n8n UI → Credentials → New → Postgres):
   - Name: `Postgres - POD Research` (must match exactly — all workflow JSON references this)
   - Host: `local-postgres` (when n8n runs in the `pod_local_net` Docker network) **or** `127.0.0.1` (off-network).
   - Port: `5432` if `local-postgres` host, otherwise `5433`.
   - Database: `pod_trends`
   - User: `pod_app`
   - Password: from `.env.postgres` (`pod_app` URI)
   - SSL: disabled for local

2. **Import the workflows** via the n8n REST API helper:

   ```bash
   # in repo root, with N8N_API_URL and N8N_API_KEY set in .env (or env)
   npm run n8n:import:dry        # preview create/update plan
   npm run n8n:import            # actually create/update
   ```

   The script strips fields the create endpoint rejects (`active`, `meta`,
   `pinData`, etc.) and reuses an existing workflow id when a workflow with the
   same name already exists (PUT instead of POST). To import a single file:
   `node n8n/import-workflows.mjs --only=wf_publish_queue.json`.

3. **Activate the schedules** in the n8n UI after the first dry-run pass (or
   set `active: true` manually after import).

4. **MCP access** (for `npm run n8n:simulate`): In each workflow that the simulate script runs, open **Settings** and enable **MCP access**. Otherwise n8n returns `Workflow is not available in MCP`.

## Rotating role passwords

```bash
# Admin role:
docker exec -it -u postgres local-postgres psql -d pod_trends \
  -c "ALTER ROLE pod_admin WITH PASSWORD '<NEW_ADMIN_PWD>';"

# App role:
docker exec -it -u postgres local-postgres psql -d pod_trends \
  -c "ALTER ROLE pod_app WITH PASSWORD '<NEW_APP_PWD>';"
```

After rotating, update:
1. `.env.postgres` (host)
2. n8n credential **Postgres - POD Research**
3. `postgres-mcp` `--access-mode=restricted` URI in `.cursor/mcp.json` if you use it.

## Troubleshooting

- `password authentication failed` — make sure `.env.postgres` host matches the
  context: `127.0.0.1:5433` from the host shell, `local-postgres:5432` from a
  container on `pod_local_net`. If `npm run db:credentials-check` fails for
  `DATABASE_URI` (`pod_app`) but passes for `DATABASE_URI_ADMIN` (`pod_admin`),
  the `pod_app` password in `.env` / `.env.postgres` does not match the role in
  Postgres — fix the password or run `ALTER ROLE pod_app WITH PASSWORD '...'`
  to match.
- `relation "_migrations" does not exist` — first migration run also creates
  the registry table; re-run `npm run db:migrate`.
- `permission denied for table X` — `pod_app` needs grants on every new table.
  The schema migration adds tables under `public`; if you add them outside
  `public`, also `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE X TO pod_app;`.
- Backfill fails with 401 from Sheets — refresh `GOOGLE_SHEETS_TOKEN`; tokens
  expire after ~1 hour. The migration runner does not need this token.

## See also

- [docker-compose.postgres.yml](../docker-compose.postgres.yml)
- [.env.postgres.example](../.env.postgres.example)
- Plan reference: `~/.cursor/plans/postgres-and-n8n-cutover-plans_*.plan.md`
