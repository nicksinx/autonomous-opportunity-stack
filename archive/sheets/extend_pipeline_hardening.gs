/**
 * Extends the "POD Trend Research System" spreadsheet with hardening tabs
 * needed by Items 2-6 of the pipeline hardening plan plus Item 1 mitigation.
 *
 * Idempotent: tab specs create when missing or rewrite header row only.
 * Seed rows are inserted only when a tab is freshly created.
 *
 * Tabs added:
 *   - normalization_log         (Item 3)
 *   - publishing_queue          (Item 5)
 *   - stage_run_logs            (Item 6)
 *   - source_health             (Items 2 + 6)
 *   - pipeline_locks            (Item 1 mitigation)
 *   - dual_write_mirror_log     (Item 1 mitigation)
 */
function extendPipelineHardening() {
  var SPREADSHEET_NAME = 'POD Trend Research System';
  var ss = openSpreadsheetByNamePh_(SPREADSHEET_NAME);

  var tabs = [
    {
      name: 'normalization_log',
      headers: [
        'log_id',
        'run_id',
        'run_date',
        'canonical_id',
        'input_term',
        'decision_type',
        'confidence',
        'merged_into',
        'reason',
        'created_at',
      ],
    },
    {
      name: 'publishing_queue',
      headers: [
        'queue_id',
        'idempotency_key',
        'run_id',
        'run_week',
        'cluster_id',
        'brief_id',
        'status',
        'attempt_count',
        'first_enqueued_at',
        'last_seen_at',
        'source_run_id',
        'priority',
        'review_notes',
      ],
    },
    {
      name: 'stage_run_logs',
      headers: [
        'log_id',
        'run_id',
        'workflow_name',
        'stage_name',
        'event_type',
        'started_at',
        'ended_at',
        'duration_ms',
        'rows_in',
        'rows_out',
        'error_count',
        'status',
        'error_summary',
        'attempt_number',
        'parent_log_id',
        'metadata_json',
      ],
    },
    {
      name: 'source_health',
      headers: [
        'health_id',
        'run_id',
        'run_date',
        'source_name',
        'status',
        'rows_in',
        'rows_valid',
        'rows_rejected',
        'duration_ms',
        'last_error',
        'http_status_codes',
        'consecutive_failures',
        'updated_at',
      ],
    },
    {
      name: 'pipeline_locks',
      headers: [
        'lock_id',
        'lock_owner',
        'workflow_name',
        'stage_name',
        'target_resource',
        'acquired_at',
        'lock_expires_at',
        'released_at',
        'status',
        'metadata_json',
      ],
    },
    {
      name: 'dual_write_mirror_log',
      headers: [
        'mirror_id',
        'run_id',
        'workflow_name',
        'target_table',
        'primary_sink',
        'secondary_sink',
        'rows_written',
        'primary_status',
        'secondary_status',
        'mirror_hash',
        'created_at',
      ],
    },
  ];

  for (var i = 0; i < tabs.length; i++) {
    var spec = tabs[i];
    var ensured = ensureOrCreateSheetPh_(ss, spec.name);
    var sheet = ensured.sheet;
    var numCols = spec.headers.length;

    sheet.getRange(1, 1, 1, numCols).setValues([spec.headers]);
    sheet.getRange(1, 1, 1, numCols).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 220);

    if (ensured.created) {
      console.log('Hardening tab created: ' + spec.name);
    } else {
      console.log('Hardening tab refreshed: ' + spec.name);
    }
  }

  applyStageRunLogsConditionalFormatting_(ss.getSheetByName('stage_run_logs'));
  applyPublishingQueueConditionalFormatting_(ss.getSheetByName('publishing_queue'));
  applySourceHealthConditionalFormatting_(ss.getSheetByName('source_health'));
}

/**
 * Opens spreadsheet by exact name (DriveApp lookup).
 */
function openSpreadsheetByNamePh_(name) {
  var files = DriveApp.getFilesByName(name);
  if (!files.hasNext()) {
    throw new Error('Spreadsheet not found: ' + name);
  }
  var file = files.next();
  return SpreadsheetApp.openById(file.getId());
}

/**
 * Ensures a sheet exists; returns { sheet, created }.
 */
function ensureOrCreateSheetPh_(ss, name) {
  var existing = ss.getSheetByName(name);
  if (existing) return { sheet: existing, created: false };
  return { sheet: ss.insertSheet(name), created: true };
}

/**
 * Highlights stage_run_logs rows by status.
 */
function applyStageRunLogsConditionalFormatting_(sheet) {
  if (!sheet) return;
  sheet.clearConditionalFormatRules();
  var range = sheet.getRange('A2:P1000');
  var rules = [];
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$L2="error"')
      .setBackground('#F4CCCC')
      .setRanges([range])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$L2="warn"')
      .setBackground('#FFEB9C')
      .setRanges([range])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$L2="success"')
      .setBackground('#C6EFCE')
      .setRanges([range])
      .build()
  );
  sheet.setConditionalFormatRules(rules);
}

/**
 * Highlights publishing_queue rows by status.
 */
function applyPublishingQueueConditionalFormatting_(sheet) {
  if (!sheet) return;
  sheet.clearConditionalFormatRules();
  var range = sheet.getRange('A2:M1000');
  var rules = [];
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$G2="published"')
      .setBackground('#C6EFCE')
      .setRanges([range])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$G2="pending"')
      .setBackground('#FFEB9C')
      .setRanges([range])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$G2="rejected"')
      .setBackground('#F4CCCC')
      .setRanges([range])
      .build()
  );
  sheet.setConditionalFormatRules(rules);
}

/**
 * Highlights source_health rows by status.
 */
function applySourceHealthConditionalFormatting_(sheet) {
  if (!sheet) return;
  sheet.clearConditionalFormatRules();
  var range = sheet.getRange('A2:M1000');
  var rules = [];
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$E2="error"')
      .setBackground('#F4CCCC')
      .setRanges([range])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$E2="degraded"')
      .setBackground('#FFEB9C')
      .setRanges([range])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$E2="ok"')
      .setBackground('#C6EFCE')
      .setRanges([range])
      .build()
  );
  sheet.setConditionalFormatRules(rules);
}
