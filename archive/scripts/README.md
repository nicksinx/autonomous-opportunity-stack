# Archived one-shot workflow patch scripts

These were single-use utilities that mutated `n8n/wf_*.json` directly during the Phase 1 cutover. Their effects are baked into the committed workflow JSON and the canonical builders under [`n8n/`](../../n8n/), so the scripts themselves are no longer part of routine ops.

| Script                            | What it did | Sprint use |
| --------------------------------- | ----------- | ---------- |
| `patch-wf-collect-phase1.mjs`     | Removed `dual_write_mirror_log` append nodes from `wf_collect_trends.json` and detached their inbound connections. | Phase 1 mirror sunset |
| `patch-wf-normalize-phase1.mjs`   | Same surgery on `wf_normalize_terms.json`. | Phase 1 mirror sunset |

Kept for historical reference and porting diffs only — do not re-run against the current workflow JSON.
