# Layer 2 Decisions Log

Each item from the "Decisions Needed" section of `LAYER2_IMPLEMENTATION_READINESS_CHECKLIST.md` gets one block.

Format (one per decision):

```
## decision: <id>
status: pending | resolved | deferred
owner: <name or team>
decided_at: <yyyy-mm-dd or empty>
resolution: <one-paragraph summary, or 'pending'>
```

The Layer 2 readiness gate (`npm run layer2:readiness`) parses this file and treats `status: resolved` (with non-empty `owner` + `resolution`) as a PASS. `status: deferred` is also acceptable. Anything else is a FAIL for that decision.

---

## decision: contract_version_policy
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: Use a single global `contract_version` string on every `canonical_signals` row (e.g. `2026-05-01`). Bump the version only on breaking contract changes (rename/remove required semantics, dedupe_key meaning); additive JSON fields may ship without a bump if validators tolerate extras. Per-source contract versions are out of scope for v1.

## decision: identity_strategy
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: New Layer 2 entities use UUID primary keys (`scoring_runs`, `workflow_outbox`, `opportunity_candidate`, `opportunity_score`, `opportunity_score_factor`, `trend_cluster_v2`). Existing Layer 1 and legacy surfaces keep TEXT keys (`normalized_terms.canonical_id`, legacy `opportunity_scores` / views) to avoid a big-bang dashboard migration.

## decision: replay_strategy
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: One `opportunity_candidate` per `canonical_id` (unchanged). Replay and rescoring create a new `scoring_run_id` and append a new `opportunity_score` row for the same `opportunity_id` via `UNIQUE (opportunity_id, scoring_run_id)`; do not clone the candidate per replay. This matches append-only score history in spec §18.3.

## decision: state_machine_ownership
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: `readiness_status` is owned only on `opportunity_candidate`. The scoring workflow sets automated transitions; the Layer 2 API sets human review transitions; break-glass changes use a documented SQL runbook. `opportunity_lifecycle_log` and outbox events record material transitions for audit.

## decision: outbox_consumer_model
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: The standalone Node ESM worker `services/outbox-publisher` (`npm run outbox:publish`) is v1, using `FOR UPDATE SKIP LOCKED`. Run a single replica under process supervision (restart on exit); do not scale out until leader election or aggregate partitioning is defined.

## decision: schema_namespacing
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: Stay in `public` for Layer 2 v1. Revisit `intake.` / `scoring.` / `workflow.` / `analytics.` namespacing as a planned v2 migration after inventory of n8n SQL and dashboard queries.

## decision: compatibility_surface
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: Option B is confirmed: original `opportunity_scores` and `trend_scores` tables are renamed to `*_legacy`; dashboard-facing names are `CREATE VIEW` over the new Layer 2 tables. Retain legacy physical tables for forensics until a follow-up sprint retires them.

## decision: hard_block_risk_policy
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: v1 keeps high-risk short-circuit in the scorer (`layer2_score_code.js`) while `canonical_signals.risk_flags` is populated at intake so the scorer becomes read-preferring over regex. v2 may introduce a `risk_rules` table or config once rules stabilize.

## decision: confidence_threshold
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: Production defaults: `LAYER2_APPROVE_THRESHOLD=75` and `LAYER2_REVIEW_THRESHOLD=55`, documented in `.env.example` and project docs. Changes are operational (env-only), tuned using review-queue depth and Gate 6 / business feedback.

## decision: clustering_strategy
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: Default `CLUSTER_ENGINE=deterministic` in production for replayability and cost. `CLUSTER_ENGINE=llm` remains for experiments and A/B via `v_cluster_strategy_comparison`; schedule removal of the LLM path after a target date if metrics match.

## decision: first_outbox_consumer
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: `wf_publish_queue` is the first consumer of completed `opportunity_approved_for_creative` outbox events (joined to `opportunity_candidate`). Keep `range_briefs` in the publish UNION until range-brief generation reads `v_approved_opportunities` or equivalent events; then remove legacy overlap in a follow-up change.

## decision: vestigial_js_modules
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: Root-level CommonJS modules remain archived under `archive/legacy-modules/` as reference-only. Active logic lives in `n8n/lib/clusterer.mjs`, `services/cluster-engine`, and `services/weight-calibrator`; no further copies at repo root.

## decision: handedit_policy
status: resolved
owner: TA
decided_at: 2026-05-03-0805
resolution: JS workflow builders are the source of truth; committed `n8n/wf_*.json` is regenerated from builders. CI or pre-merge steps run builders plus `npm run n8n:validate` when workflow JSON changes; no ad-hoc hand-edits without a builder change in the same change set.
