# Layer 2 Implementation Readiness Checklist

> Companion document: [`LAYER2_FEASIBILITY_ASSESSMENT.md`](LAYER2_FEASIBILITY_ASSESSMENT.md)
> Spec under evaluation: [`oportunity-scoring-spec-layer-2.md`](oportunity-scoring-spec-layer-2.md)
> Date: 2026-05-02. Reflects repository state at that time.

This checklist is a working plan. Each item references the exact file, table, or workflow that needs to change so reviewers can verify and so a second pass of work can pick it up cleanly. Items are deliberately small and self-contained.

## Must Complete Before Layer 2

### Schema readiness

- [ ] **Add `canonical_signals` table** in a new migration `db/migrations/0005_canonical_signals.sql`. Required columns per spec §10.1: `signal_id` (TEXT PK, app-generated), `contract_version` (TEXT, NOT NULL), `source_type` (TEXT, NOT NULL, CHECK against an enum), `source_name` (TEXT, NOT NULL, FK to `sources_config`), `source_record_id` (TEXT, NULL), `intake_run_id` (TEXT, NOT NULL, FK to `workflow_runs`), `observed_at` (TIMESTAMPTZ, NOT NULL), `ingested_at` (TIMESTAMPTZ, NOT NULL DEFAULT NOW()), `normalized_topic` (TEXT, NOT NULL), `normalized_niche`, `normalized_sub_niche`, `audience_hint jsonb`, `product_type_hints jsonb`, `trend_metrics jsonb`, `sentiment_metrics jsonb`, `competition_metrics jsonb`, `seasonality_hint jsonb`, `enrichment jsonb`, `risk_flags jsonb`, `quality_score numeric`, `lineage jsonb` (NOT NULL), `dedupe_key` (TEXT, NOT NULL), `status` (TEXT, NOT NULL CHECK (status IN ('ready','suppressed','invalid','archived','quarantined'))). Indexes on `(status)`, `(source_type)`, `(dedupe_key)`, `(normalized_topic)`, `(ingested_at)`. UNIQUE on `(dedupe_key, contract_version)`.
- [ ] **Add `workflow_outbox` table** in `db/migrations/0006_workflow_outbox.sql` per spec §12.6. Required columns: `event_id UUID PK`, `aggregate_type TEXT NOT NULL`, `aggregate_id TEXT NOT NULL`, `event_type TEXT NOT NULL`, `payload jsonb NOT NULL`, `schema_version TEXT NOT NULL`, `scheduled_at timestamptz NOT NULL DEFAULT NOW()`, `processed_at timestamptz`, `retry_count INTEGER NOT NULL DEFAULT 0`, `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','complete','deadletter'))`. Index on `(status, scheduled_at)` for the publisher claim query, and on `(aggregate_type, aggregate_id)` for traceability.
- [ ] **Add `scoring_runs` table** in `db/migrations/0007_scoring_runs.sql` per spec §12.5. Columns: `scoring_run_id UUID PK`, `trigger_type TEXT NOT NULL CHECK (trigger_type IN ('event','batch','replay','manual','scheduled'))`, `trigger_ref TEXT`, `scoring_version TEXT NOT NULL`, `scope jsonb NOT NULL`, `status TEXT NOT NULL CHECK (status IN ('pending','running','success','partial','failed'))`, `metrics jsonb`, `started_at timestamptz NOT NULL DEFAULT NOW()`, `finished_at timestamptz`. Index on `(status, started_at)`.
- [ ] **Replace the `(canonical_id, run_date)` conflict key on `opportunity_scores`** in a new migration. Current state: `uq_opportunity_scores_canonical_run` at [`db/migrations/0001_init.sql:382-383`](db/migrations/0001_init.sql) plus `ON CONFLICT (canonical_id, run_date) DO NOTHING` at [`n8n/build_score_and_cluster_workflow.mjs:46-48`](n8n/build_score_and_cluster_workflow.mjs). Target: `(canonical_id, scoring_run_id)` so reruns append history. The score writer must change in lockstep.
- [ ] **Add `raw_signals.canonical_id` FK to `normalized_terms.canonical_id`** plus an index, in a new migration. Backfill by running `slugify(term)` once. This is the only stable lineage hop currently missing.
- [ ] **Add `sources_config.source_type` (TEXT NOT NULL DEFAULT 'unknown')** with a CHECK enum {`marketplace`, `search`, `social`, `reviews`, `csv`, `internal`} and seed values for the 6 existing rows in [`db/migrations/0002_seed_sources_config.sql`](db/migrations/0002_seed_sources_config.sql).

### Contract readiness

- [ ] **Define `db/contracts/canonical_signal_v1.json`** as a JSON Schema covering spec §10.1. Used both by the intake validator and by Layer 2's contract test (spec §25.3).
- [ ] **Wire a contract validator into the intake stage.** Today there is [`sourceContractValidator.js`](sourceContractValidator.js) (vestigial CommonJS) and an inline copy at [`n8n/wf_collect_trends.json` near line 471](n8n/wf_collect_trends.json) that validates `raw_signals` shape only. The new validator must validate `canonical_signals` rows before they are exposed to Layer 2 (spec §10.2).
- [ ] **Decide and document the `contract_version` policy** — single global, per-source, or hybrid; bump rules. Document in `db/README.md`. (See "Decisions Needed" below.)
- [ ] **Decide and seed initial `source_type` mapping** for current sources: `google_trends → search`, `pinterest_trends → social`, `tiktok_creative → social`, `etsy_autocomplete → marketplace`, `amazon_movers → marketplace`, `google_kw_planner → search`. Update [`db/migrations/0002_seed_sources_config.sql`](db/migrations/0002_seed_sources_config.sql) (in a new migration, not edit-in-place).

### Workflow readiness

- [ ] **Stop hardcoding source names in the scorer.** Replace the source-name switches at [`n8n/build_score_and_cluster_workflow.mjs:217, 223-224`](n8n/build_score_and_cluster_workflow.mjs) (`signalSources.has('google_trends')`, `'pinterest_trends'`, `'tiktok_creative'`; `evidenceSources` for `'amazon_movers'`; `etsyRows` for `'etsy_autocomplete'`) with reads from `canonical_signals.source_type` family counts.
- [ ] **Wire `cluster_members` writes.** [`n8n/build_score_and_cluster_workflow.mjs:321-357`](n8n/build_score_and_cluster_workflow.mjs) currently uses `canonical_ids.length` and discards the array. Add an insert into `cluster_members` for every `(cluster_id, canonical_id)` pair in the same transaction as the `theme_clusters` insert. This unblocks lineage and Layer 2's `supporting_signal_ids`.
- [ ] **Make `wf_score_and_cluster` create one `scoring_runs` row per execution** and stamp every score with the resulting `scoring_run_id`. The current "run identity" is the n8n `run_id` (`run_wf_score_and_cluster_<ms>`) at [`n8n/build_score_and_cluster_workflow.mjs:187`](n8n/build_score_and_cluster_workflow.mjs); promote that into the new `scoring_runs` table.
- [ ] **Emit outbox events from `wf_score_and_cluster` in the same transaction as the score row.** Minimum events for v1: `opportunity_scored`, `opportunity_needs_review`, `opportunity_rejected`. Use the spec §20 envelope.
- [ ] **Build a publisher worker** that processes `workflow_outbox` rows in `status='pending'`, marks `status='processing'`, dispatches, marks `status='complete'` (or `deadletter` after N failures). Add `npm run outbox:publish` to [`package.json`](package.json). Decide whether the worker is a long-running Node process or an n8n cron polling loop.
- [ ] **Stop writing `dual_write_mirror_log` rows** from every n8n builder ([`n8n/build_score_and_cluster_workflow.mjs:121-135, 371-374`](n8n/build_score_and_cluster_workflow.mjs); same pattern in `wf_normalize_terms.json` and `wf_enrich_marketplace.json`). The dual-write target was Sheets, which is gone (per [`SPRINT_CLOSEOUT.md`](SPRINT_CLOSEOUT.md) Step 13/14).
- [ ] **Switch `wf_publish_queue` to consume the outbox** instead of polling `range_briefs` and Tier-C `opportunity_scores`. Removing the `fallback_scores` CTE at [`n8n/wf_publish_queue.json:125`](n8n/wf_publish_queue.json) is part of this.

### Observability readiness

- [ ] **Add view `v_canonical_signal_health.sql`** showing rows-by-status, by `source_type`, by `contract_version`, by `dedupe_key` collisions, in the last N days.
- [ ] **Add view `v_scoring_run_health.sql`** showing `scoring_runs` aggregated by `trigger_type`, `status`, success rate, mean duration, mean records processed, dead-letter count.
- [ ] **Add view `v_workflow_outbox_health.sql`** showing pending depth, oldest pending age, retry distribution, dead-letter count by `event_type`.
- [ ] **Add view `v_lineage_explorer.sql`** joining `opportunity_scores` (or its successor) → `cluster_members` → `canonical_signals` → `raw_signals` so a single `opp_id` can be traced end to end.
- [ ] **Add view `v_score_factor_breakdown.sql`** that aggregates `score_components` (or its successor `opportunity_score_factor`) per opportunity per factor family.
- [ ] **Add view `v_review_queue.sql`** showing opportunities in `readiness_status='needs_review'` with confidence and reason.
- [ ] **Add view `v_approved_opportunities.sql`** showing opportunities in `readiness_status='approved_for_creative'` for Stage 6 consumption.
- [ ] **Add Gate 7 to `n8n/phase1-gate.mjs`** for outbox health (pending depth not growing unboundedly, no stuck `processing`, no recent dead-letters spike).
- [ ] **Add Gate 8 to `n8n/phase1-gate.mjs`** for canonical-signal contract validation: row count, percentage with `status='ready'`, dedupe-key collision count.
- [ ] **Extend `REQUIRED_TABLES` in `n8n/phase1-gate.mjs`** ([`n8n/phase1-gate.mjs:50-72`](n8n/phase1-gate.mjs)) with `canonical_signals`, `workflow_outbox`, `scoring_runs`, and the new opportunity entities once they exist.

### Testing readiness

- [ ] **Contract test** that validates a sampled `canonical_signals` row against `db/contracts/canonical_signal_v1.json` for every contract version present in the table.
- [ ] **Replay test** that runs a scoring scope twice with the same `scoring_version` and asserts identical outputs in `opportunity_score`, plus appends a second `scoring_runs` row.
- [ ] **Score-version-bump test** that runs the same scope with two different `scoring_version` values and asserts both score rows survive (no silent overwrite).
- [ ] **Idempotent outbox consumer test** — duplicate event delivery produces no duplicate side effects.
- [ ] **Mixed-source cluster test** — a cluster whose members come from two different `source_type` families is scored and produces a non-zero confidence.
- [ ] **Missing-evidence-family test** — when `sentiment_metrics` is absent, the score still produces, with reduced confidence, not an error.
- [ ] **State-transition tests** for the lifecycle on `opportunity_candidate` ({new → ready_for_scoring → scoring → scored → needs_review/approved_for_creative/rejected → archived}).
- [ ] **Cycle-guard regression** — extend [`n8n/validate-workflows.mjs`](n8n/validate-workflows.mjs) to check that the new outbox writes do not introduce a connection cycle (the existing cycle-guard caught one in `wf_score_and_cluster`'s no-Tier-A branch — see [`SPRINT_CLOSEOUT.md`](SPRINT_CLOSEOUT.md) "Root cause summary").
- [ ] **Compatibility test for Phase 1 dashboards** — confirm [`db/views/v_dashboard_summary.sql`](db/views/v_dashboard_summary.sql), [`db/views/v_dashboard_top10`](db/views/v_dashboard_summary.sql), [`db/views/v_feedback_rollup.sql`](db/views/v_feedback_rollup.sql), and Gate 6 of `phase1-gate.mjs` still pass once `opportunity_scores` and `trend_scores` are replaced with views or shadowed by Layer 2 tables.

## Strongly Recommended Before Layer 2

### Schema readiness

- [ ] **Promote `risk_flags` to first-class on `canonical_signals`** instead of recomputing them inside the scorer from `BRAND_CELEB_RISK_WORDS` and `NEWS_EVENT_RISK_WORDS` regex matches at [`n8n/build_score_and_cluster_workflow.mjs:199-200, 212`](n8n/build_score_and_cluster_workflow.mjs).
- [ ] **Promote `audience_hint` and `seasonality_hint` to first-class** instead of regex-deriving them from term text inside the scorer.
- [ ] **Add `confidence_score numeric` to whichever table holds the score row** (new `opportunity_score` table or extended `opportunity_scores`), with a derivation routine per spec §16.4.
- [ ] **Add a real `readiness_status` column** for the spec §13.1 lifecycle on the candidate entity. Today there is no equivalent.
- [ ] **Decide whether to namespace under `intake.`, `scoring.`, `workflow.`, `analytics.` schemas** per spec §21.1, before too many compatibility views accrete.

### Contract readiness

- [ ] **Per-factor `evidence_refs` and `factor_reason`** on the new `opportunity_score_factor` table (spec §12.4). Today, [`score_components`](db/migrations/0001_init.sql) is per-rule and uses a free-text `notes` column instead.
- [ ] **Source-capability matrix** (spec §11) populated for the 6 current sources, used by the scorer to decide which factors to compute and which to mark `evidence_missing`.

### Workflow readiness

- [ ] **Decide the inter-workflow trigger model.** Today every workflow is on its own cron with no causal link (the SPRINT_CLOSEOUT "cascade" is the manual MCP `simulate-scheduled-runs.mjs` harness, not a runtime trigger). Options: (a) outbox-driven via the publisher worker, (b) n8n `executeWorkflow` chain, (c) keep cron and rely on temporal ordering. Spec §18.2 recommends outbox.
- [ ] **Resolve the `_apply_pg_handedits.mjs` drift problem.** [`n8n/_apply_pg_handedits.mjs`](n8n/_apply_pg_handedits.mjs) suggests that hand-edits are being patched onto generated workflows. Either eliminate hand-edits, or move the source of truth from the JS builder to the JSON.
- [ ] **Decide what to do with the vestigial root-level JS modules.** [`scoringEngine.js`](scoringEngine.js), [`opportunityBuilder.js`](opportunityBuilder.js), [`clusterScoringEngine.js`](clusterScoringEngine.js), [`clusterMergeSplit.js`](clusterMergeSplit.js), [`clusterHistoryTracker.js`](clusterHistoryTracker.js), [`clusteringPayloadBuilder.js`](clusteringPayloadBuilder.js), [`weightCalibrator.js`](weightCalibrator.js), [`scoringConfigLoader.js`](scoringConfigLoader.js), [`normalizationAuditor.js`](normalizationAuditor.js), [`observabilityEnvelope.js`](observabilityEnvelope.js), [`sourceContractValidator.js`](sourceContractValidator.js) — delete, port to ESM, or move to `archive/`.
- [ ] **Stop writing `trend_scores` from the scorer**, or replace `trend_scores` with a view over `opportunity_scores`. Currently `wf_score_and_cluster` writes both ([`n8n/build_score_and_cluster_workflow.mjs:50-64, 264-280`](n8n/build_score_and_cluster_workflow.mjs)) and `phase1-gate.mjs` Gate 6 enforces parity between them ([`n8n/phase1-gate.mjs:388-411`](n8n/phase1-gate.mjs)).

### Observability readiness

- [ ] **Score distribution by source family** view (spec §22).
- [ ] **Average confidence by source family** view (spec §22).
- [ ] **Contract validation failure counter** persisted, not just logged.
- [ ] **Dead-letter table `workflow_outbox_deadletter`**, or a `WHERE status='deadletter'` view, with alert thresholds.

### Testing readiness

- [ ] **Contract drift test** that diffs `canonical_signals` row shape against `canonical_signal_v1.json` over a rolling 7-day window.
- [ ] **Performance smoke** — score N=10k canonical signals end-to-end in under target latency (target TBD per spec §24 Performance line).
- [ ] **Backfill correctness test** — reprocess historical `raw_signals` through the new normalization → canonical_signals path and assert it produces the same `canonical_id` set as `normalized_terms` does today (parity with current Phase 1).

## Can Be Deferred

- [ ] **HTTP API per spec §19.3** (`POST /scoring/runs`, `POST /scoring/replay`, `GET /opportunities/{id}`, `GET /opportunities/{id}/scores`, `GET /opportunities?status=approved_for_creative`). Phase 1 of Layer 2 can ship with table reads and outbox events only.
- [ ] **Replace LLM clustering** at [`n8n/build_score_and_cluster_workflow.mjs:321-357`](n8n/build_score_and_cluster_workflow.mjs) with a deterministic clusterer (the vestigial [`clusterScoringEngine.js`](clusterScoringEngine.js) sketches one). Until then, `cluster_version` should pin the LLM model name.
- [ ] **Productionise `weightCalibrator.js`** for feedback-driven retraining, fed by [`performance_feedback`](db/migrations/0001_init.sql).
- [ ] **Replace inlined Code-node scoring with a real Node service.** The transitional state with Code-node scoring is acceptable for v1 of Layer 2.
- [ ] **Build a UI for the review queue.** A view + manual SQL is acceptable for v1.
- [ ] **Multi-source onboarding (CSV, social listening, reviews).** Spec §11 source-capability matrix can be populated incrementally.
- [ ] **Schema namespacing migration** (`intake.`, `scoring.`, `workflow.`, `analytics.`) — easier to do early, but doable later if v1 stays in `public`.
- [x] **Retire `dual_write_mirror_log` table** — staged in Phase 5 closeout: workflow writes removed in Phase 1; consumer `n8n/check-mirror-consistency.mjs` and `npm run n8n:check-mirror` deleted; table renamed to `dual_write_mirror_log_legacy` and writes revoked in [`db/migrations/0015_retire_dual_write_mirror_log.sql`](db/migrations/0015_retire_dual_write_mirror_log.sql). Follow-up: ship `db/migrations/0016_drop_dual_write_mirror_log_legacy.sql` once Gate 6 stays green for a full sprint with `MAX(created_at)` on the legacy table unchanged.
- [ ] **Retire `cluster_history`, `cluster_review_queue`, `cluster_metrics` tables** (currently dormant) **or** wire them as the homes for the lifecycle/observability data the spec requires. Decide one way or the other; do not leave dormant.
- [ ] **Replace `slugify(term)` canonical-id strategy** with a UUID + lookup. This is the single biggest Sheets-era assumption left in the data model.

## Decisions Needed

These need a named owner before Must-Do work starts. They each meaningfully change the schema or the worker boundary, so locking them late causes rework.

- [ ] **Contract version policy.** Single global `contract_version` or per-source? Bump on any schema change or only on breaking? Stored where (spec §10.1 puts it on every signal row)?
- [ ] **Identity strategy for new entities.** Stay with app-generated TEXT PKs (the current convention, e.g. `opp_<canonical_id>_<run_date>`) or move to `UUID` (spec §12 uses `UUID / text`)? Mixed identity styles complicate joins. Recommendation: UUID for new entities, keep TEXT PKs on existing tables to avoid breaking the dashboards.
- [ ] **Replay strategy.** Does a replay write a new `scoring_run_id` and reuse the existing `opportunity_id`, or create a new candidate? Spec §18.3 says "rescoring should append history rather than mutate old score facts" but is silent on candidate identity.
- [ ] **State-machine ownership.** Where does `readiness_status` live — only on `opportunity_candidate`, or replicated on each `opportunity_score`? Who is allowed to transition states (worker, reviewer UI, admin SQL)? Audit trail format?
- [ ] **Outbox consumer model.** Long-running Node publisher worker, or n8n cron polling? The latter is simpler but re-introduces cron-based event handling and complicates "event-driven" claims. Recommendation: standalone Node worker so it can have its own backoff and metrics.
- [ ] **Schema namespacing.** Move to `intake.` / `scoring.` / `workflow.` / `analytics.` (spec §21.1) or stay in `public`? Doing it now means renaming every n8n SQL string; doing it later means a big migration window.
- [ ] **Compatibility surface for Phase 1 dashboards and Gate 6.** Keep `opportunity_scores` and `trend_scores` as physical tables, or replace with views over the new Layer 2 entities? Replacing as views breaks the parity check at [`n8n/phase1-gate.mjs:388-411`](n8n/phase1-gate.mjs); keeping as tables means a dual-write inside the score writer.
- [ ] **Hard-block risk policy.** Today `compliance_risk='high'` short-circuits scoring at [`n8n/build_score_and_cluster_workflow.mjs:296-303`](n8n/build_score_and_cluster_workflow.mjs). Move to a `risk_rules` config table, push into the contract, or keep as code?
- [ ] **Confidence threshold for `needs_review`** and **score thresholds for `approved_for_creative`** — spec §13.2 leaves these to the implementation.
- [ ] **Clustering strategy** — keep LLM, replace with deterministic, or hybrid? Spec §28 lists this as open.
- [ ] **First downstream consumer for outbox events.** Spec §30. The obvious candidate is `wf_publish_queue`, replacing the current `range_briefs` poll + `fallback_scores` CTE; confirm.
- [ ] **What to do with the vestigial root-level JS modules** — delete, port, or archive (see "Strongly Recommended").
- [ ] **Hand-edit policy for n8n workflow JSON** — eliminate or document a single source-of-truth ([`n8n/_apply_pg_handedits.mjs`](n8n/_apply_pg_handedits.mjs)).

## Evidence Required From Codebase

These are the cited code locations that ground the conclusions in this checklist and in [`LAYER2_FEASIBILITY_ASSESSMENT.md`](LAYER2_FEASIBILITY_ASSESSMENT.md). They are listed here so a follow-up reviewer can spot-check each claim without re-doing the survey.

### Schema and migrations

- [`db/migrations/0001_init.sql`](db/migrations/0001_init.sql) — full schema, 25 tables. Specific lines:
  - `raw_signals` definition, lines 44-61. No FK to `normalized_terms`.
  - `normalized_terms` definition, lines 66-98. PK = `canonical_id` = app-generated TEXT (`norm_<slug(term)>`).
  - `opportunity_scores` definition, lines 352-387. UNIQUE `(canonical_id, run_date)` at lines 382-383.
  - `score_components` definition, lines 392-408. Per-rule, not per-factor-family.
  - `theme_clusters` definition, lines 146-177.
  - `cluster_members` definition, lines 182-196 (dormant).
  - `cluster_history` definition, lines 201-215 (dormant).
  - `cluster_review_queue` definition, lines 220-244 (dormant).
  - `cluster_metrics` definition, lines 249-271 (dormant).
  - `trend_scores` definition, lines 122-141 (vestigial Sheets mirror).
  - `dual_write_mirror_log` definition, lines 609-624 (vestigial post-cutover).
  - `publishing_queue` definition, lines 497-526 (closest existing thing to a queue, but is queue-of-work not queue-of-events).
- [`db/migrations/0002_seed_sources_config.sql`](db/migrations/0002_seed_sources_config.sql) — 6 seeded sources; no `source_type` (family) column today.
- [`db/migrations/0003_seed_score_weights.sql`](db/migrations/0003_seed_score_weights.sql) — 9 seeded scoring dimensions; missing spec §16.2 "Strategic fit" and "Confidence".

### Score writer and source coupling

- [`n8n/build_score_and_cluster_workflow.mjs`](n8n/build_score_and_cluster_workflow.mjs) — the live scorer. Specific lines:
  - Lines 28-48: bulk insert SQL with `ON CONFLICT (canonical_id, run_date) DO NOTHING` — blocks rescoring.
  - Line 187: `run_id = 'run_wf_score_and_cluster_' + Date.now()` — n8n run, not a domain `scoring_run_id`.
  - Lines 197-200: `IDENTITY_WORDS`, `OCCASION_WORDS`, `BRAND_CELEB_RISK_WORDS`, `NEWS_EVENT_RISK_WORDS` — wordlists used by `deriveRisk` to compute `compliance_risk` and `risk_flags` from term text.
  - Lines 217, 222-224: hardcoded source names `etsy_autocomplete`, `amazon_movers`, `google_trends`, `pinterest_trends`, `tiktok_creative` — spec FR-010 violation.
  - Lines 240, 288: `scorerVersion = '1.0.0'` hardcode — version is not part of the conflict key.
  - Lines 296-303: hard-block on `compliance_risk='high'` happens inside the Code node.
  - Lines 321-357: LLM clustering. Receives `canonical_ids` per cluster and discards them after computing `term_count` (line 352). `cluster_members` is never populated.
  - Lines 121-135, 371-374: writes to `dual_write_mirror_log` even though the Sheets mirror is gone.
  - Line 389: schedule = `0 0 7 * * *` (daily 07:00 Europe/London).

### Other workflow builders / JSON

- [`n8n/build_publish_queue_workflow.mjs`](n8n/build_publish_queue_workflow.mjs) — schedule line 148 (`0 45 7 * * *`); idempotent upsert SQL lines 73-86.
- [`n8n/wf_publish_queue.json`](n8n/wf_publish_queue.json) — `fallback_scores` CTE at line 125 (Sheets-era backfill from Tier C `opportunity_scores`).
- [`n8n/wf_collect_trends.json`](n8n/wf_collect_trends.json) — schedule lines 245-246 (`0 0 6 * * *`); inline `slugify` and `validateRow` near line 471 (per-row contract validation, signal-only).
- [`n8n/wf_normalize_terms.json`](n8n/wf_normalize_terms.json) — schedule lines 213-214 (`0 20 6 * * *`); `Build normalized terms` Code node near line 425 builds `canonical_id = 'norm_' + slugify(term)`.
- [`n8n/wf_enrich_marketplace.json`](n8n/wf_enrich_marketplace.json) — schedule lines 212-213 (`0 35 6 * * *`).

### Observability and gating

- [`n8n/phase1-gate.mjs`](n8n/phase1-gate.mjs):
  - Lines 50-72: `REQUIRED_TABLES` minimum-column check; needs to be extended for new tables.
  - Lines 74-81: `EXPECTED_SOURCE_NAMES` — the 6 seeded sources.
  - Lines 388-411: Gate 6 parity check between `trend_scores.total_score` and `opportunity_scores.opportunity_score` — coupled to today's dual-write.
- [`n8n/validate-workflows.mjs`](n8n/validate-workflows.mjs) — connection-graph cycle guard ([`SPRINT_CLOSEOUT.md`](SPRINT_CLOSEOUT.md) "Root cause summary" item 1).
- [`n8n/check-mirror-consistency.mjs`](n8n/check-mirror-consistency.mjs) — vestigial post-cutover.
- [`db/views/v_dashboard_summary.sql`](db/views/v_dashboard_summary.sql), [`db/views/v_feedback_rollup.sql`](db/views/v_feedback_rollup.sql), [`db/views/v_publish_queue_status.sql`](db/views/v_publish_queue_status.sql), [`db/views/v_source_health_today.sql`](db/views/v_source_health_today.sql), [`db/views/v_stage_run_health_24h.sql`](db/views/v_stage_run_health_24h.sql) — current observability surface; none cover Layer 2.

### Vestigial artefacts to track during transition

- Root-level CommonJS modules (already enumerated in "Strongly Recommended"). All use `module.exports` despite [`package.json`](package.json) declaring `"type": "module"`.
- [`SPRINT_CLOSEOUT.md`](SPRINT_CLOSEOUT.md) — describes Postgres + n8n cutover; not a contract document.
- [`sprint-plan.md`](sprint-plan.md) — line 22 still asserts "centered on the spreadsheet tabs created by `setup_sheets.gs`"; out of date and should be superseded by Layer 2 documentation.
- [`archive/sheets/`](archive/sheets/) — historical Apps Script source; do not edit.
- [`backups/`](backups) — n8n workflow snapshots and execution audits from the cutover; reference only.

### Verifying claims about what is not in the repo

These are negative findings — reviewers can confirm by running the same searches:

- "outbox", "event_id", "aggregate_type", "trend_batch_ready", "opportunity_scored", "scoring_run", "opportunity_candidate" appear only in [`oportunity-scoring-spec-layer-2.md`](oportunity-scoring-spec-layer-2.md). Repo-wide ripgrep returns no other matches.
- `cluster_members`, `cluster_history`, `cluster_review_queue`, `cluster_metrics` appear only in DDL ([`db/migrations/0001_init.sql`](db/migrations/0001_init.sql)), the Sheets backfill ([`db/backfill_sheets_to_pg.mjs`](db/backfill_sheets_to_pg.mjs)), the legacy Apps Script ([`archive/sheets/extend_clustering_schema.gs`](archive/sheets/extend_clustering_schema.gs)), and the vestigial root module [`clusterHistoryTracker.js`](clusterHistoryTracker.js). No n8n workflow writes to them.
- No `n8n-nodes-base.executeWorkflow` node appears in any of the seven `n8n/wf_*.json` files. Inter-workflow chaining is cron-temporal only.
