# Layer 2 Readiness Report

Generated: 2026-05-03T16:30:54.684Z  |  Repo HEAD: ?  |  Verdict: **READY**

Flags: `--run-tests`, `--sections`

## Summary
- Must Complete: 31 total (31 pass)
- Strongly Recommended: 10 total (10 pass)
- Can Be Deferred: 11 total (8 pass, 3 deferred)
- Decisions Needed: 13 total (13 pass)

## Must Complete

| ID | Title | Status | Evidence | Fix |
| -- | -- | -- | -- | -- |
| `must.schema.canonical_signals_table` | canonical_signals table with required columns and unique key | PASS | 25 cols (>=22); UNIQUE(dedupe_key,contract_version)=true; status idx=true |  |
| `must.schema.workflow_outbox_table` | workflow_outbox table with status+scheduled index | PASS | cols=10; idx(status,scheduled)=true; idx(aggregate)=true |  |
| `must.schema.scoring_runs_table` | scoring_runs table with trigger_type/status check constraints | PASS | cols=9; trigger_type CHECK=true; status CHECK=true; idx=true |  |
| `must.schema.opportunity_score_runid_uniqueness` | opportunity_score keyed by (opportunity_id, scoring_run_id), legacy retained | PASS | UNIQUE(opportunity_id,scoring_run_id)=true; opportunity_scores_legacy.relkind=r |  |
| `must.schema.raw_signals_canonical_fk` | raw_signals.canonical_id FK + idx_raw_signals_canonical | PASS | column=true; FK=true; idx=idx_raw_signals_canonical |  |
| `must.schema.sources_config_source_type` | sources_config.source_type column + 6 expected mappings | PASS | 7 rows; 0 mismatches |  |
| `must.contract.schema_file` | db/contracts/canonical_signal_v1.json present and parses | PASS | parsed; keys=$schema,$id,title,type,additionalProperties,required,properties |  |
| `must.contract.validator_module` | db/contract_validator.mjs exports validateCanonicalSignal | PASS | validator returns {ok,reasons}; sample reasons=8 |  |
| `must.contract.intake_writes_canonical` | wf_normalize_terms writes canonical_signals | PASS | INSERT/UPSERT canonical_signals SQL string found |  |
| `must.contract.version_policy_documented` | contract_version policy documented in db/README.md | PASS | contract_version mentioned in db/README.md |  |
| `must.contract.source_type_seeded` | sources_config seeded mapping correct (DB) | PASS | amazon_movers->marketplace, csv_upload->csv, etsy_autocomplete->marketplace, google_kw_planner->search, google_trends->search, pinterest_trends->social, tiktok_creative->social |  |
| `must.workflow.no_hardcoded_sources` | scorer hot path has no hardcoded source_name string switches | PASS | no JS-level source-name switches in scorer hot path |  |
| `must.workflow.cluster_members_written` | wf_score_and_cluster writes cluster_members_v2 | PASS | INSERT INTO cluster_members_v2 present; trend_cluster_v2=0, cluster_members_v2=0 |  |
| `must.workflow.scoring_run_per_execution` | wf_score_and_cluster opens one scoring_runs row per execution | PASS | scoring_runs INSERT + RETURNING present; scoring_runs(7d)=9 |  |
| `must.workflow.outbox_events_in_scorer` | wf_score_and_cluster emits workflow_outbox events | PASS | SQL present; outbox(7d)={"opportunity_needs_review":10,"opportunity_scored":10} |  |
| `must.workflow.no_mirror_writes` | no dual_write_mirror_log writes in any wf_*.json | PASS | no wf_*.json file mentions dual_write_mirror_log |  |
| `must.workflow.publish_queue_consumes_outbox` | wf_publish_queue reads from workflow_outbox; no fallback_scores CTE | PASS | wf_publish_queue reads outbox, no fallback_scores |  |
| `must.workflow.outbox_publisher_present` | services/outbox-publisher exists and npm script registered | PASS | publisher and npm run outbox:publish present |  |
| `must.observability.view_v_canonical_signal_health` | view v_canonical_signal_health present | PASS | view exists in DB and repo |  |
| `must.observability.view_v_scoring_run_health` | view v_scoring_run_health present | PASS | view exists in DB and repo |  |
| `must.observability.view_v_workflow_outbox_health` | view v_workflow_outbox_health present | PASS | view exists in DB and repo |  |
| `must.observability.view_v_lineage_explorer` | view v_lineage_explorer present | PASS | view exists in DB and repo |  |
| `must.observability.view_v_score_factor_breakdown` | view v_score_factor_breakdown present | PASS | view exists in DB and repo |  |
| `must.observability.view_v_review_queue` | view v_review_queue present | PASS | view exists in DB and repo |  |
| `must.observability.view_v_approved_opportunities` | view v_approved_opportunities present | PASS | view exists in DB and repo |  |
| `must.observability.phase1_gate_extended` | phase1-gate.mjs REQUIRED_TABLES includes Layer 2 entities | PASS | REQUIRED_TABLES contains all 7 Layer 2 tables |  |
| `must.observability.gates_7_and_8_implemented` | phase1-gate.mjs defines gate7CheckOutboxHealth + gate8CheckCanonicalSignalContract | PASS | gate7 + gate8 defined |  |
| `must.testing.contract_test` | tests/contract.test.mjs present | PASS | contract test file present |  |
| `must.testing.replay_invariant_test` | replay invariant test (tests/replay.test.mjs) | PASS | replay test file present |  |
| `must.testing.cycle_guard` | n8n workflow cycle-guard validation | PASS | npm run n8n:validate exited 0 |  |
| `must.testing.npm_test_green` | npm run test passes | PASS | npm run test exited 0 |  |

## Strongly Recommended

| ID | Title | Status | Evidence | Fix |
| -- | -- | -- | -- | -- |
| `should.schema.first_class_risk_flags` | canonical_signals has risk_flags / audience_hint / seasonality_hint as columns | PASS | all 3 columns present |  |
| `should.schema.confidence_score_column` | opportunity_score.confidence_score (NOT NULL) | PASS | confidence_score NOT NULL |  |
| `should.schema.readiness_status_column` | opportunity_candidate.readiness_status with 8 lifecycle states | PASS | CHECK covers 8 lifecycle states |  |
| `should.schema.factor_reason_evidence_refs` | opportunity_score_factor has factor_reason + evidence | PASS | factor_reason + evidence present |  |
| `should.workflow.outbox_driven_inter_workflow` | downstream workflows are outbox-driven, not cron-only | PASS | publish_queue + briefs both consume outbox/approved view |  |
| `should.workflow.no_handedits_helper` | n8n/_apply_pg_handedits.mjs absent | PASS | file removed |  |
| `should.workflow.vestigial_js_archived` | 11 vestigial CommonJS modules moved under archive/legacy-modules/ | PASS | all 11 modules archived |  |
| `should.compat.trend_scores_is_view` | trend_scores is a view; trend_scores_legacy is the table | PASS | trend_scores=v; trend_scores_legacy=r |  |
| `should.observability.score_distribution_views` | score-distribution-by-source-family view present | PASS | view file present |  |
| `should.observability.deadletter_alerting` | v_workflow_outbox_health exposes deadletter_count | PASS | view exposes deadletter signal |  |

## Can Be Deferred

| ID | Title | Status | Evidence | Fix |
| -- | -- | -- | -- | -- |
| `defer.api.fastify_server` | Layer 2 HTTP API server with required routes | PASS | all 5 spec §19.3 routes declared |  |
| `defer.api.token_auth` | API token auth via LAYER2_API_TOKEN | PASS | LAYER2_API_TOKEN referenced |  |
| `defer.cluster.deterministic_engine` | Deterministic clustering engine (services/cluster-engine + flag) | PASS | services/cluster-engine + lib + CLUSTER_ENGINE flag present |  |
| `defer.cluster.strategy_view` | v_cluster_strategy_comparison view present | PASS | view file present |  |
| `defer.weights.calibrator` | Weight calibrator (service + history table + view) | PASS | calibrator + migration + view all present |  |
| `defer.review.ui` | Review queue (UI route + lifecycle log + view) | PASS | review UI + decision route + lifecycle log + view present |  |
| `defer.multi_source.csv` | CSV importer + onboarding doc | PASS | CSV importer + mapping + seed + doc present |  |
| `defer.cleanup.dual_write_mirror_table` | dual_write_mirror_log retired (renamed to *_legacy; drop candidate) | PASS | renamed to dual_write_mirror_log_legacy; last write: 2026-05-02T10:48:43.078Z |  |
| `defer.cleanup.dormant_cluster_tables` | Dormant cluster tables (cluster_history / cluster_review_queue / cluster_metrics) | DEFERRED | row counts: {"cluster_history":0,"cluster_review_queue":0,"cluster_metrics":0} |  |
| `defer.identity.uuid_canonical_id` | Replace slugify(term) canonical_id with UUID (Layer 2 v2) | DEFERRED | explicitly deferred per checklist |  |
| `defer.namespace.schemas` | Schema namespacing (intake./scoring./workflow./analytics.) | DEFERRED | not yet decided / not yet executed |  |

## Decisions Needed

| ID | Title | Status | Evidence | Fix |
| -- | -- | -- | -- | -- |
| `decision.contract_version_policy` | Decision recorded: contract_version_policy | PASS | status=resolved; owner=TA |  |
| `decision.identity_strategy` | Decision recorded: identity_strategy | PASS | status=resolved; owner=TA |  |
| `decision.replay_strategy` | Decision recorded: replay_strategy | PASS | status=resolved; owner=TA |  |
| `decision.state_machine_ownership` | Decision recorded: state_machine_ownership | PASS | status=resolved; owner=TA |  |
| `decision.outbox_consumer_model` | Decision recorded: outbox_consumer_model | PASS | status=resolved; owner=TA |  |
| `decision.schema_namespacing` | Decision recorded: schema_namespacing | PASS | status=resolved; owner=TA |  |
| `decision.compatibility_surface` | Decision recorded: compatibility_surface | PASS | status=resolved; owner=TA |  |
| `decision.hard_block_risk_policy` | Decision recorded: hard_block_risk_policy | PASS | status=resolved; owner=TA |  |
| `decision.confidence_threshold` | Decision recorded: confidence_threshold | PASS | status=resolved; owner=TA |  |
| `decision.clustering_strategy` | Decision recorded: clustering_strategy | PASS | status=resolved; owner=TA |  |
| `decision.first_outbox_consumer` | Decision recorded: first_outbox_consumer | PASS | status=resolved; owner=TA |  |
| `decision.vestigial_js_modules` | Decision recorded: vestigial_js_modules | PASS | status=resolved; owner=TA |  |
| `decision.handedit_policy` | Decision recorded: handedit_policy | PASS | status=resolved; owner=TA |  |

---
Run with `npm run layer2:readiness` (status only), `npm run layer2:readiness:report` (regenerate this file), or `npm run layer2:readiness:full` (report + `npm test` + `n8n:validate`).
