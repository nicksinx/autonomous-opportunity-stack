# n8n/diagnostics/

One-shot diagnostic and live-instance helper scripts used during the
Postgres + n8n cutover sprint and retained for forensic reuse. These are
**not** part of routine ops — for daily commands use the scripts at the
top of `n8n/` (see the [root README](../../README.md) "Daily commands"
table).

All scripts in this folder load `.env` (and `.env.local` / `.env.postgres`
where relevant) from the repo root and resolve `repoRoot` two levels up.

| Script                                | What it does | Sprint use |
| ------------------------------------- | ------------ | ---------- |
| `diff-live-vs-repo.mjs`               | Compare every `n8n/wf_*.json` against a workflow snapshot, ignoring n8n's post-import enrichments (credential id, default callerPolicy). Exit 1 on real drift. | Phase A parity check |
| `inspect-execution.mjs`               | Pull a single n8n execution and dump its node-by-node clues to `backups/n8n/`. | Step 10/11 debugging |
| `list-mcp-tools.mjs`                  | List the tools exposed by the live n8n MCP server (uses `N8N_MCP_URL` + `N8N_MCP_TOKEN`). | MCP capability discovery |
| `mcp-call.mjs`                        | Generic MCP tool caller — invokes any tool name with JSON args. | Step 10 trigger via MCP |
| `patch-live-wf-collect-trends-order.mjs` | Patch the live `wf_collect_trends` to enforce the FK-safe write order discovered in Step 11 debug. | Step 11 fix |
| `step10-functional-pipeline-trigger.mjs` | Trigger the 5 main workflows in sequence via MCP and collect a chained execution chain artifact under `backups/n8n/step10-execution-chain-*.json`. | Step 10 |
| `step11-postgres-verification.mjs`    | Audit the executions launched by Step 10 and inspect Postgres tables for expected rows; emit `backups/n8n/step11-execution-audit-*.json` and `step11-diagnostics-*.json`. | Step 11 |
| `stop-execution.mjs`                  | Force-stop a running n8n execution (used to break the historical wf_score_and_cluster cycle hang). | Step 10 debug |
| `update-step10-main-workflows.mjs`    | One-off live update of the 5 main workflows from local JSON via the n8n REST API; respects the import script's settings allowlist. | Step 10 fix |

## Re-running

These scripts are safe to re-run at any time, but most produce timestamped
artifacts under `backups/n8n/`. Add the `--out <path>` flag where
supported to redirect, or expect a new file each run.

## Why these are separate

The scripts at the top of `n8n/` (`import-workflows.mjs`,
`validate-workflows.mjs`, `phase1-gate.mjs`,
`simulate-scheduled-runs.mjs`, `audit-workflow-deletion.mjs`,
`baseline-report.mjs`, `snapshot-workflows.mjs`) are routine,
idempotent ops tooling. Anything in
this folder is sprint-specific or interactive debugging glue; segregating
them keeps the package surface area focused and makes it easy to add new
investigation scripts here without polluting the routine path.
