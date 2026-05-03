/**
 * @typedef {Object} CandidateOpportunity
 * @property {string} canonical_id Identity key from normalized terms.
 * @property {string} niche_keyword Canonical niche keyword (canonical_term).
 * @property {string} target_audience First matched identity word, else "general".
 * @property {string} theme Theme derived from primary_category.
 * @property {string} language Language from normalized terms row.
 * @property {number} source_count Distinct raw signal sources.
 * @property {number} etsy_phrase_count Count of marketplace evidence rows sourced from Etsy autocomplete.
 * @property {boolean} amazon_signal Whether any marketplace evidence row comes from amazon_movers.
 * @property {boolean} google_signal Whether any raw signal row comes from google_trends.
 * @property {boolean} pinterest_signal Whether any raw signal row comes from pinterest_trends.
 * @property {boolean} social_signal Whether any raw signal row comes from tiktok_creative.
 * @property {number} alias_count Number of aliases parsed from pipe-delimited aliases field.
 * @property {string} seasonality_flag One of "seasonal", "evergreen", or "unknown".
 * @property {string} seasonality_window Seasonality hint, e.g. "Q4", "year_round", "unknown".
 * @property {string[]} product_formats Inferred product format list.
 * @property {number} phrase_length_words Word count of niche_keyword.
 * @property {boolean} has_identity_word Whether niche_keyword matches identity list.
 * @property {boolean} has_occasion_word Whether niche_keyword matches occasion list.
 * @property {"low"|"moderate"|"high"} compliance_risk Compliance risk level.
 * @property {string[]} risk_flags List of matched risk tokens.
 * @property {string} velocity_hint Highest velocity hint across raw signals.
 * @property {number} days_since_first_seen Integer days since date_first_seen.
 * @property {number} days_since_last_seen Integer days since date_last_seen.
 * @property {number} persistence_windows Distinct date_collected days in raw signals.
 * @property {string[]} top_etsy_phrases First five Etsy evidence phrases.
 * @property {string[]} related_terms First ten related terms extracted from raw signals.
 */

/** @type {string[]} */
const IDENTITY_WORDS = [
  "mom", "dad", "teacher", "nurse", "dog", "cat", "wife", "husband", "grandma",
  "grandpa", "auntie", "uncle", "sister", "brother", "friend", "girl", "guy",
  "queen", "king", "boss", "lover", "fan", "nerd", "geek", "pro", "hero", "rebel",
  "nurse", "doctor", "lawyer", "chef", "baker", "runner", "hiker", "gamer",
  "reader", "gardener", "crafter",
];

/** @type {string[]} */
const OCCASION_WORDS = [
  "birthday", "christmas", "halloween", "valentine", "mother", "father", "wedding",
  "anniversary", "graduation", "baby", "shower", "new year", "easter", "thanksgiving",
  "holiday", "party",
];

/** @type {string[]} */
const BRAND_CELEB_RISK_WORDS = [
  "disney", "marvel", "nfl", "nba", "mlb", "nhl", "taylor", "swift", "beyonce",
  "kardashian", "trump", "biden", "harry", "styles", "billie", "eilish",
  "pokemon", "minecraft", "roblox", "fortnite", "barbie", "nike", "adidas",
  "supreme", "gucci", "nasa", "ncaa",
];

/** @type {string[]} */
const NEWS_EVENT_RISK_WORDS = [
  "election", "war", "shooting", "flood", "earthquake", "covid", "pandemic",
  "terrorist", "riot", "protest", "hostage",
];

/** @type {Record<string, number>} */
const VELOCITY_RANK = { low: 1, medium: 2, high: 3 };

/**
 * Build a scoring-ready opportunity object from normalized term + evidence/signal context.
 *
 * @param {Object<string, any>|null|undefined} canonicalRow One row from normalized_terms.
 * @param {Array<Object<string, any>>|null|undefined} signalRows raw_signals rows for canonical_id.
 * @param {Array<Object<string, any>>|null|undefined} evidenceRows marketplace_evidence rows for canonical_id.
 * @returns {CandidateOpportunity} Structured candidate opportunity payload.
 */
function buildCandidateOpportunity(canonicalRow, signalRows, evidenceRows) {
  const c = canonicalRow || {};
  const signals = Array.isArray(signalRows) ? signalRows : [];
  const evidence = Array.isArray(evidenceRows) ? evidenceRows : [];

  const canonicalId = str(c.canonical_id);
  const nicheKeyword = str(c.canonical_term);
  const primaryCategory = str(c.primary_category) || "unknown";
  const language = str(c.language) || "unknown";

  const keywordLower = nicheKeyword.toLowerCase();
  const targetAudience = firstKeywordMatch(keywordLower, IDENTITY_WORDS) || "general";
  const hasIdentityWord = targetAudience !== "general";
  const hasOccasionWord = hasAnyKeyword(keywordLower, OCCASION_WORDS);
  const phraseLengthWords = wordCount(nicheKeyword);

  const signalSources = new Set(signals.map((r) => str(r.source).toLowerCase()).filter(Boolean));
  const sourceCount = signalSources.size;
  const googleSignal = signalSources.has("google_trends");
  const pinterestSignal = signalSources.has("pinterest_trends");
  const socialSignal = signalSources.has("tiktok_creative");

  const evidenceSources = evidence.map((r) => str(r.source).toLowerCase());
  const etsyRows = evidence.filter((r) => str(r.source).toLowerCase() === "etsy_autocomplete");
  const etsyPhraseCount = etsyRows.length;
  const amazonSignal = evidenceSources.includes("amazon_movers");

  const aliases = splitPipe(str(c.aliases));
  const aliasCount = aliases.length;

  const daysSinceFirstSeen = daysSince(c.date_first_seen);
  const daysSinceLastSeen = daysSince(c.date_last_seen);

  const velocityHint = highestVelocity(signals);
  const persistenceWindows = distinctSignalDays(signals);

  const seasonalityFlag = deriveSeasonalityFlag(
    hasOccasionWord,
    aliasCount,
    daysSinceFirstSeen
  );
  const seasonalityWindow = deriveSeasonalityWindow(
    str(c.seasonality_window),
    hasOccasionWord,
    seasonalityFlag
  );

  const risk = deriveRisk(keywordLower);
  const productFormats = deriveProductFormats(hasOccasionWord, hasIdentityWord, phraseLengthWords);
  const topEtsyPhrases = etsyRows.map((r) => str(r.phrase)).filter(Boolean).slice(0, 5);
  const relatedTerms = gatherRelatedTerms(signals).slice(0, 10);

  return {
    // Identity
    canonical_id: canonicalId,
    niche_keyword: nicheKeyword,
    target_audience: targetAudience,
    theme: primaryCategory,
    language: language,

    // Market context
    source_count: sourceCount,
    etsy_phrase_count: etsyPhraseCount,
    amazon_signal: amazonSignal,
    google_signal: googleSignal,
    pinterest_signal: pinterestSignal,
    social_signal: socialSignal,
    alias_count: aliasCount,

    // Seasonality
    seasonality_flag: seasonalityFlag,
    seasonality_window: seasonalityWindow,

    // Product fit
    product_formats: productFormats,
    phrase_length_words: phraseLengthWords,
    has_identity_word: hasIdentityWord,
    has_occasion_word: hasOccasionWord,

    // Risk
    compliance_risk: risk.level,
    risk_flags: risk.flags,

    // Scores context (raw inputs for scoring engine)
    velocity_hint: velocityHint,
    days_since_first_seen: daysSinceFirstSeen,
    days_since_last_seen: daysSinceLastSeen,
    persistence_windows: persistenceWindows,

    // Raw evidence
    top_etsy_phrases: topEtsyPhrases,
    related_terms: relatedTerms,
  };
}

/**
 * Run a local hardcoded example and print output.
 * Useful as a smoke test.
 */
function runExample() {
  const canonicalRow = {
    canonical_id: "can_pickleball_mom",
    canonical_term: "pickleball mom",
    date_first_seen: "2026-04-01",
    date_last_seen: "2026-04-27",
    aliases: "pickleball mama|pickleball mom life|pickleball mom gift",
    language: "en",
    primary_category: "sports_lifestyle",
  };

  const signalRows = [
    {
      source: "google_trends",
      date_collected: "2026-04-26T09:00:00Z",
      velocity_hint: "medium",
      related_term: "pickleball shirts",
    },
    {
      source: "tiktok_creative",
      date_collected: "2026-04-27T09:00:00Z",
      velocity_hint: "high",
      related_term: "pickleball mom era",
    },
    {
      source: "pinterest_trends",
      date_collected: "2026-04-27T10:00:00Z",
      velocity_hint: "low",
      related_term: "pickleball svg",
    },
  ];

  const evidenceRows = [
    { source: "etsy_autocomplete", phrase: "pickleball mom shirt" },
    { source: "etsy_autocomplete", phrase: "pickleball mom gift" },
    { source: "amazon_movers", phrase: "pickleball accessories" },
  ];

  const out = buildCandidateOpportunity(canonicalRow, signalRows, evidenceRows);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function splitPipe(value) {
  if (!value) return [];
  return value
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function wordCount(text) {
  const parts = str(text).split(/\s+/).filter(Boolean);
  return parts.length;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAnyKeyword(haystackLower, terms) {
  for (const t of terms) {
    const re = new RegExp(`\\b${escapeRegex(t.toLowerCase())}\\b`, "i");
    if (re.test(haystackLower)) return true;
  }
  return false;
}

function firstKeywordMatch(haystackLower, terms) {
  for (const t of terms) {
    const re = new RegExp(`\\b${escapeRegex(t.toLowerCase())}\\b`, "i");
    if (re.test(haystackLower)) return t;
  }
  return "";
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function daysSince(value) {
  const d = parseDate(value);
  if (!d) return 0;
  const now = new Date();
  const ms = now.getTime() - d.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function highestVelocity(rows) {
  let top = "low";
  for (const r of rows) {
    const v = str(r.velocity_hint).toLowerCase();
    if (!VELOCITY_RANK[v]) continue;
    if (VELOCITY_RANK[v] > VELOCITY_RANK[top]) top = v;
  }
  return top;
}

function distinctSignalDays(rows) {
  const days = new Set();
  for (const r of rows) {
    const raw = str(r.date_collected);
    if (!raw) continue;
    const d = parseDate(raw);
    if (!d) continue;
    days.add(d.toISOString().slice(0, 10));
  }
  return days.size;
}

function deriveSeasonalityFlag(hasOccasionWord, aliasCount, daysSinceFirstSeen) {
  if (hasOccasionWord) return "seasonal";
  if (aliasCount >= 3 && daysSinceFirstSeen >= 14) return "evergreen";
  return "unknown";
}

function deriveSeasonalityWindow(existingWindow, hasOccasionWord, seasonalityFlag) {
  if (existingWindow) return existingWindow;
  if (hasOccasionWord) return "Q4";
  if (seasonalityFlag === "evergreen") return "year_round";
  return "unknown";
}

function deriveProductFormats(hasOccasionWord, hasIdentityWord, phraseLengthWords) {
  const out = ["tshirt", "mug", "sticker"];
  if (hasOccasionWord) out.push("tote_bag");
  if (hasIdentityWord) out.push("sweatshirt");
  if (hasOccasionWord && phraseLengthWords <= 5) out.push("greeting_card");
  return out;
}

function deriveRisk(keywordLower) {
  const flags = [];

  for (const t of BRAND_CELEB_RISK_WORDS) {
    const re = new RegExp(`\\b${escapeRegex(t.toLowerCase())}\\b`, "i");
    if (re.test(keywordLower)) flags.push(t);
  }
  if (flags.length) return { level: "high", flags: unique(flags) };

  for (const t of NEWS_EVENT_RISK_WORDS) {
    const re = new RegExp(`\\b${escapeRegex(t.toLowerCase())}\\b`, "i");
    if (re.test(keywordLower)) flags.push(t);
  }
  if (flags.length) return { level: "moderate", flags: unique(flags) };

  return { level: "low", flags: [] };
}

function gatherRelatedTerms(rows) {
  const out = [];
  for (const r of rows) {
    const byRelatedTerm = splitPipe(str(r.related_term));
    const byRelatedTerms = splitPipe(str(r.related_terms));
    const all = byRelatedTerm.concat(byRelatedTerms);
    for (const t of all) {
      if (t) out.push(t);
    }
  }
  return unique(out);
}

function unique(arr) {
  return [...new Set(arr)];
}

module.exports = { buildCandidateOpportunity };

if (require.main === module) {
  runExample();
}
