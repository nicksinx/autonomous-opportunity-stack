/**
 * Build compact LLM clustering payload from scored/canonical/evidence sheets data.
 */

/** @type {Array<{ match: RegExp, hint: string }>} */
const PRODUCT_HINT_RULES = [
  { match: /\bmug\b/i, hint: "mug" },
  { match: /\b(shirt|tshirt|tee)\b/i, hint: "shirt" },
  { match: /\bsticker\b/i, hint: "sticker" },
  { match: /\b(tote|bag)\b/i, hint: "tote_bag" },
  { match: /\b(sweatshirt|hoodie)\b/i, hint: "sweatshirt" },
  { match: /\b(card|gift)\b/i, hint: "gift_format" },
];

/** @type {Array<{ match: RegExp, hint: string }>} */
const SEASONALITY_HINT_RULES = [
  { match: /\b(christmas|xmas)\b/i, hint: "Q4 gifts" },
  { match: /\b(mother|mum|mom)\b/i, hint: "Mother's Day" },
  { match: /\b(father|dad)\b/i, hint: "Father's Day" },
  { match: /\b(teacher|school)\b/i, hint: "back to school" },
  { match: /\b(valentines|valentine)\b/i, hint: "Valentine's Day" },
  { match: /\bhalloween\b/i, hint: "Halloween" },
  { match: /\beaster\b/i, hint: "Easter" },
  { match: /\bbirthday\b/i, hint: "year-round gifting" },
  { match: /\b(wedding|bride)\b/i, hint: "wedding season" },
  { match: /\b(summer|holiday)\b/i, hint: "summer" },
  { match: /\bwinter\b/i, hint: "Q4/winter" },
];

/**
 * Build the LLM clustering payload.
 *
 * @param {Array<Object<string, any>>} scoredTerms trend_scores rows (already filtered to target run/date/decision by caller).
 * @param {Array<Object<string, any>>} canonicalTerms normalized_terms rows.
 * @param {Array<Object<string, any>>} evidenceRows marketplace_evidence rows.
 * @returns {Array<{
 *  canonical_id: string,
 *  canonical_term: string,
 *  aliases: string[],
 *  primary_category: string,
 *  momentum_score: number,
 *  buyer_intent_score: number,
 *  range_depth_score: number,
 *  risk_score: number,
 *  top_evidence_phrases: string[],
 *  product_hints: string[],
 *  seasonality_hints: string[]
 * }>}
 */
function buildClusteringPayload(scoredTerms, canonicalTerms, evidenceRows) {
  const scored = Array.isArray(scoredTerms) ? scoredTerms : [];
  const canonical = Array.isArray(canonicalTerms) ? canonicalTerms : [];
  const evidence = Array.isArray(evidenceRows) ? evidenceRows : [];

  const canonicalById = new Map();
  for (const row of canonical) {
    const id = str(row.canonical_id);
    if (!id) continue;
    canonicalById.set(id, row);
  }

  const evidenceByCanonical = new Map();
  for (const row of evidence) {
    const id = str(row.canonical_id);
    if (!id) continue;
    if (!evidenceByCanonical.has(id)) evidenceByCanonical.set(id, []);
    evidenceByCanonical.get(id).push(row);
  }

  const out = [];

  for (const s of scored) {
    const canonicalId = str(s.canonical_id);
    if (!canonicalId) continue;

    const riskScore = num(s.risk_score);
    if (riskScore > 70) continue;

    const c = canonicalById.get(canonicalId) || {};
    const canonicalTerm = str(c.canonical_term);
    if (canonicalTerm.length < 2) continue;

    const aliases = splitPipe(c.aliases).slice(0, 6);
    const evRows = evidenceByCanonical.get(canonicalId) || [];

    const topEvidencePhrases = evRows
      .filter((e) => str(e.source).toLowerCase() === "etsy_autocomplete")
      .sort((a, b) => num(b.evidence_strength) - num(a.evidence_strength))
      .map((e) => str(e.phrase))
      .filter(Boolean)
      .slice(0, 5);

    const productHints = deriveProductHints(canonicalTerm, aliases);
    const seasonalityHints = deriveSeasonalityHints(canonicalTerm, aliases, topEvidencePhrases);

    out.push({
      canonical_id: canonicalId,
      canonical_term: canonicalTerm,
      aliases: aliases,
      primary_category: str(c.primary_category),
      momentum_score: num(s.momentum_score),
      buyer_intent_score: num(s.buyer_intent_score),
      range_depth_score: num(s.range_depth_score),
      risk_score: riskScore,
      top_evidence_phrases: topEvidencePhrases,
      product_hints: productHints,
      seasonality_hints: seasonalityHints,
      __total_score: num(s.total_score),
    });
  }

  out.sort((a, b) => b.__total_score - a.__total_score);

  if (out.length > 80) {
    // eslint-disable-next-line no-console
    console.warn(`buildClusteringPayload: capped payload at 80; skipped ${out.length - 80} terms`);
  }

  return out.slice(0, 80).map((row) => {
    const clean = { ...row };
    delete clean.__total_score;
    return clean;
  });
}

/**
 * Example runner with synthetic rows.
 */
function runExample() {
  const scoredTerms = [
    { canonical_id: "c1", total_score: 91, momentum_score: 9, buyer_intent_score: 8, range_depth_score: 7, risk_score: 20 },
    { canonical_id: "c2", total_score: 83, momentum_score: 8, buyer_intent_score: 7, range_depth_score: 7, risk_score: 55 },
    { canonical_id: "c3", total_score: 72, momentum_score: 7, buyer_intent_score: 7, range_depth_score: 6, risk_score: 80 }, // excluded risk
    { canonical_id: "c4", total_score: 68, momentum_score: 7, buyer_intent_score: 6, range_depth_score: 6, risk_score: 30 },
    { canonical_id: "c5", total_score: 60, momentum_score: 6, buyer_intent_score: 6, range_depth_score: 5, risk_score: 10 },
  ];

  const canonicalTerms = [
    { canonical_id: "c1", canonical_term: "teacher mug gift", aliases: "teacher coffee mug|teacher gift idea", primary_category: "gifts" },
    { canonical_id: "c2", canonical_term: "halloween hoodie", aliases: "spooky sweatshirt|fall hoodie", primary_category: "seasonal" },
    { canonical_id: "c3", canonical_term: "brandname fan", aliases: "brandname shirt", primary_category: "fandom" },
    { canonical_id: "c4", canonical_term: "summer tote bag", aliases: "beach tote|holiday bag", primary_category: "travel" },
    { canonical_id: "c5", canonical_term: "minimalist quote", aliases: "", primary_category: "quotes" },
  ];

  const evidenceRows = [
    { canonical_id: "c1", source: "etsy_autocomplete", phrase: "teacher mug", evidence_strength: 8 },
    { canonical_id: "c1", source: "etsy_autocomplete", phrase: "teacher gift", evidence_strength: 9 },
    { canonical_id: "c2", source: "etsy_autocomplete", phrase: "halloween hoodie", evidence_strength: 8 },
    { canonical_id: "c4", source: "etsy_autocomplete", phrase: "summer tote bag", evidence_strength: 7 },
    { canonical_id: "c5", source: "amazon_movers", phrase: "minimalist decor", evidence_strength: 5 },
  ];

  const payload = buildClusteringPayload(scoredTerms, canonicalTerms, evidenceRows);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

function deriveProductHints(canonicalTerm, aliases) {
  const corpus = [str(canonicalTerm)].concat(aliases.map(str)).join(" ").toLowerCase();
  const hints = [];
  for (const rule of PRODUCT_HINT_RULES) {
    if (rule.match.test(corpus)) hints.push(rule.hint);
  }
  const uniqueHints = uniq(hints);
  return uniqueHints.length ? uniqueHints : ["shirt", "mug", "sticker"];
}

function deriveSeasonalityHints(canonicalTerm, aliases, topEvidencePhrases) {
  const corpus = [str(canonicalTerm)]
    .concat(aliases.map(str))
    .concat((Array.isArray(topEvidencePhrases) ? topEvidencePhrases : []).map(str))
    .join(" ")
    .toLowerCase();

  const hints = [];
  for (const rule of SEASONALITY_HINT_RULES) {
    if (rule.match.test(corpus)) hints.push(rule.hint);
  }
  const uniqueHints = uniq(hints);
  return uniqueHints.length ? uniqueHints : ["evergreen"];
}

function splitPipe(v) {
  if (v == null || String(v).trim() === "") return [];
  return String(v)
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function uniq(arr) {
  return [...new Set(arr)];
}

module.exports = { buildClusteringPayload };

if (require.main === module) {
  runExample();
}
