/**
 * Builds or refreshes the formula-driven scoring dashboard tab.
 */
function buildScoringDashboard() {
  var SPREADSHEET_ID = '1hw0ZBypwMfc8ivpQ-CQlhDfVJK9w5PqnageeIAzUdvE';
  var TAB_NAME = 'dashboard';

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(TAB_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TAB_NAME);
  } else {
    sheet.clear();
    sheet.clearConditionalFormatRules();
  }

  // Section 1: Today's Summary (rows 1-8)
  sheet.getRange('A1').setValue('POD Opportunity Scoring Dashboard');
  sheet.getRange('A1:H1').merge();
  sheet.getRange('A2').setValue('Last updated:');
  sheet.getRange('B2').setFormula('=NOW()');
  sheet.getRange('A3').setValue('Run date:');
  sheet.getRange('B3').setFormula('=MAX(opportunity_scores!C:C)');
  sheet.getRange('A4').setValue('Candidates scored:');
  sheet.getRange('B4').setFormula('=COUNTIF(opportunity_scores!C:C, B3)');
  sheet.getRange('A5').setValue('Tier A (design now):');
  sheet.getRange('B5').setFormula('=COUNTIFS(opportunity_scores!C:C, B3, opportunity_scores!V:V, "A")');
  sheet.getRange('A6').setValue('Tier B (review):');
  sheet.getRange('B6').setFormula('=COUNTIFS(opportunity_scores!C:C, B3, opportunity_scores!V:V, "B")');
  sheet.getRange('A7').setValue('Tier C (watchlist):');
  sheet.getRange('B7').setFormula('=COUNTIFS(opportunity_scores!C:C, B3, opportunity_scores!V:V, "C")');
  sheet.getRange('A8').setValue('Avg opp score:');
  sheet.getRange('B8').setFormula('=AVERAGEIF(opportunity_scores!C:C, B3, opportunity_scores!U:U)');

  // Section 2: Top 10 Opportunities Today (rows 10-22)
  sheet
    .getRange('A10:I10')
    .setValues([[
      'Rank',
      'Keyword',
      'Tier',
      'Opp Score',
      'Demand',
      'Competition',
      'Conversion',
      'Creative',
      'Action',
    ]]);

  for (var row = 11; row <= 20; row++) {
    var kFormula = '=ROW()-10';
    var scoreFormula =
      '=IFERROR(LARGE(FILTER(opportunity_scores!U:U, opportunity_scores!C:C=$B$3), ROW()-10), "")';
    var keywordFormula =
      '=IF($D' +
      row +
      '="","",INDEX(opportunity_scores!D:D, MATCH(1, (opportunity_scores!C:C=$B$3)*(opportunity_scores!U:U=$D' +
      row +
      '), 0)))';
    var tierFormula =
      '=IF($D' +
      row +
      '="","",INDEX(opportunity_scores!V:V, MATCH(1, (opportunity_scores!C:C=$B$3)*(opportunity_scores!U:U=$D' +
      row +
      '), 0)))';
    var demandFormula =
      '=IF($D' +
      row +
      '="","",INDEX(opportunity_scores!J:J, MATCH(1, (opportunity_scores!C:C=$B$3)*(opportunity_scores!U:U=$D' +
      row +
      '), 0)))';
    var competitionFormula =
      '=IF($D' +
      row +
      '="","",INDEX(opportunity_scores!K:K, MATCH(1, (opportunity_scores!C:C=$B$3)*(opportunity_scores!U:U=$D' +
      row +
      '), 0)))';
    var conversionFormula =
      '=IF($D' +
      row +
      '="","",INDEX(opportunity_scores!L:L, MATCH(1, (opportunity_scores!C:C=$B$3)*(opportunity_scores!U:U=$D' +
      row +
      '), 0)))';
    var creativeFormula =
      '=IF($D' +
      row +
      '="","",INDEX(opportunity_scores!M:M, MATCH(1, (opportunity_scores!C:C=$B$3)*(opportunity_scores!U:U=$D' +
      row +
      '), 0)))';
    var actionFormula =
      '=IF($D' +
      row +
      '="","",INDEX(opportunity_scores!W:W, MATCH(1, (opportunity_scores!C:C=$B$3)*(opportunity_scores!U:U=$D' +
      row +
      '), 0)))';

    sheet.getRange('A' + row).setFormula(kFormula);
    sheet.getRange('B' + row).setFormula(keywordFormula);
    sheet.getRange('C' + row).setFormula(tierFormula);
    sheet.getRange('D' + row).setFormula(scoreFormula);
    sheet.getRange('E' + row).setFormula(demandFormula);
    sheet.getRange('F' + row).setFormula(competitionFormula);
    sheet.getRange('G' + row).setFormula(conversionFormula);
    sheet.getRange('H' + row).setFormula(creativeFormula);
    sheet.getRange('I' + row).setFormula(actionFormula);
  }
  sheet.getRange('A22').setValue('View all in opportunity_scores tab →');

  // Section 3: Score Weights (rows 24-35)
  sheet
    .getRange('A24:C24')
    .setValues([['Dimension', 'Current Weight', 'Enabled']]);
  sheet.getRange('A25:C33').setFormula('=score_weights!A2:C10');
  sheet.getRange('A35').setValue('Edit weights in score_weights tab to adjust scoring');

  // Section 4: Feedback Performance (rows 37-45)
  sheet.getRange('A37:B37').setValues([['Metric', 'Value']]);
  sheet.getRange('A38').setValue('Total feedback rows');
  sheet.getRange('B38').setFormula('=COUNTA(performance_feedback!A:A)-1');
  sheet.getRange('A39').setValue('Avg units sold (30d)');
  sheet.getRange('B39').setFormula('=AVERAGE(performance_feedback!F:F)');
  sheet.getRange('A40').setValue('Avg gross margin %');
  sheet.getRange('B40').setFormula('=AVERAGE(performance_feedback!H:H)');
  sheet.getRange('A41').setValue('Avg conversion rate');
  sheet.getRange('B41').setFormula('=AVERAGE(performance_feedback!J:J)');

  // Section 5: Pipeline Observability (rows 47-58)
  sheet.getRange('A47:B47').setValues([['Pipeline observability (last 7 days)', 'Value']]);
  sheet.getRange('A48').setValue('Stage runs (7d)');
  sheet.getRange('B48').setFormula(
    '=IFERROR(COUNTIFS(stage_run_logs!F:F, ">="&TEXT(TODAY()-7,"YYYY-MM-DD"), stage_run_logs!E:E, "<>start"), 0)'
  );
  sheet.getRange('A49').setValue('Stage errors (7d)');
  sheet.getRange('B49').setFormula(
    '=IFERROR(COUNTIFS(stage_run_logs!F:F, ">="&TEXT(TODAY()-7,"YYYY-MM-DD"), stage_run_logs!L:L, "error"), 0)'
  );
  sheet.getRange('A50').setValue('Stage warns (7d)');
  sheet.getRange('B50').setFormula(
    '=IFERROR(COUNTIFS(stage_run_logs!F:F, ">="&TEXT(TODAY()-7,"YYYY-MM-DD"), stage_run_logs!L:L, "warn"), 0)'
  );
  sheet.getRange('A51').setValue('Success rate %');
  sheet.getRange('B51').setFormula(
    '=IFERROR(IF(B48=0,"-",ROUND((B48-B49)/B48*100,1)),"-")'
  );
  sheet.getRange('A52').setValue('Avg duration ms');
  sheet.getRange('B52').setFormula(
    '=IFERROR(AVERAGEIFS(stage_run_logs!H:H, stage_run_logs!F:F, ">="&TEXT(TODAY()-7,"YYYY-MM-DD"), stage_run_logs!E:E, "<>start"), 0)'
  );
  sheet.getRange('A53').setValue('Source-health rows (7d)');
  sheet.getRange('B53').setFormula(
    '=IFERROR(COUNTIF(source_health!C:C, ">="&TEXT(TODAY()-7,"YYYY-MM-DD")), 0)'
  );
  sheet.getRange('A54').setValue('Source-health errors (7d)');
  sheet.getRange('B54').setFormula(
    '=IFERROR(COUNTIFS(source_health!C:C, ">="&TEXT(TODAY()-7,"YYYY-MM-DD"), source_health!E:E, "error"), 0)'
  );
  sheet.getRange('A55').setValue('Queue rows pending');
  sheet.getRange('B55').setFormula(
    '=IFERROR(COUNTIF(publishing_queue!G:G, "pending"), 0)'
  );
  sheet.getRange('A56').setValue('Queue rows published');
  sheet.getRange('B56').setFormula(
    '=IFERROR(COUNTIF(publishing_queue!G:G, "published"), 0)'
  );
  sheet.getRange('A57').setValue('Active locks (now)');
  sheet.getRange('B57').setFormula(
    '=IFERROR(COUNTIF(pipeline_locks!I:I, "active"), 0)'
  );
  sheet.getRange('A58').setValue('Mirror writes (7d)');
  sheet.getRange('B58').setFormula(
    '=IFERROR(COUNTIF(dual_write_mirror_log!K:K, ">="&TEXT(TODAY()-7,"YYYY-MM-DD")), 0)'
  );
  sheet.getRange('A47:B47').setFontWeight('bold');

  // Formatting
  sheet.getRange('1:1').setFontWeight('bold').setFontSize(14);
  sheet.getRange('10:10').setFontWeight('bold');
  sheet.getRange('24:24').setFontWeight('bold');
  sheet.getRange('37:37').setFontWeight('bold');

  sheet.setColumnWidth(1, 200); // A
  sheet.setColumnWidth(2, 120); // B
  sheet.setColumnWidth(3, 80);  // C
  sheet.setColumnWidth(4, 100); // D
  sheet.setColumnWidth(5, 90);  // E
  sheet.setColumnWidth(6, 90);  // F
  sheet.setColumnWidth(7, 90);  // G
  sheet.setColumnWidth(8, 90);  // H
  sheet.setColumnWidth(9, 90);  // I

  sheet.setFrozenRows(2);

  // Conditional formatting for Opp Score column (D11:D20)
  var oppScoreRange = sheet.getRange('D11:D20');
  var rules = [];
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThanOrEqualTo(75)
      .setBackground('#C6EFCE')
      .setRanges([oppScoreRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($D11>=55,$D11<75)')
      .setBackground('#FFEB9C')
      .setRanges([oppScoreRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($D11>=35,$D11<55)')
      .setBackground('#FCE4D6')
      .setRanges([oppScoreRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberLessThan(35)
      .setBackground('#F4CCCC')
      .setRanges([oppScoreRange])
      .build()
  );
  sheet.setConditionalFormatRules(rules);
}

/**
 * Convenience wrapper to rebuild the dashboard and log completion.
 */
function rebuildDashboard() {
  buildScoringDashboard();
  console.log('Dashboard rebuilt at: ' + new Date().toISOString());
}
