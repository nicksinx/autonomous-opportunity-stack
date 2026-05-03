# archive/sheets/ — historical Google Sheets sources

These Apps Script files (`*.gs`) were the original source-of-truth for the
sheet-backed POD Trend Research workbook (tabs, headers, seed rows, dashboard
formulas, validation rules). They are preserved here for git history and
schema-archeology only.

The active source-of-truth is now Postgres:

- DDL: [`db/migrations/0001_init.sql`](../../db/migrations/0001_init.sql)
- Seed data: [`db/migrations/0002_seed_sources_config.sql`](../../db/migrations/0002_seed_sources_config.sql) and [`db/migrations/0003_seed_score_weights.sql`](../../db/migrations/0003_seed_score_weights.sql)
- Reporting: [`db/views/`](../../db/views/) (replaces the dashboard tab)

Do not edit these files. To make a schema change, add a new migration under
`db/migrations/` instead.

| File                              | Notes                                               |
| --------------------------------- | --------------------------------------------------- |
| `setup_sheets.gs`                 | Tab + header bootstrap, sources_config seed         |
| `extend_clustering_schema.gs`     | theme_clusters tab + columns                        |
| `extend_pipeline_hardening.gs`    | normalization_log, publishing_queue, stage_run_logs, source_health, pipeline_locks, dual_write_mirror_log |
| `extend_scoring_schema.gs`        | opportunity_scores, score_components, score_weights, performance_feedback, scoring_audit_log |
| `build_scoring_dashboard.gs`      | Dashboard tab + formulas (replaced by `db/views/v_dashboard_summary.sql`) |
| `sheetsSafetyKit.js`              | Sheets-era lock/dedup/mirror utilities (replaced by Postgres locks, `ON CONFLICT`, transactions) |
| `queueIdempotency.js`             | Publishing-queue idempotency helper (replaced by native `ON CONFLICT (idempotency_key) DO UPDATE` in `wf_publish_queue`) |
