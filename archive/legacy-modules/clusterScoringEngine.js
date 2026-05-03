/**
 * Deterministic cluster scoring engine.
 * Recomputes cluster_score independently from LLM output.
 */

/**
 * @typedef {Object<string, any>} ClusterInput
 * @property {string} [cluster_id]
 * @property {string} [occasion_type]
 * @property {string} [primary_category]
 * @property {string} [risk_level]
 * @property {number} [term_count]
 * @property {Array<string>} [product_fit]
 * @property {Array<string>} [style_fit]
 * @property {Array<Object<string, any>>} [members]
 * @property {Array<string>} [flags]
 * @property {string} [seasonality]
 * @property {string} [event_date]
 */

/**
 * @typedef {Object<string, any>} MemberPayload
 * @property {string} [canonical_id]
 * @property {string} [primary_category]
 * @property {number} [buyer_intent_score]
 * @property {number} [risk_score]
 * @property {number} [alias_count]
 * @property {Array<string>} [top_evidence_phrases]
 * @property {Array<string>} [aliases]
 */

/**
 * Score one cluster.
 *
 * @param {ClusterInput} cluster Validated cluster object.
 * @param {MemberPayload[]} memberPayloads Payloads for included canonical_ids.
 * @returns {{
 *   cluster_id: string,
 *   C_cohesion: number,
 *   I_intent: number,
 *   D_design_depth: number,
 *   S_seasonality: number,
 *   Q_query_richness: number,
 *   R_risk: number,
 *   raw_score: number,
 *   final_score: number,
 *   recommended_status: "approved" | "draft" | "watchlist" | "rejected",
 *   score_breakdown: string
 * }}
 */
function scoreCluster(cluster, memberPayloads) {
  const c = cluster || {};
  const payloads = Array.isArray(memberPayloads) ? memberPayloads : [];

  const C = scoreCohesion(c, payloads);
  const I = scoreIntent(c, payloads);
  const D = scoreDesignDepth(c, payloads);
  const S = scoreSeasonality(c, payloads);
  const Q = scoreQueryRichness(c, payloads);
  const R = scoreRisk(c, payloads);

  const raw = (0.3 * C) + (0.25 * I) + (0.2 * D) + (0.15 * S) + (0.1 * Q) - (0.2 * R);
  const finalScore = round1(clamp(raw, 0, 100));
  const status = recommendedStatus(finalScore);

  return {
    cluster_id: str(c.cluster_id) || "unknown_cluster",
    C_cohesion: round1(C),
    I_intent: round1(I),
    D_design_depth: round1(D),
    S_seasonality: round1(S),
    Q_query_richness: round1(Q),
    R_risk: round1(R),
    raw_score: round1(raw),
    final_score: finalScore,
    recommended_status: status,
    score_breakdown: `C:${round1(C)}|I:${round1(I)}|D:${round1(D)}|S:${round1(S)}|Q:${round1(Q)}|R:${round1(R)}|raw:${round1(raw)}|final:${finalScore}`,
  };
}

/**
 * Batch score clusters.
 *
 * @param {ClusterInput[]} clusters Array of clusters.
 * @param {Record<string, MemberPayload>} payloadMap canonical_id => payload lookup.
 * @returns {ReturnType<typeof scoreCluster>[]}
 */
function batchScoreClusters(clusters, payloadMap) {
  const list = Array.isArray(clusters) ? clusters : [];
  const map = payloadMap && typeof payloadMap === "object" ? payloadMap : {};
  const out = [];

  for (const cluster of list) {
    const memberIds = extractMemberIds(cluster);
    const members = memberIds
      .map((id) => map[id])
      .filter(Boolean);
    out.push(scoreCluster(cluster, members));
  }
  return out;
}

/**
 * C — Cohesion score.
 * @private
 */
function scoreCohesion(cluster, payloads) {
  let s = 50;
  const flags = normalizeFlags(cluster.flags);
  const memberMeta = Array.isArray(cluster.members) ? cluster.members : [];

  if (allSameNonEmpty(memberMeta.map((m) => str(m.occasion_type)))) s += 20;
  if (allSameNonEmpty(payloads.map((p) => str(p.primary_category)))) s += 15;

  const fitAvg = average(memberMeta.map((m) => num(m.fit_score)));
  if (fitAvg >= 75) s += 10;
  if (num(cluster.term_count) >= 5) s += 5;

  if (flags.has("mixed_intent")) s -= 10;
  if (flags.has("vague_name")) s -= 10;
  if (flags.has("too_small")) s -= 5;

  return clamp(s, 0, 100);
}

/**
 * I — Intent score.
 * @private
 */
function scoreIntent(_cluster, payloads) {
  const base = payloads.length
    ? average(payloads.map((p) => num(p.buyer_intent_score)))
    : 50;
  const hasEtsyEvidence = payloads.some((p) => Array.isArray(p.top_evidence_phrases) && p.top_evidence_phrases.length > 0);
  const s = base + (hasEtsyEvidence ? 10 : 0);
  return clamp(s, 0, 100);
}

/**
 * D — Design depth score.
 * @private
 */
function scoreDesignDepth(cluster, _payloads) {
  const productFit = toArray(cluster.product_fit);
  const styleFit = toArray(cluster.style_fit);
  const occasionType = str(cluster.occasion_type).toLowerCase();

  let s = Math.min(productFit.length * 15, 60);
  if (styleFit.length >= 2) s += 15;
  if (occasionType === "identity-based") s += 10;
  if (occasionType === "evergreen") s += 5;
  if (num(cluster.term_count) >= 8) s += 10;

  return clamp(s, 0, 100);
}

/**
 * S — Seasonality timing score.
 * @private
 */
function scoreSeasonality(cluster, _payloads) {
  const occasionType = str(cluster.occasion_type).toLowerCase();
  const seasonality = str(cluster.seasonality).toLowerCase();

  if (occasionType === "evergreen") return 80;

  if (occasionType === "seasonal") {
    const qNow = currentQuarter();
    const qTarget = quarterFromSeasonality(seasonality);
    if (!qTarget) return 50;
    const ahead = quarterDistance(qNow, qTarget);
    if (ahead === 0) return 70;
    if (ahead === 1) return 50;
    return 30;
  }

  if (occasionType === "event-based") {
    const days = daysUntil(cluster.event_date);
    if (days == null) return 50;
    if (days <= 60) return 60;
    if (days <= 90) return 40;
    return 20;
  }

  return 50;
}

/**
 * Q — Query richness score.
 * @private
 */
function scoreQueryRichness(_cluster, payloads) {
  let aliasSum = 0;
  const phrases = new Set();

  for (const p of payloads) {
    if (num(p.alias_count) > 0) {
      aliasSum += num(p.alias_count);
    } else if (Array.isArray(p.aliases)) {
      aliasSum += p.aliases.length;
    }
    for (const phrase of toArray(p.top_evidence_phrases)) {
      const v = str(phrase);
      if (v) phrases.add(v.toLowerCase());
    }
  }

  const aliasPart = (Math.min(aliasSum, 30) / 30) * 60;
  const phrasePart = (Math.min(phrases.size, 20) / 20) * 40;
  return clamp(aliasPart + phrasePart, 0, 100);
}

/**
 * R — Risk score.
 * @private
 */
function scoreRisk(cluster, payloads) {
  const avgRisk = payloads.length
    ? average(payloads.map((p) => num(p.risk_score)))
    : 0;
  const level = str(cluster.risk_level).toLowerCase();
  let bonus = 0;
  if (level === "high") bonus = 30;
  else if (level === "medium") bonus = 15;
  return clamp(avgRisk + bonus, 0, 100);
}

function recommendedStatus(finalScore) {
  if (finalScore >= 75) return "approved";
  if (finalScore >= 60) return "draft";
  if (finalScore >= 45) return "watchlist";
  return "rejected";
}

function extractMemberIds(cluster) {
  const members = Array.isArray(cluster?.members) ? cluster.members : [];
  const ids = [];
  for (const m of members) {
    const id = str(m.canonical_id);
    if (id) ids.push(id);
  }
  return ids;
}

function normalizeFlags(flags) {
  const set = new Set();
  if (!Array.isArray(flags)) return set;
  for (const f of flags) {
    const k = str(f).toLowerCase();
    if (k) set.add(k);
  }
  return set;
}

function allSameNonEmpty(values) {
  const nonEmpty = values.map((v) => str(v)).filter(Boolean);
  if (!nonEmpty.length) return false;
  return new Set(nonEmpty).size === 1;
}

function average(values) {
  const nums = values.map(num).filter((v) => Number.isFinite(v));
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function currentQuarter() {
  const m = new Date().getMonth(); // 0-11
  return Math.floor(m / 3) + 1;
}

function quarterFromSeasonality(seasonality) {
  const s = String(seasonality || "").toUpperCase();
  const m = s.match(/Q([1-4])/);
  return m ? Number(m[1]) : null;
}

function quarterDistance(nowQ, targetQ) {
  if (!nowQ || !targetQ) return null;
  return (targetQ - nowQ + 4) % 4;
}

function daysUntil(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const now = new Date();
  const ms = d.getTime() - now.getTime();
  return Math.floor(ms / 86400000);
}

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Run deterministic smoke tests.
 */
function runTests() {
  const teacherCluster = {
    cluster_id: "clu_teacher_gifts",
    occasion_type: "evergreen",
    risk_level: "low",
    term_count: 8,
    product_fit: ["shirt", "mug", "sticker", "gift_format"],
    style_fit: ["typography", "retro"],
    members: [
      { canonical_id: "c_teacher_1", occasion_type: "evergreen", fit_score: 82 },
      { canonical_id: "c_teacher_2", occasion_type: "evergreen", fit_score: 79 },
      { canonical_id: "c_teacher_3", occasion_type: "evergreen", fit_score: 76 },
    ],
    flags: [],
    seasonality: "year_round",
  };

  const teacherPayloads = [
    { canonical_id: "c_teacher_1", primary_category: "gifts", buyer_intent_score: 82, risk_score: 18, alias_count: 6, top_evidence_phrases: ["teacher mug", "teacher gift"] },
    { canonical_id: "c_teacher_2", primary_category: "gifts", buyer_intent_score: 78, risk_score: 15, alias_count: 5, top_evidence_phrases: ["teacher shirt"] },
    { canonical_id: "c_teacher_3", primary_category: "gifts", buyer_intent_score: 80, risk_score: 20, alias_count: 4, top_evidence_phrases: ["best teacher gift"] },
  ];

  const celebrityCluster = {
    cluster_id: "clu_celebrity_risk",
    occasion_type: "seasonal",
    risk_level: "high",
    term_count: 3,
    product_fit: ["shirt"],
    style_fit: [],
    members: [
      { canonical_id: "c_celeb_1", occasion_type: "event-based", fit_score: 52 },
      { canonical_id: "c_celeb_2", occasion_type: "seasonal", fit_score: 48 },
    ],
    flags: ["mixed_intent", "vague_name", "too_small"],
    seasonality: "Q4",
    event_date: "2027-12-20",
  };

  const celebrityPayloads = [
    { canonical_id: "c_celeb_1", primary_category: "celebrity", buyer_intent_score: 22, risk_score: 88, alias_count: 1, top_evidence_phrases: [] },
    { canonical_id: "c_celeb_2", primary_category: "celebrity", buyer_intent_score: 18, risk_score: 90, alias_count: 1, top_evidence_phrases: [] },
  ];

  const teacherResult = scoreCluster(teacherCluster, teacherPayloads);
  const celebResult = scoreCluster(celebrityCluster, celebrityPayloads);

  // eslint-disable-next-line no-console
  console.log("Teacher cluster:", teacherResult);
  // eslint-disable-next-line no-console
  console.log("Celebrity cluster:", celebResult);
  // eslint-disable-next-line no-console
  console.log("Teacher >= 70:", teacherResult.final_score >= 70);
  // eslint-disable-next-line no-console
  console.log("Celebrity <= 30:", celebResult.final_score <= 30);
}

module.exports = { scoreCluster, batchScoreClusters };

if (require.main === module) {
  runTests();
}
