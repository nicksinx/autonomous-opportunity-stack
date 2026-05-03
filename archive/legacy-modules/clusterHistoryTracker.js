/**
 * Cluster history reconciliation and metrics tracking utilities.
 * Pure JavaScript, no external dependencies.
 */

/**
 * Reconcile today's clusters against historical clusters.
 *
 * @param {Array<Object<string, any>>} todayClusters Validated clusters from current run.
 * @param {Array<Object<string, any>>} historicalClusters All historical rows from theme_clusters tab.
 * @returns {{
 *   reconciled_clusters: Array<Object<string, any>>,
 *   history_rows: Array<{
 *     history_id: string,
 *     cluster_id: string,
 *     run_date: string,
 *     change_type: "created" | "updated" | "disappeared" | "merged" | "split",
 *     old_value: string,
 *     new_value: string,
 *     notes: string
 *   }>,
 *   new_count: number,
 *   updated_count: number,
 *   disappeared_count: number
 * }}
 */
function reconcileClusters(todayClusters, historicalClusters) {
  const today = Array.isArray(todayClusters) ? todayClusters : [];
  const history = Array.isArray(historicalClusters) ? historicalClusters : [];
  const runDate = isoDay(new Date());

  // Index historical records by normalized slug; prefer latest by run_date.
  const historyBySlug = new Map();
  for (const row of history) {
    const key = normalizedSlug(row.theme_slug || row.theme_name);
    if (!key) continue;
    const existing = historyBySlug.get(key);
    if (!existing || String(row.run_date || "") > String(existing.run_date || "")) {
      historyBySlug.set(key, row);
    }
  }

  const reconciled = [];
  const historyRows = [];
  const matchedHistoryIds = new Set();
  let newCount = 0;
  let updatedCount = 0;

  for (const t of today) {
    const key = normalizedSlug(t.theme_slug || t.theme_name);
    const candidate = key ? historyBySlug.get(key) : null;
    const prev =
      candidate && !matchedHistoryIds.has(str(candidate.cluster_id))
        ? candidate
        : null;
    const next = { ...t };

    if (!prev) {
      newCount += 1;
      reconciled.push(next);
      historyRows.push({
        history_id: `hist_${str(next.cluster_id)}_${runDate}`,
        cluster_id: str(next.cluster_id),
        run_date: runDate,
        change_type: "created",
        old_value: "",
        new_value: compactFields(next),
        notes: "New cluster created",
      });
      continue;
    }

    matchedHistoryIds.add(str(prev.cluster_id));
    // Reuse stable cluster_id
    next.cluster_id = str(prev.cluster_id);
    reconciled.push(next);

    const diff = materialDiff(prev, next);
    if (diff.changed) {
      updatedCount += 1;
      historyRows.push({
        history_id: `hist_${str(next.cluster_id)}_${runDate}`,
        cluster_id: str(next.cluster_id),
        run_date: runDate,
        change_type: "updated",
        old_value: diff.oldValue,
        new_value: diff.newValue,
        notes: diff.notes,
      });
    }
  }

  let disappearedCount = 0;
  // Only evaluate disappearance against the same "current historical baseline"
  // used for matching (latest record per normalized slug). Older historical
  // rows for the same slug represent evolution history, not disappeared clusters.
  for (const row of historyBySlug.values()) {
    const id = str(row.cluster_id);
    if (!id || matchedHistoryIds.has(id)) continue;

    disappearedCount += 1;
    historyRows.push({
      history_id: `hist_${id}_${runDate}_disappeared`,
      cluster_id: id,
      run_date: runDate,
      change_type: "disappeared",
      old_value: compactFields(row),
      new_value: "",
      notes: "Cluster not present in today's run",
    });
  }

  return {
    reconciled_clusters: reconciled,
    history_rows: historyRows,
    new_count: newCount,
    updated_count: updatedCount,
    disappeared_count: disappearedCount,
  };
}

/**
 * Build a weekly cluster_metrics row.
 *
 * @param {Array<Object<string, any>>} reconciledClusters Reconciled cluster rows for run.
 * @param {string} runDate ISO date (YYYY-MM-DD).
 * @returns {{
 *   metric_id: string,
 *   week_start: string,
 *   total_clusters_generated: number,
 *   approved_count: number,
 *   avg_cluster_score: number,
 *   avg_terms_per_cluster: number,
 *   pct_sent_to_review: number,
 *   pct_briefs_approved: number,
 *   pct_rejected_weak_intent: number,
 *   pct_rejected_risk: number,
 *   notes: string
 * }}
 */
function generateMetricsRow(reconciledClusters, runDate) {
  const list = Array.isArray(reconciledClusters) ? reconciledClusters : [];
  const total = list.length;
  const approved = list.filter((c) => str(c.status).toLowerCase() === "approved").length;

  const avgClusterScore = total
    ? round1(sum(list.map((c) => num(c.cluster_score))) / total)
    : 0;
  const avgTerms = total
    ? round1(sum(list.map((c) => num(c.term_count))) / total)
    : 0;

  const reviewCount = list.filter((c) => shouldSendToReview(c)).length;
  const rejectedWeakIntent = list.filter(
    (c) =>
      str(c.status).toLowerCase() === "rejected" &&
      num(c.I_intent) < 40
  ).length;
  const rejectedRisk = list.filter(
    (c) =>
      str(c.status).toLowerCase() === "rejected" &&
      str(c.risk_level).toLowerCase() === "high"
  ).length;

  return {
    metric_id: `met_${runDate}`,
    week_start: weekStartMonday(runDate),
    total_clusters_generated: total,
    approved_count: approved,
    avg_cluster_score: avgClusterScore,
    avg_terms_per_cluster: avgTerms,
    pct_sent_to_review: pct(reviewCount, total),
    pct_briefs_approved: pct(approved, total),
    pct_rejected_weak_intent: pct(rejectedWeakIntent, total),
    pct_rejected_risk: pct(rejectedRisk, total),
    notes: "",
  };
}

/**
 * Example: one updated, one created, one disappeared.
 */
function runExample() {
  const todayClusters = [
    {
      cluster_id: "clu_tmp_1",
      run_date: "2026-04-28",
      theme_name: "Teacher Gifts",
      theme_slug: "teacher-gifts-002",
      term_count: 9,
      cluster_score: 82,
      status: "approved",
      risk_level: "low",
      I_intent: 72,
    },
    {
      cluster_id: "clu_tmp_2",
      run_date: "2026-04-28",
      theme_name: "Dog Mom Humor",
      theme_slug: "dog-mom-humor-001",
      term_count: 6,
      cluster_score: 64,
      status: "draft",
      risk_level: "medium",
      I_intent: 55,
    },
    {
      cluster_id: "clu_tmp_3",
      run_date: "2026-04-28",
      theme_name: "Minimalist Quotes",
      theme_slug: "minimalist-quotes-001",
      term_count: 4,
      cluster_score: 43,
      status: "rejected",
      risk_level: "high",
      I_intent: 30,
    },
  ];

  const historicalClusters = [
    {
      cluster_id: "clu_teacher_stable",
      run_date: "2026-04-27",
      theme_name: "Teacher Gifts",
      theme_slug: "teacher-gifts-001",
      term_count: 6,
      cluster_score: 72,
      status: "draft",
      risk_level: "low",
    },
    {
      cluster_id: "clu_pet_legacy",
      run_date: "2026-04-27",
      theme_name: "Pet Name Stickers",
      theme_slug: "pet-name-stickers-001",
      term_count: 7,
      cluster_score: 59,
      status: "watchlist",
      risk_level: "low",
    },
  ];

  const reconciled = reconcileClusters(todayClusters, historicalClusters);
  const metrics = generateMetricsRow(
    reconciled.reconciled_clusters,
    "2026-04-28"
  );

  // eslint-disable-next-line no-console
  console.log("Reconcile:", JSON.stringify(reconciled, null, 2));
  // eslint-disable-next-line no-console
  console.log("Metrics:", JSON.stringify(metrics, null, 2));
}

function normalizedSlug(value) {
  let s = str(value).toLowerCase();
  if (!s) return "";
  s = s.replace(/[_\s]+/g, "-");
  s = s.replace(/-\d+$/, ""); // strip trailing numeric suffix
  s = s.replace(/[^a-z0-9-]+/g, "");
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s;
}

function materialDiff(prev, next) {
  const changes = [];
  const oldParts = [];
  const newParts = [];

  const scoreDelta = Math.abs(num(prev.cluster_score) - num(next.cluster_score));
  if (scoreDelta > 5) {
    changes.push("cluster_score");
    oldParts.push(`cluster_score:${num(prev.cluster_score)}`);
    newParts.push(`cluster_score:${num(next.cluster_score)}`);
  }

  const termDelta = Math.abs(num(prev.term_count) - num(next.term_count));
  if (termDelta > 2) {
    changes.push("term_count");
    oldParts.push(`term_count:${num(prev.term_count)}`);
    newParts.push(`term_count:${num(next.term_count)}`);
  }

  if (str(prev.status) !== str(next.status)) {
    changes.push("status");
    oldParts.push(`status:${str(prev.status)}`);
    newParts.push(`status:${str(next.status)}`);
  }

  if (str(prev.risk_level) !== str(next.risk_level)) {
    changes.push("risk_level");
    oldParts.push(`risk_level:${str(prev.risk_level)}`);
    newParts.push(`risk_level:${str(next.risk_level)}`);
  }

  return {
    changed: changes.length > 0,
    oldValue: oldParts.join("|"),
    newValue: newParts.join("|"),
    notes: changes.length
      ? `Material update: ${changes.join(", ")}`
      : "",
  };
}

function compactFields(row) {
  return [
    `theme_slug:${str(row.theme_slug)}`,
    `term_count:${num(row.term_count)}`,
    `cluster_score:${num(row.cluster_score)}`,
    `status:${str(row.status)}`,
    `risk_level:${str(row.risk_level)}`,
  ].join("|");
}

function shouldSendToReview(cluster) {
  const status = str(cluster.status).toLowerCase();
  return status === "draft" || status === "watchlist";
}

function weekStartMonday(dateLike) {
  const d = new Date(dateLike);
  if (!Number.isFinite(d.getTime())) return "";
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const delta = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

function pct(part, total) {
  if (!total) return 0;
  return round1((part / total) * 100);
}

function sum(arr) {
  return (arr || []).reduce((a, b) => a + num(b), 0);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

module.exports = { reconcileClusters, generateMetricsRow };

if (require.main === module) {
  runExample();
}
