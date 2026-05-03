/**
 * Post-LLM cluster merge/split refinement.
 * Runs after validation and before final writes.
 */

/**
 * Apply merge rules across all cluster pairs.
 *
 * @param {Array<Object<string, any>>} clusters
 * @param {Record<string, Object<string, any>>|Object<string, any>} memberPayloads canonical_id -> payload map
 * @returns {{ merged_clusters: Array<Object<string, any>>, absorbed_cluster_ids: string[], history_rows: Array<Object<string, any>> }}
 */
function applyMergeRules(clusters, memberPayloads) {
  const list = cloneArray(clusters);
  const payloadMap = asPayloadMap(memberPayloads);
  const absorbed = new Set();
  const historyRows = [];
  const consumed = new Set();

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || consumed.has(str(a.cluster_id))) continue;

    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (!b || consumed.has(str(b.cluster_id))) continue;

      const canMerge = evaluateMergeCandidacy(a, b, payloadMap);
      if (!canMerge.ok) continue;

      const aScore = num(a.cluster_score);
      const bScore = num(b.cluster_score);
      const primary = aScore >= bScore ? a : b;
      const secondary = primary === a ? b : a;
      const primaryId = str(primary.cluster_id);
      const secondaryId = str(secondary.cluster_id);

      const primaryMembers = toMembers(primary);
      const secondaryMembers = toMembers(secondary).map((m) => ({
        ...m,
        member_role: "secondary",
      }));

      const mergedMembers = dedupeMembers(primaryMembers.concat(secondaryMembers));
      const merged = {
        ...primary,
        members: mergedMembers,
        canonical_ids: mergedMembers.map((m) => str(m.canonical_id)).filter(Boolean),
        term_count: mergedMembers.length,
        theme_name: `${str(primary.theme_name)} (merged: ${str(secondary.theme_name)})`,
      };

      // Replace primary in list and mark secondary as consumed/absorbed.
      list[i] = primary === a ? merged : a;
      list[j] = primary === b ? merged : b;

      consumed.add(secondaryId);
      absorbed.add(secondaryId);

      historyRows.push({
        history_id: `hist_${primaryId}_${secondaryId}_merged_${Date.now()}`,
        cluster_id: primaryId,
        run_date: isoDay(),
        change_type: "merged",
        old_value: `${primaryId}|${secondaryId}`,
        new_value: primaryId,
        notes: `Merged ${secondaryId} into ${primaryId} (overlap ${round1(canMerge.overlap_pct)}%)`,
      });

      historyRows.push({
        history_id: `hist_${secondaryId}_${primaryId}_absorbed_${Date.now()}`,
        cluster_id: secondaryId,
        run_date: isoDay(),
        change_type: "merged",
        old_value: secondaryId,
        new_value: `merged_into_${primaryId}`,
        notes: `Absorbed into ${primaryId}`,
      });
    }
  }

  const mergedClusters = list
    .filter((c) => c && !absorbed.has(str(c.cluster_id)))
    .map((c) => normalizeClusterMembers(c));

  return {
    merged_clusters: mergedClusters,
    absorbed_cluster_ids: [...absorbed],
    history_rows: historyRows,
  };
}

/**
 * Apply split rules to one cluster.
 *
 * @param {Object<string, any>} cluster
 * @param {Record<string, Object<string, any>>|Object<string, any>} memberPayloads canonical_id -> payload map
 * @returns {{ result_clusters: Array<Object<string, any>>, was_split: boolean, history_rows: Array<Object<string, any>> }}
 */
function applySplitRules(cluster, memberPayloads) {
  const c = normalizeClusterMembers(cluster || {});
  const payloadMap = asPayloadMap(memberPayloads);
  const members = toMembers(c);
  const historyRows = [];
  const baseId = str(c.cluster_id) || `clu_${Date.now()}`;

  if (!members.length) {
    return { result_clusters: [c], was_split: false, history_rows: [] };
  }

  // Condition A: gifts vs humour split.
  const giftMembers = members.filter((m) => hasAny(str(m.reason_included), ["gift"]));
  const humorMembers = members.filter((m) => hasAny(str(m.reason_included), ["humour", "humor", "funny"]));
  const giftPct = (giftMembers.length / members.length) * 100;
  const humorPct = (humorMembers.length / members.length) * 100;
  const conditionA = num(c.term_count) >= 8 && giftPct > 40 && humorPct > 40;

  // Condition B: gifting vs self-expression language split.
  const productFit = toArray(c.product_fit).map((x) => str(x).toLowerCase());
  const hasSweat = productFit.includes("sweatshirt");
  const hasSticker = productFit.includes("sticker");
  const withSignals = members.map((m) => ({
    member: m,
    payload: payloadMap[str(m.canonical_id)] || {},
  }));
  const giftLang = withSignals.filter(({ payload }) =>
    hasAny(joinPhrases(payload), ["gift", "birthday", "mother", "father", "wedding", "valentine"]),
  );
  const selfExprLang = withSignals.filter(({ payload }) =>
    hasAny(joinPhrases(payload), ["my", "i am", "proud", "identity", "vibes", "era", "introvert", "extrovert"]),
  );
  const conditionB = hasSweat && hasSticker &&
    giftLang.length > 0 && selfExprLang.length > 0 &&
    (giftLang.length / members.length) > 0.3 &&
    (selfExprLang.length / members.length) > 0.3;

  // Condition C: two clearly different primary categories.
  const categories = new Set(
    withSignals
      .map(({ payload }) => str(payload.primary_category).toLowerCase())
      .filter(Boolean),
  );
  const conditionC = num(c.term_count) >= 10 && categories.size >= 2;

  if (!(conditionA || conditionB || conditionC)) {
    return { result_clusters: [c], was_split: false, history_rows: [] };
  }

  let groupA = [];
  let groupB = [];
  let labelA = "A";
  let labelB = "B";

  if (conditionA) {
    labelA = `${str(c.theme_name)} gifts`;
    labelB = `${str(c.theme_name)} humour`;
    for (const m of members) {
      const txt = str(m.reason_included);
      if (hasAny(txt, ["gift"])) groupA.push(m);
      else if (hasAny(txt, ["humour", "humor", "funny"])) groupB.push(m);
    }
  } else if (conditionB) {
    labelA = `${str(c.theme_name)} gifting`;
    labelB = `${str(c.theme_name)} self-expression`;
    for (const { member, payload } of withSignals) {
      const joined = joinPhrases(payload);
      const isGift = hasAny(joined, ["gift", "birthday", "mother", "father", "wedding", "valentine"]);
      const isSelf = hasAny(joined, ["my", "i am", "proud", "identity", "vibes", "era", "introvert", "extrovert"]);
      if (isGift && !isSelf) groupA.push(member);
      else if (isSelf && !isGift) groupB.push(member);
    }
  } else {
    // Condition C split by top two categories.
    const buckets = {};
    for (const { member, payload } of withSignals) {
      const cat = str(payload.primary_category).toLowerCase() || "unknown";
      if (!buckets[cat]) buckets[cat] = [];
      buckets[cat].push(member);
    }
    const sorted = Object.entries(buckets).sort((a, b) => b[1].length - a[1].length);
    const catA = sorted[0] ? sorted[0][0] : "group_a";
    const catB = sorted[1] ? sorted[1][0] : "group_b";
    labelA = `${str(c.theme_name)} ${catA}`;
    labelB = `${str(c.theme_name)} ${catB}`;
    groupA = (buckets[catA] || []).slice();
    groupB = (buckets[catB] || []).slice();
  }

  // Assign ungrouped members to larger split as experimental.
  const assigned = new Set(groupA.concat(groupB).map((m) => str(m.canonical_id)));
  const leftovers = members.filter((m) => !assigned.has(str(m.canonical_id)));
  if (groupA.length >= groupB.length) {
    groupA = groupA.concat(leftovers.map((m) => ({ ...m, member_role: "experimental" })));
  } else {
    groupB = groupB.concat(leftovers.map((m) => ({ ...m, member_role: "experimental" })));
  }

  // Ensure non-empty groups.
  if (!groupA.length || !groupB.length) {
    return { result_clusters: [c], was_split: false, history_rows: [] };
  }

  const aId = `${baseId}_a`;
  const bId = `${baseId}_b`;

  const cA = {
    ...c,
    cluster_id: aId,
    theme_name: labelA,
    members: dedupeMembers(groupA),
    canonical_ids: dedupeMembers(groupA).map((m) => str(m.canonical_id)).filter(Boolean),
    term_count: dedupeMembers(groupA).length,
  };
  const cB = {
    ...c,
    cluster_id: bId,
    theme_name: labelB,
    members: dedupeMembers(groupB),
    canonical_ids: dedupeMembers(groupB).map((m) => str(m.canonical_id)).filter(Boolean),
    term_count: dedupeMembers(groupB).length,
  };

  historyRows.push({
    history_id: `hist_${baseId}_split_${Date.now()}`,
    cluster_id: baseId,
    run_date: isoDay(),
    change_type: "split",
    old_value: baseId,
    new_value: `${aId}|${bId}`,
    notes: `Split cluster into ${aId} and ${bId}`,
  });

  return {
    result_clusters: [normalizeClusterMembers(cA), normalizeClusterMembers(cB)],
    was_split: true,
    history_rows: historyRows,
  };
}

/**
 * Run split first, then merge.
 *
 * @param {Array<Object<string, any>>} clusters
 * @param {Record<string, Object<string, any>>|Object<string, any>} memberPayloads canonical_id -> payload map
 * @returns {{ final_clusters: Array<Object<string, any>>, absorbed_cluster_ids: string[], history_rows: Array<Object<string, any>>, missing_canonical_ids: string[] }}
 */
function runMergeSplitPipeline(clusters, memberPayloads) {
  const input = Array.isArray(clusters) ? clusters : [];
  const payloadMap = asPayloadMap(memberPayloads);

  const beforeIds = collectCanonicalIds(input);

  const splitOut = [];
  const history = [];
  for (const c of input) {
    const splitRes = applySplitRules(c, payloadMap);
    splitOut.push(...splitRes.result_clusters);
    history.push(...splitRes.history_rows);
  }

  const mergeRes = applyMergeRules(splitOut, payloadMap);
  history.push(...mergeRes.history_rows);

  const afterIds = collectCanonicalIds(mergeRes.merged_clusters);
  const missing = [...beforeIds].filter((id) => !afterIds.has(id));

  return {
    final_clusters: mergeRes.merged_clusters,
    absorbed_cluster_ids: mergeRes.absorbed_cluster_ids,
    history_rows: history,
    missing_canonical_ids: missing,
  };
}

function evaluateMergeCandidacy(a, b, payloadMap) {
  const phrasesA = gatherClusterPhrases(a, payloadMap);
  const phrasesB = gatherClusterPhrases(b, payloadMap);
  const union = new Set([...phrasesA, ...phrasesB]);
  const shared = [...phrasesA].filter((p) => phrasesB.has(p)).length;
  const overlapPct = union.size ? (shared / union.size) * 100 : 0;

  const fitA = new Set(toArray(a.product_fit).map((x) => str(x).toLowerCase()).filter(Boolean));
  const fitB = new Set(toArray(b.product_fit).map((x) => str(x).toLowerCase()).filter(Boolean));
  const productOverlap = [...fitA].filter((p) => fitB.has(p));

  const audA = collectAudienceValues(a);
  const audB = collectAudienceValues(b);
  const audienceMatch = [...audA].some((x) => audB.has(x));

  const seasonA = str(a.seasonality).toLowerCase();
  const seasonB = str(b.seasonality).toLowerCase();
  const seasonMatch = (seasonA && seasonB && seasonA === seasonB) ||
    (seasonA === "evergreen" && seasonB === "evergreen");

  const riskA = str(a.risk_level).toLowerCase();
  const riskB = str(b.risk_level).toLowerCase();

  const combinedTermCount = num(a.term_count) + num(b.term_count);

  const ok =
    overlapPct > 60 &&
    productOverlap.length >= 2 &&
    audienceMatch === true &&
    seasonMatch === true &&
    riskA !== "high" &&
    riskB !== "high" &&
    combinedTermCount <= 15;

  return {
    ok,
    overlap_pct: overlapPct,
    product_overlap: productOverlap,
    audience_match: audienceMatch,
    season_match: seasonMatch,
    combined_term_count: combinedTermCount,
  };
}

function gatherClusterPhrases(cluster, payloadMap) {
  const set = new Set();
  for (const m of toMembers(cluster)) {
    const payload = payloadMap[str(m.canonical_id)];
    for (const p of toArray(payload?.top_evidence_phrases)) {
      const v = str(p).toLowerCase();
      if (v) set.add(v);
    }
  }
  return set;
}

function collectAudienceValues(cluster) {
  const out = new Set();
  const root = str(cluster?.audience).toLowerCase();
  if (root) out.add(root);
  for (const m of toMembers(cluster)) {
    const a = str(m.audience).toLowerCase();
    if (a) out.add(a);
  }
  return out;
}

function normalizeClusterMembers(cluster) {
  const c = { ...(cluster || {}) };
  const members = dedupeMembers(toMembers(c));
  c.members = members;
  if (!Array.isArray(c.canonical_ids) || !c.canonical_ids.length) {
    c.canonical_ids = members.map((m) => str(m.canonical_id)).filter(Boolean);
  }
  c.term_count = Math.max(num(c.term_count), c.canonical_ids.length, members.length);
  return c;
}

function toMembers(cluster) {
  const members = Array.isArray(cluster?.members) ? cluster.members : [];
  return members
    .map((m) => ({
      ...m,
      canonical_id: str(m?.canonical_id),
      member_role: str(m?.member_role) || "primary",
      reason_included: str(m?.reason_included),
    }))
    .filter((m) => m.canonical_id);
}

function dedupeMembers(members) {
  const map = new Map();
  for (const m of members) {
    const id = str(m.canonical_id);
    if (!id) continue;
    if (!map.has(id)) map.set(id, m);
  }
  return [...map.values()];
}

function collectCanonicalIds(clusters) {
  const set = new Set();
  for (const c of Array.isArray(clusters) ? clusters : []) {
    for (const m of toMembers(c)) set.add(str(m.canonical_id));
    for (const id of toArray(c?.canonical_ids)) {
      const v = str(id);
      if (v) set.add(v);
    }
  }
  return set;
}

function hasAny(text, words) {
  const t = str(text).toLowerCase();
  for (const w of words) {
    if (t.includes(String(w).toLowerCase())) return true;
  }
  return false;
}

function joinPhrases(payload) {
  return toArray(payload?.top_evidence_phrases).map(str).join(" ").toLowerCase();
}

function asPayloadMap(memberPayloads) {
  if (!memberPayloads || typeof memberPayloads !== "object") return {};
  if (!Array.isArray(memberPayloads)) return memberPayloads;
  const map = {};
  for (const p of memberPayloads) {
    const id = str(p?.canonical_id);
    if (id) map[id] = p;
  }
  return map;
}

function cloneArray(arr) {
  return (Array.isArray(arr) ? arr : []).map((x) => JSON.parse(JSON.stringify(x)));
}

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function isoDay() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Demonstrates one split and one merge.
 */
function runExample() {
  const payloadMap = {
    c1: { canonical_id: "c1", primary_category: "teacher", top_evidence_phrases: ["teacher gift", "teacher mug"] },
    c2: { canonical_id: "c2", primary_category: "teacher", top_evidence_phrases: ["teacher gift", "teacher shirt"] },
    c3: { canonical_id: "c3", primary_category: "teacher", top_evidence_phrases: ["teacher mug", "teacher gift"] },
    c4: { canonical_id: "c4", primary_category: "teacher", top_evidence_phrases: ["teacher gift", "teacher mug"] },
    c5: { canonical_id: "c5", primary_category: "pets", top_evidence_phrases: ["funny dog gift", "dog mug"] },
    c6: { canonical_id: "c6", primary_category: "pets", top_evidence_phrases: ["funny dog shirt", "dog gift"] },
    c7: { canonical_id: "c7", primary_category: "pets", top_evidence_phrases: ["cat gift", "cat mug"] },
    c8: { canonical_id: "c8", primary_category: "pets", top_evidence_phrases: ["dog funny shirt", "dog gift"] },
  };

  const clusters = [
    {
      cluster_id: "clu_teacher_a",
      theme_name: "Teacher Gifts",
      seasonality: "evergreen",
      audience: "teachers",
      risk_level: "low",
      product_fit: ["shirt", "mug", "sticker"],
      cluster_score: 82,
      term_count: 2,
      members: [
        { canonical_id: "c1", audience: "teachers", occasion_type: "evergreen", fit_score: 80, reason_included: "gift intent" },
        { canonical_id: "c2", audience: "teachers", occasion_type: "evergreen", fit_score: 78, reason_included: "gift demand" },
      ],
    },
    {
      cluster_id: "clu_teacher_b",
      theme_name: "Teacher Appreciation",
      seasonality: "evergreen",
      audience: "teachers",
      risk_level: "low",
      product_fit: ["shirt", "mug", "gift_format"],
      cluster_score: 79,
      term_count: 2,
      members: [
        { canonical_id: "c3", audience: "teachers", occasion_type: "evergreen", fit_score: 76, reason_included: "gift phrase overlap" },
        { canonical_id: "c4", audience: "teachers", occasion_type: "evergreen", fit_score: 74, reason_included: "gift phrase overlap" },
      ],
    },
    {
      cluster_id: "clu_funny_pet",
      theme_name: "Funny Pet Cluster",
      seasonality: "evergreen",
      occasion_type: "identity-based",
      audience: "pet owners",
      risk_level: "low",
      product_fit: ["sweatshirt", "sticker", "shirt"],
      style_fit: ["typography", "line-art"],
      cluster_score: 65,
      term_count: 8,
      members: [
        { canonical_id: "c5", audience: "pet owners", occasion_type: "evergreen", fit_score: 80, reason_included: "gift phrase demand" },
        { canonical_id: "c6", audience: "pet owners", occasion_type: "evergreen", fit_score: 79, reason_included: "funny phrase demand" },
        { canonical_id: "c7", audience: "pet owners", occasion_type: "evergreen", fit_score: 72, reason_included: "gift phrase demand" },
        { canonical_id: "c8", audience: "pet owners", occasion_type: "evergreen", fit_score: 74, reason_included: "funny phrase demand" },
      ],
      flags: [],
    },
  ];

  const res = runMergeSplitPipeline(clusters, payloadMap);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
}

module.exports = { applyMergeRules, applySplitRules, runMergeSplitPipeline };

if (require.main === module) {
  runExample();
}
