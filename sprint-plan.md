# Sprint Plan: POD Research Pipeline (Layer 1)

## Purpose

Build and harden the end-to-end workflow that turns raw trend signals into ranked, clustered, briefed, and publishable product opportunities.

**Layer 1** is this pipeline: structured storage and orchestration from collection through publishing feedback. Postgres is the system of record (Google Sheets is archived under `archive/sheets/`). Downstream **Layer 2** scoring, lifecycle, and explainability are specified separately (`oportunity-scoring-spec-layer-2.md`, `LAYER2_IMPLEMENTATION_READINESS_CHECKLIST.md`).

The system is organized into seven functional stages:

1. Collect raw signals
2. Normalize and deduplicate
3. Enrich with keyword and marketplace context
4. Score opportunities
5. Cluster into themes
6. Generate range briefs
7. Push shortlisted briefs into a publishing queue

Canonical workflow source note:

- The bundled range-brief workflow at `n8n/wf_generate_range_briefs_and_phrase_expansion.json`
  is the canonical source for Stage 6.

## Data model (Postgres)

Handoffs align with the migrated schema in `db/migrations/0001_init.sql` and later migrations. Core tables by concern:

- **Intake and lineage:** `sources_config`, `raw_signals`, `normalized_terms`, lineage columns (`0005_lineage_and_source_type.sql`), `canonical_signals` (`0006_canonical_signals.sql`)
- **Orchestration:** `workflow_runs`, `workflow_outbox` (`0007_workflow_outbox.sql`) (legacy mirror retired in `0015_retire_dual_write_mirror_log.sql`; live writes stopped in Phase 1)
- **Enrichment and scores:** `marketplace_evidence`, `trend_scores`, `opportunity_scores`, `score_components`, `score_weights`, `score_weight_history` (`0011_score_weight_history.sql`), `scoring_audit_log`, `scoring_runs` (`0008_scoring_runs.sql`)
- **Themes and briefs:** `theme_clusters`, `range_briefs`, `phrase_bank`, `watchlist`
- **Publishing and feedback:** `publishing_queue`, `performance_feedback`
- **Layer 2 adjacent:** opportunity lifecycle and related entities (`0009_layer2_entities.sql` onward)

Contract validation for canonical intake uses `db/contracts/canonical_signal_v1.json` and `db/contract_validator.mjs`.

## Stage 1: Collect Raw Signals

### Functionality

Collects trend, keyword, and marketplace signals from source providers and writes the first pass of observations into `raw_signals`.

### Inputs

- Source configuration from `sources_config`
- Search surfaces such as Google Trends, Etsy autocomplete, Pinterest-style trend sources, CSV imports, and similar signal feeds
- Runtime metadata such as run ID, run timestamp, and market

### Processing

- Fan out to source-specific branches
- Fetch raw signal payloads
- Standardize source records into a common row shape
- Preserve source metadata and raw payload JSON for traceability

### Outputs

- `raw_signals` rows
- `workflow_runs` status row

### Risks

- External source outages or HTML/API shape changes
- Incomplete coverage if a source branch is still a placeholder
- Duplicate signal capture across sources

## Stage 2: Normalize and Deduplicate

### Functionality

Converts raw signal rows into canonical terms and merges duplicates into a single normalized record.

### Inputs

- `raw_signals`
- Existing `normalized_terms`
- Language and market context

### Processing

- Normalize casing, punctuation, and trivial variants
- Collapse aliases into one canonical term
- Assign canonical IDs
- Track first-seen and last-seen dates
- Mark unresolved or low-confidence records for review
- Upsert `canonical_signals` where the contract applies

### Outputs

- `normalized_terms`
- Optional `watchlist` updates for ambiguous or low-quality terms

### Risks

- Over-aggressive merging that collapses distinct opportunities
- Under-merging that leaves near-duplicates in the pipeline
- Locale-specific normalization mistakes

## Stage 3: Enrich With Keyword and Marketplace Context

### Functionality

Adds buyer-intent and commercial context to each normalized term by collecting supporting keyword and marketplace evidence.

### Inputs

- `normalized_terms`
- Search/autocomplete sources
- Marketplace surfaces and product category clues

### Processing

- Expand terms into keyword variants and commercial modifiers
- Capture marketplace phrases, product types, and intent indicators
- Rank evidence strength
- Attach enrichment back to canonical IDs

### Outputs

- `marketplace_evidence`
- Optional supporting context for later scoring

### Risks

- Weak keyword evidence that does not map cleanly to product opportunities
- Marketplace source drift
- Missing source coverage for niche terms

## Stage 4: Score Opportunities

### Functionality

Evaluates each canonical term as a product opportunity and assigns a decision score.

### Inputs

- `normalized_terms`
- `marketplace_evidence`
- Historical context where available

### Processing

- Score momentum, POD fit, buyer intent, range depth, novelty, and risk
- Compute a weighted total score
- Emit a decision such as keep, watch, or discard
- Record scoring runs when using the `scoring_runs` path

### Outputs

- `opportunity_scores`
- `score_components`
- `scoring_audit_log`
- `normalized_terms` score metadata updates

### Risks

- Score weights that are too optimistic or too strict
- Missing evidence causing good ideas to score too low
- Risk metrics that fail to filter unsuitable opportunities

## Stage 5: Cluster Into Themes

### Functionality

Groups related canonical terms into theme-level opportunity clusters that can support a range or collection brief.

### Inputs

- `trend_scores`
- `normalized_terms`
- `marketplace_evidence`

### Processing

- Group highly related terms by audience, theme, or aesthetic
- Merge adjacent opportunities when they share the same market story
- Summarize each cluster in plain language
- Assign priority and seasonality where relevant

### Outputs

- `theme_clusters`

### Risks

- Clusters that are too broad to brief effectively
- Clusters that are too narrow and miss collection-level cohesion
- Duplicate clusters across consecutive runs

## Stage 6: Generate Range Briefs

### Functionality

Turns a cluster into a brief that can be used by designers, merch planners, or downstream generation workflows.

### Inputs

- `theme_clusters`
- `trend_scores`
- Supporting keyword and marketplace evidence

### Processing

- Produce a range title and hero angle
- Describe best products, design directions, and phrase concepts
- Capture audience and IP risk notes
- Generate phrase variants for later reuse

### Outputs

- `range_briefs`
- `phrase_bank`

### Risks

- Briefs that are too generic to execute
- Phrase generation that is repetitive or derivative
- IP-risk wording that is not conservative enough

## Stage 7: Push Shortlisted Briefs Into a Publishing Queue

### Functionality

Selects the strongest briefs and sends them into a downstream queue for review, publishing, or handoff to a content system.

### Inputs

- `range_briefs`
- `theme_clusters`
- Priority and quality thresholds

### Processing

- Filter by score, novelty, risk, and business fit
- Create a queue record with status and review metadata (`publishing_queue`)
- Preserve traceability back to the originating cluster and canonical terms

### Outputs

- Publishing queue entries
- Optional notifications or approval tasks

### Risks

- Publishing too many low-value briefs
- Missing moderation or approval gates
- Queue duplication when reruns occur

## Feedback Loop

### Functionality

Captures post-launch performance feedback and uses it to recalibrate scoring weights over time.

### Inputs

- `performance_feedback`
- `opportunity_scores`
- `score_weights`

### Processing

- Deduplicate feedback records
- Store feedback rows in Postgres
- Recompute score weights when the feedback sample is large enough (see `npm run weights:recalibrate`)

### Outputs

- `performance_feedback`
- `score_weights` / `score_weight_history`

### Risks

- Feedback never arrives if the webhook is not wired to a publishing source
- Insufficient sample size for useful recalibration
- Feedback rows that cannot be matched back to scored opportunities

## Suggested sprint order

### Sprint 1: Stabilize intake and normalization

- Make Stage 1 produce complete, non-placeholder `raw_signals`
- Make Stage 2 produce canonical `normalized_terms` and valid contract rows where applicable
- Add basic duplicate handling and workflow run logging

### Sprint 2: Add enrichment and scoring

- Implement Stage 3 marketplace and keyword enrichment
- Implement Stage 4 scoring with explicit weights and decision rules
- Confirm all rows map cleanly back to canonical IDs

### Sprint 3: Add clustering and briefs

- Implement Stage 5 cluster formation and summaries
- Implement Stage 6 range brief generation and phrase bank output
- Validate brief quality against empty and dense input sets

### Sprint 4: Publish queue and operational hardening

- Implement Stage 7 publishing queue handoff (Postgres-backed)
- Add review gates, deduplication, and retry protection
- Tighten workflow observability and error handling

## Acceptance criteria

- Each stage writes to the expected Postgres tables without manual repair
- A full scheduled run completes from raw signals to brief generation
- Empty or partial input does not crash the chain
- Duplicate terms and duplicate briefs are handled predictably
- Workflow runs are logged with enough detail to debug failures

## Notes

- The repository contains committed workflow JSON, JS builders for four workflows, and operational scripts under `services/` and `tests/`.
- The publishing queue is represented as the `publishing_queue` table and `wf_publish_queue`.
- For adding feeds without changing core Layer 2 entities, follow `docs/onboarding-a-new-source.md`.
