/**
 * Shared intake derivations (identity / occasion / risk wordlists).
 * Imported by workflow builders at build time for inlining into Code nodes.
 */

export const IDENTITY_WORDS = [
  "mom",
  "dad",
  "teacher",
  "nurse",
  "dog",
  "cat",
  "wife",
  "husband",
  "grandma",
  "grandpa",
  "auntie",
  "uncle",
  "sister",
  "brother",
  "friend",
  "girl",
  "guy",
  "queen",
  "king",
  "boss",
  "lover",
  "fan",
  "nerd",
  "geek",
  "pro",
  "hero",
  "rebel",
  "doctor",
  "lawyer",
  "chef",
  "baker",
  "runner",
  "hiker",
  "gamer",
  "reader",
  "gardener",
  "crafter",
];

export const OCCASION_WORDS = [
  "birthday",
  "christmas",
  "halloween",
  "valentine",
  "mother",
  "father",
  "wedding",
  "anniversary",
  "graduation",
  "baby",
  "shower",
  "new year",
  "easter",
  "thanksgiving",
  "holiday",
  "party",
];

export const BRAND_CELEB_RISK_WORDS = [
  "disney",
  "marvel",
  "nfl",
  "nba",
  "mlb",
  "nhl",
  "taylor",
  "swift",
  "beyonce",
  "kardashian",
  "trump",
  "biden",
  "harry",
  "styles",
  "billie",
  "eilish",
  "pokemon",
  "minecraft",
  "roblox",
  "fortnite",
  "barbie",
  "nike",
  "adidas",
  "supreme",
  "gucci",
  "nasa",
  "ncaa",
];

export const NEWS_EVENT_RISK_WORDS = [
  "election",
  "war",
  "shooting",
  "flood",
  "earthquake",
  "covid",
  "pandemic",
  "terrorist",
  "riot",
  "protest",
  "hostage",
];

export function tokenizeHint(h) {
  return String(h || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function firstMatchTokens(termLower, wordList) {
  const tk = new Set(tokenizeHint(termLower));
  for (const t of wordList) {
    if (tk.has(String(t).toLowerCase())) return t;
  }
  return "";
}

/** @returns {{ audience_tags: string[], primary_audience?: string }} */
export function deriveAudienceHint(canonicalTermLower) {
  const id = firstMatchTokens(canonicalTermLower, IDENTITY_WORDS);
  const tags = [];
  if (id) tags.push(id);
  return { audience_tags: tags, ...(id ? { primary_audience: id } : {}) };
}

/** @returns {{ flags: string[], has_occasion: boolean }} */
export function deriveSeasonalityHint(canonicalTermLower) {
  const occ = firstMatchTokens(canonicalTermLower, OCCASION_WORDS);
  return {
    flags: occ ? [occ] : [],
    has_occasion: Boolean(occ),
    occasion_term: occ || null,
  };
}

/** @returns {{ level: string, matched_terms: string[], has_high_risk: boolean }} */
export function deriveRiskFlags(canonicalTermLower) {
  const tk = new Set(tokenizeHint(canonicalTermLower));
  const flags = [];
  for (const t of BRAND_CELEB_RISK_WORDS) {
    if (tk.has(String(t).toLowerCase())) flags.push(t);
  }
  if (flags.length) {
    return { level: "high", matched_terms: [...new Set(flags)], has_high_risk: true };
  }
  const news = [];
  for (const t of NEWS_EVENT_RISK_WORDS) {
    if (tk.has(String(t).toLowerCase())) news.push(t);
  }
  if (news.length) {
    return { level: "moderate", matched_terms: [...new Set(news)], has_high_risk: false };
  }
  return { level: "low", matched_terms: [], has_high_risk: false };
}
