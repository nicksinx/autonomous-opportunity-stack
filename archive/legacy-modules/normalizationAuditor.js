/**
 * Stage 2 normalization auditor (Item 3 of pipeline hardening plan).
 *
 * Provides:
 *   - normalizeWithAudit(rawSignals, existingTerms) → builds canonical rows AND
 *     emits one normalization_log row per decision (created, merged, skipped,
 *     low_confidence) along with optional watchlist rows.
 *
 * Pure JavaScript, designed for n8n Code-node inlining.
 */

/**
 * Decision types that may appear in normalization_log.decision_type.
 */
const DECISION_TYPES = Object.freeze({
  CREATED: "created",
  MERGED: "merged",
  SKIPPED: "skipped",
  LOW_CONFIDENCE: "low_confidence",
});

/**
 * Confidence threshold below which a merge is escalated to watchlist.
 */
const LOW_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Normalize raw_signals into canonical entities while emitting a complete
 * audit trail of decisions.
 *
 * @param {Array<Object<string, any>>} rawSignals
 * @param {Array<Object<string, any>>} existingTerms Pre-existing normalized_terms rows.
 * @param {{ run_id?: string, run_date?: string }} runMeta
 * @returns {{
 *   normalized_rows: Array<Object<string, any>>,
 *   normalization_log_rows: Array<Object<string, any>>,
 *   watchlist_rows: Array<Object<string, any>>,
 *   stats: {
 *     created: number,
 *     merged: number,
 *     skipped: number,
 *     low_confidence: number,
 *     duplicates: number
 *   }
 * }}
 */
function normalizeWithAudit(rawSignals, existingTerms, runMeta) {
  const list = Array.isArray(rawSignals) ? rawSignals : [];
  const existing = Array.isArray(existingTerms) ? existingTerms : [];
  const meta = runMeta || {};
  const runId = str(meta.run_id) || `run_norm_${Date.now()}`;
  const runDate = str(meta.run_date) || new Date().toISOString().slice(0, 10);

  const existingByCanonicalId = new Map();
  for (const row of existing) {
    const id = str(row.canonical_id);
    if (id) existingByCanonicalId.set(id, row);
  }

  const groups = new Map();
  const logs = [];
  const watchlist = [];
  const stats = { created: 0, merged: 0, skipped: 0, low_confidence: 0, duplicates: 0 };

  for (const raw of list) {
    const term = normalizeText(raw && raw.term);
    const signalId = str(raw && raw.signal_id);
    if (!term || signalId === "ERROR" || term.toLowerCase() === "fetch_failed") {
      logs.push(
        buildLogRow({
          run_id: runId,
          run_date: runDate,
          canonical_id: "",
          input_term: term || str(raw && raw.term),
          decision_type: DECISION_TYPES.SKIPPED,
          confidence: 0,
          merged_into: "",
          reason: "invalid_or_sentinel",
        })
      );
      stats.skipped += 1;
      continue;
    }

    const canonicalId = "norm_" + slugify(term);
    const collectedAt = normalizeText(raw.date_collected) || new Date().toISOString();
    const collectedTs = parseDate(collectedAt);
    const market = normalizeText(raw.market) || "UK";
    const category = normalizeText(raw.category || raw.source || "general") || "general";

    if (existingByCanonicalId.has(canonicalId)) {
      stats.duplicates += 1;
      logs.push(
        buildLogRow({
          run_id: runId,
          run_date: runDate,
          canonical_id: canonicalId,
          input_term: term,
          decision_type: DECISION_TYPES.SKIPPED,
          confidence: 1,
          merged_into: canonicalId,
          reason: "already_canonical",
        })
      );
      continue;
    }

    let group = groups.get(canonicalId);
    const isNew = !group;
    if (isNew) {
      group = {
        canonicalId,
        term,
        firstTs: collectedTs,
        lastTs: collectedTs,
        aliases: new Set([term]),
        markets: new Set(),
        categoryCounts: new Map(),
        contributingSignalIds: [],
      };
      groups.set(canonicalId, group);
    }

    group.firstTs = Math.min(group.firstTs, collectedTs);
    group.lastTs = Math.max(group.lastTs, collectedTs);
    group.aliases.add(term);
    const related = normalizeText(raw.related_term);
    if (related) {
      for (const part of related.split("|")) {
        const alias = normalizeText(part);
        if (alias) group.aliases.add(alias);
      }
    }
    group.markets.add(market);
    group.categoryCounts.set(category, (group.categoryCounts.get(category) || 0) + 1);
    if (signalId) group.contributingSignalIds.push(signalId);

    const confidence = computeMergeConfidence(group, term);
    const decisionType = isNew ? DECISION_TYPES.CREATED : DECISION_TYPES.MERGED;

    logs.push(
      buildLogRow({
        run_id: runId,
        run_date: runDate,
        canonical_id: canonicalId,
        input_term: term,
        decision_type: decisionType,
        confidence,
        merged_into: isNew ? "" : canonicalId,
        reason: isNew ? "new_canonical_term" : "alias_into_existing_group",
      })
    );

    if (decisionType === DECISION_TYPES.MERGED) stats.merged += 1;
    else stats.created += 1;

    if (decisionType === DECISION_TYPES.MERGED && confidence < LOW_CONFIDENCE_THRESHOLD) {
      stats.low_confidence += 1;
      logs.push(
        buildLogRow({
          run_id: runId,
          run_date: runDate,
          canonical_id: canonicalId,
          input_term: term,
          decision_type: DECISION_TYPES.LOW_CONFIDENCE,
          confidence,
          merged_into: canonicalId,
          reason: "merge_below_threshold",
        })
      );
      watchlist.push({
        watch_id: `watch_norm_${canonicalId}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        canonical_id: canonicalId,
        reason: "normalization_low_confidence",
        review_after: runDate,
        notes: `Auto-flagged: alias '${term}' merged at confidence ${confidence.toFixed(2)}`,
      });
    }
  }

  const normalizedRows = Array.from(groups.values()).map((group) => {
    let primaryCategory = "general";
    let maxCount = 0;
    for (const [category, count] of group.categoryCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        primaryCategory = category;
      }
    }
    return {
      canonical_id: group.canonicalId,
      date_first_seen: isoDate(group.firstTs),
      date_last_seen: isoDate(group.lastTs),
      canonical_term: titleCase(group.term),
      aliases: Array.from(group.aliases).join("|"),
      language: "en",
      market: Array.from(group.markets).join("|"),
      primary_category: primaryCategory,
      status: "active",
    };
  });

  return {
    normalized_rows: normalizedRows,
    normalization_log_rows: logs,
    watchlist_rows: watchlist,
    stats,
  };
}

function buildLogRow(input) {
  const i = input || {};
  return {
    log_id: `norm_${str(i.canonical_id) || "noid"}_${hash(str(i.input_term))}_${Date.now()}_${Math.floor(
      Math.random() * 1e6
    )}`,
    run_id: str(i.run_id),
    run_date: str(i.run_date),
    canonical_id: str(i.canonical_id),
    input_term: str(i.input_term),
    decision_type: str(i.decision_type),
    confidence: round2(num(i.confidence)),
    merged_into: str(i.merged_into),
    reason: str(i.reason),
    created_at: new Date().toISOString(),
  };
}

/**
 * Compute a merge confidence score in [0, 1] based on string distance and
 * shared categories. Conservative: short tokens get penalized.
 */
function computeMergeConfidence(group, candidateTerm) {
  const candidate = String(candidateTerm || "").toLowerCase();
  const base = String(group.term || "").toLowerCase();
  if (!candidate || !base) return 0;
  if (candidate === base) return 1;

  const tokensA = new Set(candidate.split(/\s+/).filter(Boolean));
  const tokensB = new Set(base.split(/\s+/).filter(Boolean));
  const intersect = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size || 1;
  const jaccard = intersect / union;

  const lengthPenalty = candidate.length < 4 ? 0.5 : 1;
  return Math.min(1, jaccard * lengthPenalty + (jaccard >= 0.5 ? 0.1 : 0));
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function titleCase(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseDate(value) {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : Date.now();
}

function isoDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function hash(value) {
  let h = 0;
  const s = String(value || "");
  for (let i = 0; i < s.length; i += 1) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

if (typeof module !== "undefined") {
  module.exports = { normalizeWithAudit, DECISION_TYPES, LOW_CONFIDENCE_THRESHOLD };
}

if (typeof require !== "undefined" && require.main === module) {
  const sample = [
    { signal_id: "s1", term: "Pickleball Mom", date_collected: "2026-04-26T00:00:00Z", market: "UK", source: "etsy_autocomplete", related_term: "pickleball|mom" },
    { signal_id: "s2", term: "pickleball mom", date_collected: "2026-04-27T00:00:00Z", market: "UK", source: "etsy_autocomplete" },
    { signal_id: "s3", term: "Pickleball Dad", date_collected: "2026-04-27T00:00:00Z", market: "UK", source: "etsy_autocomplete" },
    { signal_id: "s4", term: "ABC", date_collected: "2026-04-27T00:00:00Z", market: "UK", source: "google_trends" },
  ];
  const existing = [];
  const result = normalizeWithAudit(sample, existing, { run_id: "run_demo", run_date: "2026-04-28" });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}
