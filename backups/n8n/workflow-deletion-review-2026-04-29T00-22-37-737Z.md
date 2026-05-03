# n8n Workflow Deletion Review

Generated: 2026-04-29T00:22:41.241Z
Source: https://unmoral-impure-negotiate.ngrok-free.dev
Workflow list count: 19
Full workflow count: 19
HTTP failures: 0
Execution recency signal: executions_api where available

## Executive summary

- KEEP: 15
- REVIEW: 4
- CANDIDATE_DELETE: 0
- Stale threshold: 90 days

## Full review table

| id | name | active | primary_node_types | credential_names | bucket | last_any | last_success | references | recommendation | confidence | rationale |
|---|---|---:|---|---|---|---|---|---|---|---|---|
| RdbVFq2pTN9WEFpq | Contract Ingestion Pipeline | true | gs:0, pg:0, http:4, code:6, triggers:1 |  | unknown | 2026-04-24T01:07:09.278Z (success) | 2026-04-24T01:07:09.278Z |  | KEEP | high | Active workflow; deletion is out of scope without deactivation and an operational window.; Contains a webhook node with a configured path; inbound/public-facing risk needs review.; Recent execution signal within 90 days. |
| hd0bYSEmZsUYvjsn | My workflow | false | gs:0, pg:0, http:0, code:0, triggers:1 |  | unknown | none (executions_api) | none (executions_api) |  | REVIEW | medium | Inactive but lacks enough naming or dependency evidence to recommend deletion. |
| AsORoSwQOE4ABSmb | wf_collect_trends | true | gs:0, pg:5, http:0, code:11, triggers:1 | Postgres - POD Research | pipeline_wf_* | 2026-04-28T05:41:26.128Z (success) | 2026-04-28T05:41:26.128Z |  | KEEP | high | Active workflow; deletion is out of scope without deactivation and an operational window.; Matches the canonical `wf_*` project pipeline naming family.; Recent execution signal within 90 days. |
| yY38I7zLX0KqVBA9 | wf_collect_trends — Error Handler | false | gs:0, pg:1, http:0, code:1, triggers:1 | Postgres - POD Research | error_handler | none (executions_api) | none (executions_api) | wf_collect_trends (error handler) | KEEP | high | Referenced as an error workflow by another workflow. |
| 0jY0awmaJn8RMY8q | wf_enrich_marketplace | true | gs:0, pg:5, http:0, code:3, triggers:1 | Postgres - POD Research | pipeline_wf_* | 2026-04-28T05:35:20.169Z (error) | 2026-04-28T05:04:29.831Z |  | KEEP | high | Active workflow; deletion is out of scope without deactivation and an operational window.; Matches the canonical `wf_*` project pipeline naming family.; Recent execution signal within 90 days. |
| TS0ub3Nc0oHRqhUV | wf_enrich_marketplace — Error Handler | false | gs:0, pg:1, http:0, code:1, triggers:1 | Postgres - POD Research | error_handler | none (executions_api) | none (executions_api) | wf_enrich_marketplace (error handler) | KEEP | high | Referenced as an error workflow by another workflow. |
| HfUHI8bSMxO6KzFU | wf_generate_range_briefs | true | gs:0, pg:4, http:1, code:5, triggers:1 | Postgres - POD Research | pipeline_wf_* | 2026-04-28T05:45:44.887Z (success) | 2026-04-28T05:45:44.887Z |  | KEEP | high | Active workflow; deletion is out of scope without deactivation and an operational window.; Matches the canonical `wf_*` project pipeline naming family.; Recent execution signal within 90 days. |
| 8qEKHsdsmszGSn4W | wf_generate_range_briefs — Error Handler | false | gs:0, pg:1, http:0, code:1, triggers:1 | Postgres - POD Research | error_handler | none (executions_api) | none (executions_api) |  | REVIEW | medium | Looks like an error handler but was not detected as a current errorWorkflow target. |
| f9000009-f009-4009-8009-000000000002 | wf_ingest_performance_feedback | true | gs:0, pg:4, http:0, code:5, triggers:1 | Postgres - POD Research | pipeline_wf_* | 2026-04-28T04:30:43.936Z (success) | 2026-04-28T04:30:43.936Z |  | KEEP | high | Active workflow; deletion is out of scope without deactivation and an operational window.; Matches the canonical `wf_*` project pipeline naming family.; Contains a webhook node with a configured path; inbound/public-facing risk needs review.; Recent execution signal within 90 days. |
| b2000002-0002-4002-8002-000000000002 | wf_normalize_terms | true | gs:0, pg:8, http:0, code:10, triggers:1 | Postgres - POD Research | pipeline_wf_* | 2026-04-28T11:58:01.418Z (error) | none (executions_api) |  | KEEP | high | Active workflow; deletion is out of scope without deactivation and an operational window.; Matches the canonical `wf_*` project pipeline naming family.; Recent execution signal within 90 days. |
| TMtQCsIrYBjBPuuu | wf_normalize_terms — Error Handler | false | gs:1, pg:0, http:0, code:1, triggers:1 | Google Sheets account | duplicate_name | none (executions_api) | none (executions_api) |  | REVIEW | medium | Duplicate workflow name group; requires human disambiguation. |
| b2000002-0002-4002-8002-000000000001 | wf_normalize_terms — Error Handler | false | gs:0, pg:1, http:0, code:1, triggers:1 | Postgres - POD Research | duplicate_name | none (executions_api) | none (executions_api) | wf_normalize_terms (error handler) | KEEP | high | Referenced as an error workflow by another workflow. |
| COtkbdAHy4HWEhh7 | wf_phrase_expansion | true | gs:0, pg:2, http:0, code:4, triggers:1 | Postgres - POD Research | pipeline_wf_* | none (executions_api) | none (executions_api) |  | KEEP | high | Active workflow; deletion is out of scope without deactivation and an operational window.; Matches the canonical `wf_*` project pipeline naming family.; Contains a webhook node with a configured path; inbound/public-facing risk needs review. |
| WcJaRbT1v4GE1Dv9 | wf_publish_queue | true | gs:0, pg:4, http:0, code:1, triggers:1 | Postgres - POD Research | pipeline_wf_* | 2026-04-28T10:32:20.356Z (success) | 2026-04-28T10:32:20.356Z |  | KEEP | high | Active workflow; deletion is out of scope without deactivation and an operational window.; Matches the canonical `wf_*` project pipeline naming family.; Recent execution signal within 90 days. |
| iDVs9G6KzfsYnchS | wf_publish_queue — Error Handler | false | gs:0, pg:1, http:0, code:1, triggers:1 | Postgres - POD Research | error_handler | none (executions_api) | none (executions_api) | wf_publish_queue (error handler) | KEEP | high | Referenced as an error workflow by another workflow. |
| d4000004-0004-4004-8004-000000000002 | wf_score_and_cluster | true | gs:0, pg:13, http:0, code:5, triggers:1 | Postgres - POD Research | pipeline_wf_* | 2026-04-28T06:31:16.900Z (success) | 2026-04-28T06:31:16.900Z |  | KEEP | high | Active workflow; deletion is out of scope without deactivation and an operational window.; Matches the canonical `wf_*` project pipeline naming family.; Recent execution signal within 90 days. |
| QH79tUGvWoFe25Mq | wf_score_and_cluster — Error Handler | false | gs:1, pg:0, http:0, code:1, triggers:1 | Google Sheets account | duplicate_name | none (executions_api) | none (executions_api) |  | REVIEW | medium | Duplicate workflow name group; requires human disambiguation. |
| d4000004-0004-4004-8004-000000000001 | wf_score_and_cluster — Error Handler | false | gs:0, pg:1, http:0, code:1, triggers:1 | Postgres - POD Research | duplicate_name | none (executions_api) | none (executions_api) | wf_score_and_cluster (legacy-sheets) (error handler); wf_score_and_cluster (error handler) | KEEP | high | Referenced as an error workflow by another workflow. |
| FzwunYIiBc76MFJp | wf_score_and_cluster (legacy-sheets) | false | gs:12, pg:0, http:0, code:11, triggers:1 | Google Sheets account | legacy_renamed | 2026-04-28T05:25:57.322Z (error) | 2026-04-28T02:00:59.791Z |  | KEEP | high | Recent execution signal within 90 days. |

## Heuristics

- `pipeline_wf_*`: name starts with `wf_` and matches this project's collect, normalize, enrich, score, publish, ingest, feedback, briefs, or phrase-expansion family.
- `error_handler`: name contains `Error Handler`.
- `legacy_renamed`: name contains legacy, old, backup, copy, deprecated, or `(legacy`.
- `duplicate_name`: two or more workflows share the same exact name; all workflows in that group are flagged.
- `experimental`: name suggests experiment, test, scratch, sandbox, POC, or demo.
- `unknown`: none of the above matched.

## Dependency graph summary

- wf_collect_trends — Error Handler (yY38I7zLX0KqVBA9) is referenced by wf_collect_trends (error handler).
- wf_enrich_marketplace — Error Handler (TS0ub3Nc0oHRqhUV) is referenced by wf_enrich_marketplace (error handler).
- wf_normalize_terms — Error Handler (b2000002-0002-4002-8002-000000000001) is referenced by wf_normalize_terms (error handler).
- wf_publish_queue — Error Handler (iDVs9G6KzfsYnchS) is referenced by wf_publish_queue (error handler).
- wf_score_and_cluster — Error Handler (d4000004-0004-4004-8004-000000000001) is referenced by wf_score_and_cluster (legacy-sheets) (error handler); wf_score_and_cluster (error handler).

## Never auto-delete

- Contract Ingestion Pipeline (RdbVFq2pTN9WEFpq) - active
- wf_collect_trends (AsORoSwQOE4ABSmb) - active, canonical pipeline name
- wf_enrich_marketplace (0jY0awmaJn8RMY8q) - active, canonical pipeline name
- wf_generate_range_briefs (HfUHI8bSMxO6KzFU) - active, canonical pipeline name
- wf_ingest_performance_feedback (f9000009-f009-4009-8009-000000000002) - active, canonical pipeline name
- wf_normalize_terms (b2000002-0002-4002-8002-000000000002) - active, canonical pipeline name
- wf_phrase_expansion (COtkbdAHy4HWEhh7) - active, canonical pipeline name
- wf_publish_queue (WcJaRbT1v4GE1Dv9) - active, canonical pipeline name
- wf_score_and_cluster (d4000004-0004-4004-8004-000000000002) - active, canonical pipeline name

## Ordered deletion plan for later approval

1. Keep this snapshot and review file as rollback/reference artifacts.
2. For each approved candidate, deactivate first if it is active; active deletion is intentionally out of scope for this audit.
3. Verify no schedules, webhook paths, errorWorkflow settings, Execute Workflow nodes, or HTTP/Code references point to the workflow.
4. Delete only the explicitly approved workflow IDs.
5. Re-run this audit and compare counts after deletion.

## Checkpoints

- Row count matches list endpoint: yes
- Zero HTTP failures: yes
- Note: API URL appears to use ngrok; slow or hung API calls are possible, so this script used timeouts and one retry.
