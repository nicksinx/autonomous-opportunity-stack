# Codex Prompt Pack

Reusable prompts for this repository. Keep them small and chain them as needed.

## 1. Repo Scan Prompt

```text
Scan the repository before making changes.
Read the current docs, workflow files, and relevant code.
Identify the active branch, dirty files, generated artifacts, and the main system boundaries.
Summarize the current state in a few bullets and stop before editing anything.
```

## 2. Change Planning Prompt

```text
Turn the requested work into a short implementation plan.
List the blocking step first, then the dependent steps.
Call out the minimum files and systems likely to change.
Highlight any risky or cross-cutting work before editing.
```

## 3. Implementation Prompt

```text
Implement the smallest change that satisfies the request.
Prefer existing project conventions and preserve unrelated work.
Use apply_patch for file edits.
Keep changes incremental and easy to review.
```

## 4. Verification Prompt

```text
Verify the change with the most direct test or runtime check available.
Confirm the expected behavior, then summarize the result.
If verification fails, report the exact failing step and likely cause.
```

## 5. Repo Hygiene Prompt

```text
Check git status, branch, and remote state before pushing.
Commit only the files needed for the task.
Do not include local editor artifacts or unrelated work.
Push only after the change is verified.
```

## 6. n8n Workflow Prompt

```text
Inspect the current n8n workflows, Postgres schema (db/migrations), and workflow-run logs.
Validate workflow JSON before activation.
Prefer the live instance and repo JSON to stay in sync.
Treat env vars, credential names, and table contracts as part of the workflow contract.
```

## 7. Docs and Plan Prompt

```text
When the repo has a visible operating plan, align implementation with that plan.
Update or create a short markdown plan that explains the pipeline stages, inputs, outputs, and risks.
Keep the plan specific enough to guide future work but short enough to maintain.
```

## Carried Out Now

- Scanned the repo root state.
- Confirmed the current branch is `commit-changes`.
- Noted the worktree is dirty and contains uncommitted repo changes.
- Identified the key repo artifacts currently in place:
  - `README.md`
  - `sprint-plan.md` (Layer 1 stages; Postgres system of record)
  - `SPRINT_CLOSEOUT.md` (Sheets → Postgres cutover evidence)
  - `db/migrations/*.sql`, `db/README.md`
  - `n8n/*.mjs`, `n8n/wf_*.json`
  - `services/` (API, CSV import, outbox publisher, cluster engine, weight calibrator)
- Captured that the repo includes committed workflow JSON plus JS builders for several workflows, so prompt-guided work should preserve generated artifacts and avoid accidental rebuilds unless requested.

## Notes

- Use these prompts as building blocks, not as a single monolithic instruction.
- For n8n work, combine the repo scan prompt with the n8n workflow prompt.
- For release or push tasks, combine the repo scan prompt, change planning prompt, and repo hygiene prompt.
