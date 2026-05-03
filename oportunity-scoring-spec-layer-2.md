Layer 2 Opportunity Scoring Specification
1. Document control
Field	Value
Document title	Layer 2 Opportunity Scoring Specification
System name	Autonomous Ideas Signals
Layer	Layer 2
Status	Draft
Version	0.1.0
Owner	TBD
Technical owner	TBD
Product owner	TBD
Last updated	2026-05-02
Related repo	https://github.com/nicksinx/autonomous-ideas-signals
Depends on Layer 1 contract version	TBD
Initial scoring model version	score_v1
2. Purpose
Layer 2 converts normalized intake outputs from Layer 1 into ranked, explainable, versioned opportunity candidates that can be routed to creative generation, human review, or rejection. The design is intended to remain stable as new intake feed sources are added to Layer 1, which means Layer 2 depends on a canonical upstream contract rather than on any feed-specific raw schema.

This specification defines the functional requirements, data contracts, lifecycle rules, scoring model, event model, and acceptance criteria for Layer 2. The structure follows a modular software requirements approach so implementation, testing, and future iteration can happen without repeated architectural redesign.

3. Scope
3.1 In scope
Layer 2 is responsible for:

Consuming canonical Layer 1 records from Postgres.

Grouping related records into clusters or candidate themes.

Producing one or more opportunity candidates from clustered evidence.

Scoring opportunities using a versioned multi-factor model.

Storing factor explanations, lineage, and score history.

Emitting downstream workflow events and stable read models.

Supporting replay and rescoring when upstream data or scoring rules change.

Remaining compatible with additional Layer 1 feed sources so long as they conform to the canonical contract.

3.2 Out of scope
Layer 2 is not responsible for:

Collecting raw external data.

Feed-specific parsing or normalization.

Final creative prompt generation.

Image generation.

Marketplace publishing.

Final merchandising decisions beyond defined review states.

4. Design goals
4.1 Primary goals
Provide a durable, explainable, and testable opportunity scoring layer.

Keep Layer 2 insulated from future source proliferation in Layer 1.

Preserve lineage from opportunity back to contributing source records.

Support both event-driven processing and replay/rescore workflows.

Make scoring changes auditable through strict versioning.

4.2 Non-goals
Building a fully ML-driven ranker in v1.

Supporting raw source-native payloads in Layer 2.

Using spreadsheets as operational storage or orchestration.

5. Architectural principles
5.1 Canonical upstream contract
Layer 2 must consume only a canonical Layer 1 contract, not source-native payloads, because explicit data contracts reduce schema drift and make new producer onboarding safer and more predictable. All feed-specific adapters and raw-to-canonical mapping must remain in Layer 1.

5.2 Additive evidence model
New feed sources should add optional evidence or enrichment, but should not require rewriting core Layer 2 entities. This aligns with contract-based ingestion practice, where interfaces evolve explicitly rather than through hidden parsing assumptions.

5.3 Reliable workflow publication
Business state changes and downstream workflow triggers should use a transactional outbox so durable records and downstream events are persisted atomically. That reduces dual-write inconsistency and supports replay, retry, and auditability.

5.4 Versioned decisions
The following must be versioned:

canonical contract version

clustering logic version

candidate derivation version

score model version

factor weight set version

downstream event schema version

6. Context
6.1 Upstream context
Layer 1 collects and normalizes signals from one or more sources into Postgres. Future feed sources may include marketplace APIs, search trend feeds, social listening, review mining, ad libraries, CSV imports, or internal historical performance datasets. Layer 2 must remain stable as long as those sources are mapped into the canonical Layer 1 contract.

6.2 Downstream context
Layer 2 outputs are consumed by:

creative generation workflows

review dashboards

analytics and reporting

experiment queues

backtesting and tuning processes

7. Glossary
Term	Definition
Canonical signal	A normalized Layer 1 record independent of source-native format.
Source feed	A raw producer connected into Layer 1.
Trend cluster	A grouped set of related canonical signals representing the same commercial pattern.
Opportunity candidate	A scored, explainable opportunity derived from one or more clusters.
Score factor	A named component of the total opportunity score.
Confidence score	A measure of how trustworthy the score is given evidence completeness and agreement.
Lineage	Traceability from Layer 2 entities back to Layer 1 and raw sources.
Scoring run	A distinct processing execution for a defined scope of data.
Outbox event	A durable event persisted in the database for later processing/publication.
8. Assumptions and constraints
Postgres is the system of record for Layers 1 and 2.

Layer 1 emits canonical records into stable tables, views, or workflow events.

Layer 2 may operate as workers or services, but its durable truth lives in Postgres.

Delivery semantics are at least once, so consumers must be idempotent.

Layer 2 must tolerate missing optional evidence and degrade confidence rather than fail whenever possible.

Layer 2 must support replay and rescoring over historical data.

Feed-specific fields may exist in metadata, but Layer 2 must not require them for core operation.

9. High-level flow
Layer 1 marks canonical signals as ready.

Layer 2 discovers eligible records or consumes a readiness event.

Layer 2 groups signals into clusters.

Layer 2 derives opportunity candidates from clusters.

Layer 2 enriches candidates with computed context.

Layer 2 calculates factor-level scores.

Layer 2 calculates total score and confidence.

Layer 2 stores rationale and score history.

Layer 2 transitions candidate state.

Layer 2 emits outbox events for downstream consumers.

10. Canonical upstream contract
This is the minimum contract Layer 2 requires from Layer 1. New intake sources must be mapped into this contract before they can affect Layer 2 behavior.

10.1 Canonical signal entity
Field	Type	Required	Description
signal_id	UUID / text	Yes	Unique canonical signal ID.
contract_version	text	Yes	Schema version.
source_type	text	Yes	Feed family, such as marketplace, search, social, reviews.
source_name	text	Yes	Specific source identifier.
source_record_id	text	No	Original upstream record identifier.
intake_run_id	UUID / text	Yes	Layer 1 run that produced the record.
observed_at	timestamptz	Yes	Source event timestamp.
ingested_at	timestamptz	Yes	Layer 1 ingestion timestamp.
normalized_topic	text	Yes	Canonical topic or idea family.
normalized_niche	text	No	Canonical niche label.
normalized_sub_niche	text	No	Canonical sub-niche label.
audience_hint	jsonb	No	Structured or semi-structured audience signals.
product_type_hints	jsonb	No	Product categories implied by the signal.
trend_metrics	jsonb	No	Counts, deltas, recency, velocity, engagement proxies.
sentiment_metrics	jsonb	No	Sentiment scores where available.
competition_metrics	jsonb	No	Saturation or gap indicators where available.
seasonality_hint	jsonb	No	Seasonal timing, event windows, date tags.
enrichment	jsonb	No	Additional normalized features.
risk_flags	jsonb	No	Legal, policy, quality, ambiguity flags.
quality_score	numeric	No	Upstream confidence or data quality measure.
lineage	jsonb	Yes	Provenance sufficient to trace back to original records.
dedupe_key	text	Yes	Stable dedupe/grouping key.
status	text	Yes	Ready, suppressed, invalid, archived, etc.
10.2 Contract requirements
Required fields must be validated before a record is exposed to Layer 2.

Source-specific fields must remain in metadata or enrichment unless promoted into the canonical contract.

New contract versions should be additive whenever possible.

Layer 2 must refuse unsupported breaking versions, or route them to quarantine.

11. Source capability matrix
Layer 2 should maintain a source capability matrix so the scoring engine can degrade gracefully when some evidence categories are absent.

Source type	Demand metrics	Competition metrics	Sentiment	Audience hints	Seasonality	Risk flags
Marketplace	TBD	TBD	TBD	TBD	TBD	TBD
Search trends	TBD	TBD	TBD	TBD	TBD	TBD
Social	TBD	TBD	TBD	TBD	TBD	TBD
Reviews	TBD	TBD	TBD	TBD	TBD	TBD
CSV/manual	TBD	TBD	TBD	TBD	TBD	TBD
12. Domain model
12.1 trend_cluster
Field	Type	Required	Description
cluster_id	UUID / text	Yes	Unique cluster ID.
cluster_key	text	Yes	Deterministic grouping key where applicable.
cluster_version	text	Yes	Clustering logic version.
primary_topic	text	Yes	Main topic label.
niche	text	No	Inferred niche.
sub_niche	text	No	Inferred sub-niche.
source_count	integer	Yes	Distinct source count.
signal_count	integer	Yes	Number of contributing signals.
supporting_signal_ids	jsonb	Yes	Signal references.
aggregate_metrics	jsonb	No	Summarized evidence across signals.
freshness_window	jsonb	No	Time span and freshness logic.
created_at	timestamptz	Yes	Created time.
updated_at	timestamptz	Yes	Updated time.
12.2 opportunity_candidate
Field	Type	Required	Description
opportunity_id	UUID / text	Yes	Unique opportunity ID.
candidate_version	text	Yes	Derivation logic version.
cluster_id	UUID / text	Yes	Parent cluster.
title	text	Yes	Human-readable opportunity title.
primary_niche	text	Yes	Primary niche.
sub_niche	text	No	Secondary niche.
target_audience	jsonb	No	Audience profile.
product_type_candidates	jsonb	No	Candidate product categories.
commercial_hypothesis	text	No	Why this could sell.
creative_hypotheses	jsonb	No	Potential design or offer directions.
market_context	jsonb	No	Market explanation blob.
risk_level	text	Yes	low, medium, high, blocked.
readiness_status	text	Yes	Lifecycle state.
latest_score_id	UUID / text	No	Pointer to latest score.
latest_score	numeric	No	Cached latest score.
latest_confidence	numeric	No	Cached confidence.
score_version	text	No	Latest scoring version.
created_at	timestamptz	Yes	Created time.
updated_at	timestamptz	Yes	Updated time.
12.3 opportunity_score
Field	Type	Required	Description
score_id	UUID / text	Yes	Unique score ID.
opportunity_id	UUID / text	Yes	Parent opportunity.
scoring_run_id	UUID / text	Yes	Run that produced it.
score_version	text	Yes	Scoring model version.
total_score	numeric	Yes	Final score.
confidence_score	numeric	Yes	Confidence in the score.
recommendation	text	Yes	Approve, review, reject, hold.
summary_reason	text	Yes	Human-readable explanation.
positive_drivers	jsonb	No	Top positive reasons.
negative_drivers	jsonb	No	Top negative reasons.
evidence_refs	jsonb	No	Supporting references.
created_at	timestamptz	Yes	Created time.
12.4 opportunity_score_factor
Field	Type	Required	Description
factor_id	UUID / text	Yes	Unique factor record ID.
score_id	UUID / text	Yes	Parent score ID.
factor_name	text	Yes	Factor key.
raw_value	numeric	No	Raw factor value.
weight	numeric	No	Weight used.
factor_value	numeric	Yes	Weighted or final factor contribution.
factor_reason	text	No	Factor-level explanation.
evidence	jsonb	No	Supporting data.
12.5 scoring_run
Field	Type	Required	Description
scoring_run_id	UUID / text	Yes	Unique scoring run ID.
trigger_type	text	Yes	event, batch, replay, manual, scheduled.
trigger_ref	text	No	Trigger reference.
scoring_version	text	Yes	Model version used.
scope	jsonb	Yes	What was processed.
status	text	Yes	pending, running, success, partial, failed.
metrics	jsonb	No	Run metrics.
started_at	timestamptz	Yes	Start time.
finished_at	timestamptz	No	End time.
12.6 workflow_outbox
Field	Type	Required	Description
event_id	UUID / text	Yes	Unique event ID.
aggregate_type	text	Yes	Entity type, such as opportunity.
aggregate_id	text	Yes	Entity ID.
event_type	text	Yes	Event name.
payload	jsonb	Yes	Event payload.
schema_version	text	Yes	Event schema version.
scheduled_at	timestamptz	Yes	Queue time.
processed_at	timestamptz	No	Processed time.
retry_count	integer	Yes	Retry count.
status	text	Yes	pending, processing, complete, deadletter.
13. Lifecycle and state machine
13.1 Opportunity states
State	Meaning
new	Candidate created but not yet score-eligible.
ready_for_scoring	Candidate has minimum data required for scoring.
scoring	Candidate is being processed in a scoring run.
scored	Score successfully created.
needs_review	Score or risk profile requires human review.
approved_for_creative	Candidate may enter Stage 5.
rejected	Candidate is not suitable.
archived	Candidate is no longer active.
13.2 Transition rules
The implementation should define:

minimum data needed to move from new to ready_for_scoring

thresholds for approved_for_creative

confidence thresholds for needs_review

risk flags that force needs_review or rejected

reactivation rules during rescoring

14. Functional requirements
ID	Requirement
FR-001	Layer 2 shall consume only canonical Layer 1 records that pass contract validation.
FR-002	Layer 2 shall cluster related signals into commercial themes or opportunity groups.
FR-003	Layer 2 shall create or update opportunity candidates from clusters.
FR-004	Layer 2 shall calculate a versioned opportunity score for eligible candidates.
FR-005	Layer 2 shall store factor-level breakdowns and score explanations.
FR-006	Layer 2 shall preserve lineage from opportunity to canonical signal to source feed.
FR-007	Layer 2 shall support replay and rescoring without destructive overwrites.
FR-008	Layer 2 shall emit downstream workflow events using an outbox pattern 
.
FR-009	Layer 2 shall degrade gracefully when optional evidence families are absent.
FR-010	Layer 2 shall remain compatible with new Layer 1 sources that conform to the canonical contract 
.
15. Future-proofing requirements
ID	Requirement
FP-001	New Layer 1 sources shall be onboarded by contract mapping, not by changing Layer 2 core entity design 
.
FP-002	Source-specific fields shall not become mandatory Layer 2 dependencies unless promoted into a versioned canonical contract.
FP-003	Factor logic shall accept optional evidence families and adjust confidence when evidence is missing.
FP-004	Layer 2 shall support mixed-source clusters when clustering logic determines records belong to the same opportunity.
FP-005	Event schemas and read models shall be versioned so downstream consumers remain stable as upstream breadth grows 
.
16. Scoring model
16.1 Scoring philosophy
The scoring model should be modular and interpretable rather than opaque. This allows new sources to add evidence without forcing a redesign of the score itself, and it keeps the system easier to audit and tune over time.

16.2 Required factor families
Factor family	Purpose
Demand strength	Measures evidence of buyer interest or momentum.
Competition gap	Measures whitespace versus saturation.
Conversion potential	Measures likely click and purchase appeal.
Creative viability	Measures whether distinctive assets can be produced.
Margin viability	Measures expected commercial economics.
Operational feasibility	Measures workflow and production compatibility.
Strategic fit	Measures alignment with broader portfolio goals.
Risk penalty	Applies deductions or hard blocks.
Confidence	Measures certainty and evidence quality.
16.3 Factor template
For each factor, specify:

purpose

required fields

optional fields

calculation logic

weight

output range

penalty or bonus rules

missing-data behavior

explainability notes

unit tests required

16.4 Confidence model
Confidence should be calculated separately from total score and should consider source diversity, data completeness, freshness, evidence agreement, source reliability, and how much of the candidate was inferred versus directly observed.

17. Validation rules
17.1 Eligibility for scoring
Rule	Required	If missing
Canonical topic	Yes	Reject or quarantine
Observed timestamp	Yes	Reject
Dedupe key	Yes	Reject
Lineage	Yes	Reject
At least one evidence family	Yes	Hold or review
Product hints	No	Infer later
Audience hints	No	Lower confidence
17.2 Deduplication
The implementation must define:

what Layer 1 guarantees at signal level

how Layer 2 deduplicates clusters

how Layer 2 deduplicates opportunities

how near-duplicates from different sources are reconciled

17.3 Freshness rules
The implementation must define:

freshness windows by source type

decay or staleness rules

archive behavior

rescoring triggers

18. Processing model
18.1 Trigger types
Trigger	Description
Event-driven	Triggered when Layer 1 marks data ready.
Batch	Scheduled processing of eligible records.
Replay	Re-score historical records under a new model version.
Manual	Operator-triggered run.
18.2 Recommended baseline
Use event-driven processing backed by Postgres tables plus a transactional outbox. This keeps durable state and workflow events consistent while supporting replay and retry without excessive infrastructure.

18.3 Idempotency requirements
the same trigger must not create duplicate candidates

duplicate event delivery must not produce duplicate business effects

rescoring should append history rather than mutate old score facts

19. Interface specification
19.1 Upstream interfaces
Possible supported upstream patterns:

canonical tables or views

readiness flags

outbox events such as trend_batch_ready

materialized views for eligible records

19.2 Downstream interfaces
Layer 2 should expose:

approved opportunity view

review queue view

score history view

source lineage inspection view

outbox events such as opportunity_scored and opportunity_approved_for_creative

19.3 API template
Method	Path	Purpose
POST	/scoring/runs	Trigger a scoring run
POST	/scoring/replay	Replay a historical scope
GET	/opportunities/{id}	Fetch full opportunity
GET	/opportunities/{id}/scores	Fetch score history
GET	/opportunities?status=approved_for_creative	Fetch approved opportunities
20. Event schemas
At minimum, define event contracts for:

trend_batch_ready

candidate_ready_for_scoring

opportunity_scored

opportunity_needs_review

opportunity_approved_for_creative

opportunity_rejected

Each event must include:

event_id

event_type

schema_version

aggregate_id

occurred_at

payload

traceability fields

21. Database considerations
21.1 Suggested schemas
intake for Layer 1 canonical outputs

scoring for Layer 2 domain entities

workflow for outbox/events

analytics for reporting views

21.2 Indexes
Define indexes for:

status

source_type

dedupe_key

cluster_key

updated_at

opportunity_id

scoring_run_id

outbox processing fields

21.3 Views
Define views for:

current approved opportunities

review queue

latest scores

score factor breakdown

lineage explorer

scoring run health

22. Observability
Layer 2 should expose:

run counts and durations

records processed per run

success/failure counts

retry counts

dead-letter event counts

score distribution by source type

approval/rejection distribution

contract validation failure counts

average confidence by source family

Expanding Layer 1 source coverage increases the chance of silent schema or quality drift if observability is weak, so this instrumentation is part of the core design rather than an afterthought.

23. Security and governance
Document:

access control model

change approval process for score models

retention policy

environment separation

PII handling if applicable

legal/compliance review of risk rules

24. Non-functional requirements
Category	Requirement
Reliability	Durable processing with idempotent consumers and retry support 
.
Scalability	Adding new Layer 1 feed sources must not require Layer 2 schema redesign if the canonical contract remains valid 
.
Performance	TBD
Explainability	100% of final scores must include factor breakdown and summary rationale.
Auditability	Every opportunity must be traceable to source lineage and scoring version.
Maintainability	All contracts, event schemas, and factor definitions must be versioned and documented.
25. Testing strategy
25.1 Unit tests
factor calculations

eligibility rules

state transitions

confidence logic

dedupe logic

25.2 Integration tests
Layer 1 canonical output to Layer 2 consumption

cluster generation

score creation

outbox event publication

replay processing

mixed-source input scenarios

25.3 Contract tests
Layer 1 and Layer 2 should have explicit contract tests to detect schema drift early, which is a central reason to formalize data contracts in the first place.

25.4 Replay tests
Confirm that identical inputs under the same score version produce stable results, and that new versions preserve historical outputs while producing new records for comparison.

26. Migration and rollout
26.1 Migration steps
Document current Layer 1 Postgres outputs.

Finalize canonical signal contract.

Add contract validation and compatibility tests.

Create Layer 2 tables and views.

Implement clustering logic.

Implement candidate creation.

Implement scoring and factor storage.

Add outbox events.

Backfill recent Layer 1 data.

Run read-only evaluation.

Enable review queue.

Enable downstream creative routing.

26.2 Rollout phases
Phase	Purpose	Success criteria
Phase 1	Read-only score generation	Scores exist and can be inspected
Phase 2	Review workflow	Reviewers can evaluate rationale and states
Phase 3	Controlled downstream routing	Approved opportunities enter Stage 5
Phase 4	Multi-source validation	New source can be added without Layer 2 redesign
27. Acceptance criteria
27.1 Core acceptance criteria
Layer 2 consumes only canonical Layer 1 records, not raw source payloads.

Each opportunity is traceable to contributing signals and source lineage.

Every final score has factor-level breakdown and summary rationale.

Reprocessing the same input scope is idempotent.

Score history is append-only across scoring model changes.

Outbox-backed events are persisted with business state changes in the same transaction.

Optional evidence absence lowers confidence rather than crashing the pipeline.

Review routing works for low-confidence or risk-sensitive opportunities.

27.2 Future-proofing acceptance criteria
A new Layer 1 feed can be added by building a Layer 1 adapter and canonical mapping, without changing Layer 2 core entities.

Mixed-source clusters can be scored without source-specific custom tables.

New evidence fields can be added additively under version control.

Existing downstream consumers remain compatible through event and contract versioning.

28. Open decisions
Document project-specific decisions here:

initial factor weights

approval threshold

review threshold

hard-block risk rules

clustering strategy

replay cadence

source reliability overrides

worker trigger mechanism

29. Appendices
Appendix A: Example JSON payloads
Include example payloads for:

canonical signal

trend cluster

opportunity candidate

opportunity score

outbox event

Appendix B: Source onboarding checklist
Identify source type and owner.

Define source adapter in Layer 1.

Map source schema into canonical contract.

Populate lineage, timestamps, and dedupe keys.

Validate contract compliance.

Update capability matrix.

Run Layer 2 compatibility tests.

Backfill or activate production ingestion.

Appendix C: Reviewer rubric
For needs_review candidates, define a rubric covering:

novelty

commercial relevance

evidence quality

legal/policy risk

creative potential

timing relevance

30. Completion section
Fill these in for the implementation:

Current Layer 1 tables/views:

Current intake source types:

Current event model:

Proposed Layer 2 worker model:

Initial scoring factors:

Current known constraints:

First downstream consumer:

Go-live criteria:

This specification is designed so Layer 2 behaves like a stable decisioning platform rather than a thin extension of a single intake source. That is the architectural move that makes it future-proof as Layer 1 expands, because contract discipline, additive schema evolution, and durable event publication let new producers join without breaking downstream consumers.