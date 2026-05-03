/**
 * Creates or updates the "POD Trend Research System" spreadsheet with the
 * required tabs, headers, formatting, and default sources_config rows.
 * Idempotent: opens a fixed spreadsheet by ID; each tab is cleared and the
 * header row rewritten if it already exists.
 */
function setupPODResearchSheet() {
  var SPREADSHEET_ID = '1hw0ZBypwMfc8ivpQ-CQlhDfVJK9w5PqnageeIAzUdvE';
  var SPREADSHEET_NAME = 'POD Trend Research System';

  var ss = openSpreadsheetById_(SPREADSHEET_ID, SPREADSHEET_NAME);

  var tabs = [
    {
      name: 'sources_config',
      headers: [
        'source_name',
        'enabled',
        'market',
        'weight',
        'pull_frequency',
        'notes',
      ],
      seedRows: [
        [
          'google_trends',
          true,
          'UK',
          1.0,
          'daily',
          'Rising queries + related terms',
        ],
        [
          'pinterest_trends',
          true,
          'UK',
          0.9,
          'daily',
          'Trending searches',
        ],
        [
          'tiktok_creative',
          true,
          'UK',
          0.85,
          'daily',
          'Trending hashtags and sounds',
        ],
        [
          'etsy_autocomplete',
          true,
          'UK',
          1.0,
          'daily',
          'Buyer-intent phrases',
        ],
        [
          'amazon_movers',
          true,
          'UK',
          0.9,
          'daily',
          'Category movers and shakers',
        ],
        [
          'google_kw_planner',
          true,
          'UK',
          0.8,
          'weekly',
          'Commercial modifier queries',
        ],
      ],
    },
    {
      name: 'raw_signals',
      headers: [
        'signal_id',
        'date_collected',
        'source',
        'market',
        'term',
        'related_term',
        'category',
        'signal_type',
        'velocity_hint',
        'url',
        'raw_payload_json',
      ],
    },
    {
      name: 'normalized_terms',
      headers: [
        'canonical_id',
        'date_first_seen',
        'date_last_seen',
        'canonical_term',
        'aliases',
        'language',
        'market',
        'primary_category',
        'status',
      ],
    },
    {
      name: 'marketplace_evidence',
      headers: [
        'evidence_id',
        'canonical_id',
        'source',
        'phrase',
        'product_type',
        'intent_type',
        'evidence_strength',
        'captured_at',
      ],
    },
    {
      name: 'trend_scores',
      headers: [
        'score_id',
        'canonical_id',
        'run_date',
        'momentum_score',
        'pod_fit_score',
        'buyer_intent_score',
        'range_depth_score',
        'novelty_score',
        'risk_score',
        'total_score',
        'decision',
      ],
    },
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
      name: 'range_briefs',
      headers: [
        'brief_id',
        'cluster_id',
        'run_date',
        'range_title',
        'hero_angle',
        'best_products',
        'design_directions',
        'phrase_concepts',
        'audiences',
        'ip_risk',
        'status',
      ],
    },
    {
      name: 'phrase_bank',
      headers: [
        'phrase_id',
        'brief_id',
        'bucket',
        'phrase',
        'target_products',
        'style_hint',
        'created_at',
      ],
    },
    {
      name: 'watchlist',
      headers: [
        'watch_id',
        'canonical_id',
        'reason',
        'review_after',
        'notes',
      ],
    },
    {
      name: 'workflow_runs',
      headers: [
        'run_id',
        'run_started',
        'run_finished',
        'job_name',
        'rows_added',
        'rows_updated',
        'status',
        'error_log',
        'sources_summary_json',
        'stage_log_root_id',
      ],
    },
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

  var validNames = {};
  for (var n = 0; n < tabs.length; n++) {
    validNames[tabs[n].name] = true;
  }
  removeStraySheets_(ss, validNames);

  var stoleDefault = false;
  for (var i = 0; i < tabs.length; i++) {
    var spec = tabs[i];
    var ensured = ensureSheet_(ss, spec.name, stoleDefault);
    var sheet = ensured.sheet;
    if (ensured.usedDefaultSheet1) {
      stoleDefault = true;
    }

    sheet.clear();
    var numCols = spec.headers.length;
    sheet.getRange(1, 1, 1, numCols).setValues([spec.headers]);
    sheet.getRange(1, 1, 1, numCols).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 220);

    if (spec.seedRows && spec.seedRows.length) {
      // getRange(row, column, numRows, numColumns) — third arg is row count, not last row.
      sheet
        .getRange(2, 1, spec.seedRows.length, numCols)
        .setValues(spec.seedRows);
    }

    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(i + 1);
    console.log('Tab ready: ' + spec.name);
  }
}

/**
 * Opens the configured spreadsheet by ID and ensures its display name.
 */
function openSpreadsheetById_(id, name) {
  var ss = SpreadsheetApp.openById(id);
  if (ss.getName() !== name) {
    ss.rename(name);
  }
  return ss;
}

/**
 * Ensures a sheet with the given name exists (reuses default Sheet1 once).
 * @return {{ sheet: GoogleAppsScript.Spreadsheet.Sheet, usedDefaultSheet1: boolean }}
 */
function ensureSheet_(ss, name, stoleDefault) {
  var existing = ss.getSheetByName(name);
  if (existing) {
    return { sheet: existing, usedDefaultSheet1: false };
  }
  var all = ss.getSheets();
  if (
    !stoleDefault &&
    all.length === 1 &&
    all[0].getName() === 'Sheet1'
  ) {
    all[0].setName(name);
    return { sheet: all[0], usedDefaultSheet1: true };
  }
  return { sheet: ss.insertSheet(name), usedDefaultSheet1: false };
}

/**
 * Deletes sheets not in the configured tab set (e.g. leftover Sheet1),
 * never removing the last remaining sheet.
 */
function removeStraySheets_(ss, validNames) {
  var guard = 0;
  while (guard++ < 100) {
    var sheets = ss.getSheets();
    if (sheets.length <= 1) {
      return;
    }
    var removed = false;
    for (var i = 0; i < sheets.length; i++) {
      if (!validNames[sheets[i].getName()]) {
        ss.deleteSheet(sheets[i]);
        removed = true;
        break;
      }
    }
    if (!removed) {
      return;
    }
  }
}
