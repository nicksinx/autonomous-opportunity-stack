# Operational dashboard (SQL views)

Health and ops views live under `db/views/` and refresh on `npm run db:migrate` (view pass) or `node db/run_migrations.mjs --views`.

| View | Purpose |
|------|---------|
| `v_dashboard_summary` | Cross-cutting KPI snapshot |
| `v_stage_run_health_24h` | Workflow stage success rates |
| `v_canonical_signal_health` | Contract intake quality |
| `v_workflow_outbox_health` | Outbox backlog / failures |
| `v_scoring_run_health` | Scoring run outcomes |
| `v_publish_queue_status` | Publish pipeline |
| `v_approved_opportunities` | Layer 2 candidates approved for creative |
| `v_review_queue` | Candidates needing human review |
| `v_latest_opportunity_scores` | Latest score per opportunity |
| `v_score_factor_breakdown` | Factor-level explainability |
| `v_score_distribution_by_source_family` | Latest scores aggregated by `canonical_signals.source_type` (spec §22) |
| `v_lineage_explorer` | Canonical signal → normalized term linkage |
| `v_cluster_strategy_comparison` | Cluster counts by strategy version |
| `v_score_weight_history` | Calibration audit trail |
| `v_lifecycle_history` | Review decisions |
| `v_creative_pack_status` | Latest Layer 3 creative run per approved candidate (Drive URL, status, errors) |

Run ad hoc checks as `pod_app` or admin against these views; wire Grafana or Metabase if desired.

## Readiness audit

The Layer 2 readiness gate audits the repo + DB against `LAYER2_IMPLEMENTATION_READINESS_CHECKLIST.md`.

| Command | Effect |
|---------|--------|
| `npm run layer2:readiness` | Run all checks, print human summary, exit non-zero if Must Complete fails |
| `npm run layer2:readiness:report` | Same checks, also write `LAYER2_READINESS_REPORT.md` |
| `npm run layer2:readiness:full` | Same as report plus `--run-tests` (`npm test` + `n8n:validate`); use in CI for a complete audit |
| `node n8n/layer2-readiness-gate.mjs --json` | Machine-readable output |
| `node n8n/layer2-readiness-gate.mjs --strict` | Fail when Strongly Recommended also has FAILs |
| `node n8n/layer2-readiness-gate.mjs --skip-db` | Static checks only (no Postgres) |
| `node n8n/layer2-readiness-gate.mjs --run-tests` | Also execute `npm run n8n:validate` and `npm run test` |
| `node n8n/layer2-readiness-gate.mjs --section=decision` | Filter to one section (`must`, `should`, `defer`, `decision`) |

Decisions are tracked in `LAYER2_DECISIONS.md`. Set each `status: resolved` (with `owner` + `resolution`) or `status: deferred` to clear the gate's decision section.
