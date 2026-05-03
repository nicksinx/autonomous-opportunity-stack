# POD Research Automation

End-to-end print-on-demand opportunity pipeline: collect signals, normalize
terms, score and cluster, generate range briefs, and queue publishing — all
backed by a local Postgres database and orchestrated by n8n workflows.

**Layer 1** (this repo’s operational core) is intake through publishing: raw
signals → normalized terms → marketplace enrichment → scoring and clustering →
range briefs → publish queue and performance feedback. Data lands in Postgres;
optional CSV and contract validation align producers with
`db/contracts/canonical_signal_v1.json`. **Layer 2** is the decisioning and
lifecycle layer on top of that foundation (see `oportunity-scoring-spec-layer-2.md`,
`LAYER2_FEASIBILITY_ASSESSMENT.md`, and migrations `0009_*` onward).

## Storage backend

The system stores all pipeline data in a local Dockerised Postgres instance
(`local-postgres` container). The previous Google Sheets backend is archived
under [`archive/sheets/`](archive/sheets/) for history only.

- Schema, migrations, views, backfill, runbook → [`db/README.md`](db/README.md)
- Compose file → [`docker-compose.postgres.yml`](docker-compose.postgres.yml)
- Local env → copy [`.env.postgres.example`](.env.postgres.example) → `.env.postgres`
- Onboarding a new Layer 1 source → [`docs/onboarding-a-new-source.md`](docs/onboarding-a-new-source.md)
- Ops views (health, lineage, queue) → [`docs/operational-dashboard.md`](docs/operational-dashboard.md)

## First-time setup

```sh
# 1. Bring up the database container
docker compose -f docker-compose.postgres.yml up -d

# 2. Install Node deps (pg, pg-format, dotenv)
npm install

# 3. Apply migrations and refresh views
npm run db:migrate

# 4. (Optional one-shot) backfill data from the legacy Sheet — skip if unused
npm run db:backfill

# 5. Configure n8n
#    — create credential "Postgres - POD Research" in n8n UI
#    — see db/README.md "n8n credential + workflow import" for details

# 6. Import all seven workflow JSON files into a running n8n instance
#    Set N8N_API_URL (must include http:// or https://, e.g. http://127.0.0.1:5678)
#    and N8N_API_KEY in .env — see .env.example
npm run n8n:import:dry            # preview create/update
npm run n8n:import                # actually create/update
```

## Daily commands

| Command                     | What it does                                              |
| --------------------------- | --------------------------------------------------------- |
| `npm run n8n:validate`      | Static validation of every `n8n/wf_*.json` (including connection-graph cycle guard) |
| `npm run n8n:validate:cycle-guard` | Regression test for the cycle detector against `n8n/__fixtures__/wf_with_cycle.json` |
| `npm run n8n:phase1-gate`   | Postgres-backed Phase 1 acceptance gate (Gates 1–6)       |
| `npm run n8n:simulate`      | Trigger scheduled main workflows on the running n8n via MCP |
| `npm run outbox:publish`    | Drain `workflow_outbox` via `services/outbox-publisher` (when using outbox emission) |
| `npm run csv:import`        | CSV → `raw_signals` path (`services/csv-importer`)          |
| `npm run api:start`         | Local Fastify API (`services/api`)                         |
| `npm run db:psql`           | Open psql as `pod_admin` inside the container             |
| `npm run db:migrate`        | Apply pending SQL migrations + refresh views              |
| `npm run db:credentials-check` | Verify `DATABASE_URI` / `DATABASE_URI_ADMIN` can connect (masks passwords) |
| `npm run db:schema-columns` | Confirm every Phase 1 table has columns from `db/migrations/0001_init.sql` |
| `npm test`                  | Run Node’s built-in test runner (`tests/*.test.mjs`)      |

## Verification and Phase 1 gate

- **`npm run n8n:phase1-gate`** runs Gates 1–6 (schema, seeds, n8n workflows, optional execution checks, Phase 3 data checks).  
- **`--skip-trigger`** — skip Gate 5 (programmatic workflow execution) if your n8n build has no `POST /api/v1/workflows/{id}/execute` and you have not configured Editor session env for REST `/run` (see comments in `n8n/phase1-gate.mjs`).  
- **`--skip-phase3`** — skip Gate 6 until pipelines have written Etsy/scores/watchlist data.

Example infra-only smoke test when Postgres and n8n are configured but Gate 5/6 are not yet applicable:

```sh
npm run n8n:phase1-gate -- --skip-trigger --skip-phase3
```

Gate 5 typically needs either a newer n8n with public **execute** API and API key scope `workflow:execute`, or **`n8n-auth` session cookie + `browser-id`** headers for `POST /rest/workflows/{id}/run`.

## Regenerate workflow JSON

Four of the seven committed workflows are regenerated from JS builders. The other three
(`wf_collect_trends.json`, `wf_normalize_terms.json`, `wf_enrich_marketplace.json`)
are edited directly. After any builder change, regenerate and re-validate:

```sh
node n8n/build_score_and_cluster_workflow.mjs && \
node n8n/build_publish_queue_workflow.mjs && \
node n8n/build_ingest_performance_feedback_workflow.mjs && \
node n8n/build_generate_briefs_bundle.mjs

npm run n8n:validate
```

`n8n/build_pg_node.mjs` is the shared factory for `n8n-nodes-base.postgres`
nodes used by every builder, ensuring a single Postgres credential reference
(`Postgres - POD Research`).

## Workflow inventory

| File                                                       | Logical workflows                                         |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| `wf_collect_trends.json`                                   | error handler, `wf_collect_trends`                        |
| `wf_normalize_terms.json`                                  | error handler, `wf_normalize_terms`                       |
| `wf_enrich_marketplace.json`                               | error handler, `wf_enrich_marketplace`                    |
| `wf_score_and_cluster.json`                                | error handler, `wf_score_and_cluster`                     |
| `wf_publish_queue.json`                                    | error handler, `wf_publish_queue`                         |
| `wf_ingest_performance_feedback.json`                      | `wf_ingest_performance_feedback`                          |
| `wf_generate_range_briefs_and_phrase_expansion.json`       | error handler, `wf_generate_range_briefs`, `wf_phrase_expansion` |

## Reference

- Cutover evidence: [`SPRINT_CLOSEOUT.md`](SPRINT_CLOSEOUT.md)
- Plan: `~/.cursor/plans/postgres-and-n8n-cutover-plans_*.plan.md`
- Database runbook: [`db/README.md`](db/README.md)
- Archived Sheets sources: [`archive/sheets/README.md`](archive/sheets/README.md)
