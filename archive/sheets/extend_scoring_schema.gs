/**
 * Extends the existing "POD Trend Research System" spreadsheet with scoring tabs.
 * Idempotent behavior:
 * - New tab specs: create if missing, otherwise rewrite only header row.
 * - normalized_terms: append missing scoring columns to the end only once.
 * - score_weights seed rows: inserted only when tab is first created.
 */
function extendScoringSchema() {
  var SPREADSHEET_NAME = 'POD Trend Research System';
  var ss = openSpreadsheetByName_(SPREADSHEET_NAME);

  var tabs = [
    {
      name: 'opportunity_scores',
      headers: [
        'opp_id',
        'canonical_id',
        'run_date',
        'niche_keyword',
        'target_audience',
        'theme',
        'seasonality_flag',
        'product_formats',
        'compliance_risk',
        'demand_score',
        'competition_score',
        'conversion_score',
        'creative_score',
        'margin_score',
        'ops_score',
        'catalog_score',
        'repeat_score',
        'season_score',
        'raw_weighted_sum',
        'risk_penalty',
        'opportunity_score',
        'tier',
        'action',
        'scorer_version',
        'score_notes',
      ],
    },
    {
      name: 'score_components',
      headers: [
        'component_id',
        'opp_id',
        'run_date',
        'dimension',
        'component_name',
        'raw_value',
        'normalized_value',
        'weight',
        'weighted_contribution',
        'notes',
      ],
    },
    {
      name: 'score_weights',
      headers: ['dimension', 'weight', 'enabled', 'last_updated', 'notes'],
      seedRows: [
        ['demand_strength', 0.2, true, new Date(), 'Rising demand evidence'],
        ['competition_gap', 0.15, true, new Date(), 'Whitespace vs saturation'],
        [
          'conversion_potential',
          0.2,
          true,
          new Date(),
          'Click and purchase likelihood',
        ],
        ['creative_diff', 0.1, true, new Date(), 'Differentiation from existing'],
        ['margin_potential', 0.1, true, new Date(), 'Unit economics viability'],
        ['ops_feasibility', 0.1, true, new Date(), 'Print production reliability'],
        ['catalog_fit', 0.05, true, new Date(), 'Store identity alignment'],
        ['repeatability', 0.05, true, new Date(), 'Collection/series potential'],
        ['seasonality_timing', 0.05, true, new Date(), 'Demand timing favorability'],
      ],
    },
    {
      name: 'performance_feedback',
      headers: [
        'feedback_id',
        'opp_id',
        'brief_id',
        'product_sku',
        'feedback_date',
        'units_sold_30d',
        'revenue_30d',
        'gross_margin_pct',
        'return_rate_pct',
        'ctr_pct',
        'conversion_rate_pct',
        'feedback_notes',
      ],
    },
    {
      name: 'scoring_audit_log',
      headers: [
        'audit_id',
        'run_date',
        'run_id',
        'candidates_evaluated',
        'tier_A_count',
        'tier_B_count',
        'tier_C_count',
        'rejected_count',
        'avg_opportunity_score',
        'top_opportunity',
        'scorer_version',
        'notes',
      ],
    },
  ];

  for (var i = 0; i < tabs.length; i++) {
    var spec = tabs[i];
    var ensured = ensureOrCreateSheet_(ss, spec.name);
    var sheet = ensured.sheet;
    var numCols = spec.headers.length;

    // If existing tab, rewrite only header row. If new tab, initialize full header format.
    sheet.getRange(1, 1, 1, numCols).setValues([spec.headers]);
    sheet.getRange(1, 1, 1, numCols).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 220);

    if (ensured.created) {
      console.log('Tab created: ' + spec.name);
    }

    if (spec.name === 'score_weights' && ensured.created && spec.seedRows && spec.seedRows.length) {
      sheet
        .getRange(2, 1, spec.seedRows.length, numCols)
        .setValues(spec.seedRows);

      // Sort inserted rows by weight (column B) descending.
      sheet
        .getRange(2, 1, spec.seedRows.length, numCols)
        .sort({ column: 2, ascending: false });
    }
  }

  extendNormalizedTermsColumns_(ss);
}

/**
 * Opens spreadsheet by exact name.
 */
function openSpreadsheetByName_(name) {
  var files = DriveApp.getFilesByName(name);
  if (!files.hasNext()) {
    throw new Error('Spreadsheet not found: ' + name);
  }
  var file = files.next();
  return SpreadsheetApp.openById(file.getId());
}

/**
 * Ensures a sheet exists.
 * @return {{ sheet: GoogleAppsScript.Spreadsheet.Sheet, created: boolean }}
 */
function ensureOrCreateSheet_(ss, name) {
  var existing = ss.getSheetByName(name);
  if (existing) return { sheet: existing, created: false };
  return { sheet: ss.insertSheet(name), created: true };
}

/**
 * Adds scoring columns to normalized_terms, preserving existing data and order.
 */
function extendNormalizedTermsColumns_(ss) {
  var sheet = ss.getSheetByName('normalized_terms');
  if (!sheet) {
    throw new Error('Required tab not found: normalized_terms');
  }

  var lastCol = Math.max(1, sheet.getLastColumn());
  var headerValues = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var existingHeaders = headerValues.map(function (h) {
    return String(h || '').trim();
  });

  var appendHeaders = [
    'last_scored_at',
    'latest_opp_id',
    'latest_opportunity_score',
    'latest_tier',
  ];

  var missing = [];
  for (var i = 0; i < appendHeaders.length; i++) {
    if (existingHeaders.indexOf(appendHeaders[i]) === -1) {
      missing.push(appendHeaders[i]);
    }
  }

  if (!missing.length) return;

  var startCol = existingHeaders.length + 1;
  sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
  sheet.getRange(1, 1, 1, existingHeaders.length + missing.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 220);
}
