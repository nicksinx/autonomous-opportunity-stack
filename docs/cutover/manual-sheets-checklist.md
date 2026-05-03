# Manual Cutover Checklist (Steps 13 & 14)

These two gates close out the Postgres + n8n cutover sprint and require
hands-on actions in the Google Sheets and Google Drive UIs (or via a
freshly authenticated CLI). Once both are complete, paste the recorded
evidence into the matching rows in
[`SPRINT_CLOSEOUT.md`](../../SPRINT_CLOSEOUT.md).

The legacy spreadsheet ID is set in `.env` as `SHEETS_ID` and resolves to:

> `1hw0ZBypwMfc8ivpQ-CQlhDfVJK9w5PqnageeIAzUdvE`

## §1 - Step 13: confirm Sheets is no longer being written to

Goal: prove that an end-to-end pipeline run does not modify the Google
Sheet (so the Postgres cutover is the only sink). Expected outcome: the
Sheet's "Last edit was ..." timestamp is unchanged across a full run.

### 1.1 Record the Sheet's current "Last edit" timestamp (UTC)

1. Open the Sheet:
   `https://docs.google.com/spreadsheets/d/1hw0ZBypwMfc8ivpQ-CQlhDfVJK9w5PqnageeIAzUdvE/edit`
2. Click the **clock icon** to the right of `Help` in the menu bar (tooltip:
   "See new changes" / "Last edit was ..."). The popover shows the most
   recent edit time. Click `See version history` for an exact timestamp
   list (`File > Version history > See version history`).
3. Note the **most recent version's date and time**. Record as
   `before_run_iso`.

### 1.2 Trigger a full pipeline run

Either:

- Wait for the scheduled `wf_collect_trends` cron (`Schedule Trigger
  (06:00 Europe/London)`), or
- Trigger immediately via MCP:

  ```sh
  npm run n8n:simulate
  ```

  Wait for all five executions (`wf_collect_trends -> wf_normalize_terms ->
  wf_enrich_marketplace -> wf_score_and_cluster -> wf_publish_queue`) to
  reach `success` (verify in n8n Executions UI or via
  `node n8n/diagnostics/inspect-execution.mjs`). Record the run window:
  - `pipeline_run_started_iso`
  - `pipeline_run_finished_iso`

### 1.3 Re-record the Sheet's "Last edit" timestamp

Repeat 1.1 (refresh the page first to defeat any cached version-history
panel). Record as `after_run_iso`.

### 1.4 Pass / fail

- **PASS** if `after_run_iso == before_run_iso` (no new version was
  created during the pipeline window).
- **FAIL** if `after_run_iso > before_run_iso` AND the new version
  timestamp falls inside `[pipeline_run_started_iso, pipeline_run_finished_iso]`.
  In that case, identify which workflow wrote (check n8n execution data,
  search for any remaining `n8n-nodes-base.googleSheets` nodes via
  `npm run n8n:validate` - it will fail loudly).

### 1.5 Optional CLI verification (if OAuth token is fresh)

If you have a current `GOOGLE_SHEETS_TOKEN` (refresh with
`gcloud auth print-access-token`), the Drive API exposes
`modifiedTime` directly:

```sh
curl -sH "Authorization: Bearer $GOOGLE_SHEETS_TOKEN" \
  "https://www.googleapis.com/drive/v3/files/$SHEETS_ID?fields=name,modifiedTime,modifiedByMeTime"
```

A `401 Invalid Authentication Credentials` means the token has expired;
refresh it (`gcloud auth print-access-token` after
`gcloud auth login --update-adc`) and re-run.

### 1.6 Record evidence in `SPRINT_CLOSEOUT.md`

Open [`SPRINT_CLOSEOUT.md`](../../SPRINT_CLOSEOUT.md), find the row
labelled `Step 13 evidence: ...` under "Open items (manual)", and replace
the placeholder with:

```text
before_run_iso = <YYYY-MM-DDTHH:MM:SSZ>
pipeline_run_window = <start_iso> .. <stop_iso>
after_run_iso = <YYYY-MM-DDTHH:MM:SSZ>
result = PASS (no edit during pipeline window)
```

## §2 - Step 14: lock down Sheets access

Goal: remove the n8n service account's ability to write to the Sheet (or
to read it altogether) so a future regression cannot silently restart
dual-writes. Expected outcome: the n8n service account no longer holds
the Editor role on the Sheet.

### 2.1 Open the Sheet's share dialog

1. Open the Sheet (same URL as 1.1).
2. Click the green **`Share`** button in the top-right.
3. Locate the entry for the n8n service account. Likely identifiers,
   in priority order:
   - The Google Cloud service-account email used by the n8n Sheets
     credential (look for `*@*.iam.gserviceaccount.com`).
   - The connected user account if Sheets was wired via user OAuth.

### 2.2 Choose lockdown level

Pick one of:

- **Recommended: Remove access entirely.** Click the role dropdown for
  the n8n entry and choose **Remove access**, then `Save`.
- **Conservative: downgrade to Viewer.** Click the role dropdown,
  choose **Viewer**, then `Save`. (Keeps the cred reusable for
  read-only checks but blocks writes.)

### 2.3 Confirm the change in the UI

1. Re-open `Share` and verify the n8n service account either:
   - Does not appear at all (Remove access), or
   - Appears with role `Viewer`.
2. Take a screenshot of the share-dialog list and save it as
   `backups/n8n/step14-share-dialog-<YYYY-MM-DD>.png` (or PDF).

### 2.4 Optional CLI verification (if OAuth token is fresh)

```sh
curl -sH "Authorization: Bearer $GOOGLE_SHEETS_TOKEN" \
  "https://www.googleapis.com/drive/v3/files/$SHEETS_ID/permissions?fields=permissions(emailAddress,role,type)"
```

Confirm:

- The n8n service-account row is gone, or
- Its `role` is `reader` (Viewer), not `writer` / `commenter` / `owner`.

Save the JSON output to `backups/n8n/step14-permissions-<YYYY-MM-DD>.json`.

### 2.5 Record evidence in `SPRINT_CLOSEOUT.md`

Open [`SPRINT_CLOSEOUT.md`](../../SPRINT_CLOSEOUT.md), find the row
labelled `Step 14 evidence: ...` and replace the placeholder with one of:

```text
result = PASS (n8n service account removed from Sheet)
share_dialog_screenshot = backups/n8n/step14-share-dialog-<YYYY-MM-DD>.png
permissions_json = backups/n8n/step14-permissions-<YYYY-MM-DD>.json
```

or

```text
result = PASS (n8n service account downgraded to Viewer)
share_dialog_screenshot = backups/n8n/step14-share-dialog-<YYYY-MM-DD>.png
permissions_json = backups/n8n/step14-permissions-<YYYY-MM-DD>.json
```

## Definition of done

- [ ] Step 13 §1.1 completed: `before_run_iso` recorded.
- [ ] Step 13 §1.2 completed: full pipeline run finished with all 5
      executions `success`.
- [ ] Step 13 §1.3 completed: `after_run_iso` recorded.
- [ ] Step 13 §1.4 result = PASS.
- [ ] Step 13 evidence pasted into `SPRINT_CLOSEOUT.md`.
- [ ] Step 14 §2.1-2.3 completed: n8n service account removed or
      downgraded; screenshot captured.
- [ ] Step 14 evidence pasted into `SPRINT_CLOSEOUT.md`.
- [ ] `SPRINT_CLOSEOUT.md` row 13 + 14 status updated from `PENDING (user)`
      to `PASS`.
