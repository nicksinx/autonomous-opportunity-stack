/**
 * Extends clustering-related schema tabs in "POD Trend Research System".
 * Idempotent behavior:
 * - If tab exists, rewrites only the header row.
 * - If tab does not exist, creates it and writes headers.
 */
function extendClusteringSchema() {
  var SPREADSHEET_NAME = 'POD Trend Research System';
  var ss = openSpreadsheetByName_(SPREADSHEET_NAME);

  var tabs = [
    {
      name: 'theme_clusters',
      headers: [
        'cluster_id',
        'run_date',
        'theme_name',
        'theme_slug',
        'parent_theme',
        'theme_summary',
        'audience',
        'occasion_type',
        'seasonality',
        'product_fit',
        'style_fit',
        'risk_level',
        'cluster_score',
        'term_count',
        'status',
        'review_notes',
      ],
    },
    {
      name: 'cluster_members',
      headers: [
        'member_id',
        'cluster_id',
        'canonical_id',
        'canonical_term',
        'member_role',
        'fit_score',
        'evidence_summary',
        'reason_included',
        'reason_excluded',
        'captured_at',
      ],
    },
    {
      name: 'cluster_history',
      headers: [
        'history_id',
        'cluster_id',
        'run_date',
        'change_type',
        'old_value',
        'new_value',
        'notes',
      ],
    },
    {
      name: 'cluster_review_queue',
      headers: [
        'review_id',
        'cluster_id',
        'run_date',
        'reason',
        'priority',
        'assigned_to',
        'status',
        'resolved_at',
        'resolution_notes',
      ],
    },
    {
      name: 'cluster_metrics',
      headers: [
        'metric_id',
        'week_start',
        'total_clusters_generated',
        'approved_count',
        'avg_cluster_score',
        'avg_terms_per_cluster',
        'pct_sent_to_review',
        'pct_briefs_approved',
        'pct_rejected_weak_intent',
        'pct_rejected_risk',
        'notes',
      ],
    },
  ];

  for (var i = 0; i < tabs.length; i++) {
    var spec = tabs[i];
    var ensured = ensureOrCreateSheet_(ss, spec.name);
    var sheet = ensured.sheet;
    var headerCount = spec.headers.length;

    // Rewrite only the header row for idempotent updates.
    sheet.getRange(1, 1, 1, headerCount).setValues([spec.headers]);
    sheet.getRange(1, 1, 1, headerCount).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 220); // A
    sheet.setColumnWidth(2, 120); // B

    if (ensured.created) {
      console.log('Tab created: ' + spec.name + ' | headers=' + headerCount);
    }
  }

  applyClusterReviewQueueConditionalFormatting_(ss.getSheetByName('cluster_review_queue'));
  applyThemeClustersStatusConditionalFormatting_(ss.getSheetByName('theme_clusters'));
}

/**
 * Opens spreadsheet by exact display name.
 */
function openSpreadsheetByName_(name) {
  var files = DriveApp.getFilesByName(name);
  if (!files.hasNext()) {
    throw new Error('Spreadsheet not found: ' + name);
  }
  return SpreadsheetApp.openById(files.next().getId());
}

/**
 * Ensures a sheet exists.
 * @return {{ sheet: GoogleAppsScript.Spreadsheet.Sheet, created: boolean }}
 */
function ensureOrCreateSheet_(ss, name) {
  var existing = ss.getSheetByName(name);
  if (existing) {
    return { sheet: existing, created: false };
  }
  return { sheet: ss.insertSheet(name), created: true };
}

/**
 * Apply row-level priority formatting for cluster_review_queue (A:I).
 */
function applyClusterReviewQueueConditionalFormatting_(sheet) {
  if (!sheet) return;
  var target = sheet.getRange('A2:I1000');
  var rules = [];

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=LOWER($E2)="high"')
      .setBackground('#F4CCCC')
      .setRanges([target])
      .build()
  );

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=LOWER($E2)="medium"')
      .setBackground('#FFF2CC')
      .setRanges([target])
      .build()
  );

  // Low intentionally has no fill (no rule).
  sheet.setConditionalFormatRules(rules);
}

/**
 * Apply status formatting for theme_clusters status column (O).
 */
function applyThemeClustersStatusConditionalFormatting_(sheet) {
  if (!sheet) return;
  var target = sheet.getRange('O2:O1000');
  var rules = [];

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('approved')
      .setBackground('#C6EFCE')
      .setRanges([target])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('draft')
      .setBackground('#D9EAD3')
      .setRanges([target])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('watchlist')
      .setBackground('#FFF2CC')
      .setRanges([target])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('rejected')
      .setBackground('#F4CCCC')
      .setRanges([target])
      .build()
  );

  sheet.setConditionalFormatRules(rules);
}
