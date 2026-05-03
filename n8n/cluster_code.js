// Clustering node — inlined into wf_score_and_cluster (do not run standalone).
// Inputs: Tier A/B rows from "14. Filter Tier A and B"; scored_rows from node 5.
// Env: CLUSTER_ENGINE = deterministic | llm (default deterministic). ANTHROPIC_API_KEY for llm.

function uuidFromSeed(seed) {
  let h = 2166136261;
  const x = String(seed);
  for (let i = 0; i < x.length; i++) {
    h ^= x.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hex =
    Math.abs(h).toString(16).padStart(8, "0") +
    Math.abs(h ^ 0x9e3779b9).toString(16).padStart(8, "0");
  const p = (hex + hex).slice(0, 32);
  return `${p.slice(0, 8)}-${p.slice(8, 12)}-5${p.slice(13, 16)}-a${p.slice(17, 20)}-${p.slice(20, 32)}`;
}

function stableHashKey(sortedCanonIds) {
  let h = 5381;
  const s = sortedCanonIds.join("|");
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) + h + s.charCodeAt(i);
    h |= 0;
  }
  return `h_${Math.abs(h).toString(16)}`;
}

function partitionDeterministic(rows, maxPerCluster, clusterVersion) {
  const sorted = [...rows].sort((a, b) =>
    String(a.canonical_id).localeCompare(String(b.canonical_id)),
  );
  const clusters = [];
  for (let i = 0; i < sorted.length; i += maxPerCluster) {
    const slice = sorted.slice(i, i + maxPerCluster);
    const ids = slice.map((r) => String(r.canonical_id)).filter(Boolean).sort();
    clusters.push({
      cluster_key: stableHashKey(ids),
      cluster_version: clusterVersion,
      primary_topic: String(slice[0]?.niche_keyword || "mixed_cluster"),
      canonical_ids: ids,
      slice,
    });
  }
  return clusters;
}

function buildLayer2FromPartitions(partitions, runDate, clusterVersionLabel) {
  const trend_cluster_v2_rows = [];
  const cluster_members_v2_rows = [];
  const candidate_cluster_updates = [];
  const cluster_rows = [];
  let idx = 0;
  for (const p of partitions) {
    idx += 1;
    const idsSorted = p.canonical_ids.slice().sort();
    const cluster_id = uuidFromSeed("tv2|" + p.cluster_key + "|" + clusterVersionLabel);
    trend_cluster_v2_rows.push({
      cluster_id,
      cluster_key: p.cluster_key,
      cluster_version: clusterVersionLabel,
      primary_topic: p.primary_topic,
      niche: "",
      sub_niche: null,
      source_count: 1,
      signal_count: idsSorted.length,
      supporting_signal_ids: idsSorted,
      aggregate_metrics: { tiers: p.slice ? p.slice.map((r) => r.tier) : [] },
      freshness_window: {},
    });
    for (const cid of idsSorted) {
      cluster_members_v2_rows.push({
        member_id: uuidFromSeed("mem|" + cluster_id + "|" + cid),
        cluster_id,
        canonical_id: cid,
        canonical_term: null,
        member_role: "member",
        fit_score: null,
      });
      candidate_cluster_updates.push({ canonical_id: cid, cluster_id });
    }
    const theme_name = p.primary_topic || "Theme " + idx;
    const slug = theme_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    cluster_rows.push({
      cluster_id,
      run_date: runDate,
      theme_name,
      theme_slug: slug,
      parent_theme: "",
      theme_summary: "",
      audience: "trend-led POD shoppers",
      occasion_type: "",
      seasonality: "unknown",
      product_fit: "",
      style_fit: "",
      risk_level: "low",
      cluster_score: 0,
      term_count: idsSorted.length,
      status: "draft",
      review_notes: "medium",
    });
  }
  return {
    cluster_rows,
    trend_cluster_v2_rows,
    cluster_members_v2_rows,
    candidate_cluster_updates,
  };
}

const meta = $("5. Score all candidates (Layer 2)").first().json || {};
const scored_lookup = new Map(
  (Array.isArray(meta.scored_rows) ? meta.scored_rows : []).map((r) => [
    String(r.canonical_id || ""),
    r,
  ]),
);

const tierItems = $input.all().map((i) => i.json || {});
const engine =
  typeof $env !== "undefined" && $env.CLUSTER_ENGINE
    ? String($env.CLUSTER_ENGINE).toLowerCase()
    : "deterministic";

const runDate = new Date().toISOString().slice(0, 10);
let cluster_rows = [];
let trend_cluster_v2_rows = [];
let cluster_members_v2_rows = [];
let candidate_cluster_updates = [];

if (!tierItems.length) {
  return [
    {
      json: {
        cluster_rows,
        trend_cluster_v2_rows,
        cluster_members_v2_rows,
        candidate_cluster_updates,
      },
    },
  ];
}

if (engine === "llm") {
  const rows = tierItems.map((r) => ({
    canonical_id: String(r.canonical_id || ""),
    niche_keyword: String(r.niche_keyword || ""),
    tier: String(r.tier || ""),
    ...r,
  }));
  const apiKey =
    typeof $env !== "undefined" && $env.ANTHROPIC_API_KEY ? String($env.ANTHROPIC_API_KEY) : "";
  let arr = [];
  if (apiKey) {
    try {
      const prompt =
        "Cluster these opportunity rows into 3-8 marketable POD themes and return JSON array with fields theme_name, canonical_ids, cluster_summary, audience, seasonality, priority. Rows: " +
        JSON.stringify(rows.slice(0, 120));
      const body = await this.helpers.httpRequest({
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: {
          model: "claude-sonnet-4-20250514",
          max_tokens: 2048,
          system: "Return JSON only.",
          messages: [{ role: "user", content: prompt }],
        },
        json: true,
      });
      const text = body?.content?.find((x) => x.type === "text")?.text || "[]";
      const start = text.indexOf("["),
        end = text.lastIndexOf("]");
      arr = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : "[]");
    } catch (_e) {
      arr = [];
    }
  }
  if (!Array.isArray(arr)) arr = [];
  const LLM_VER = "llm-claude-sonnet-4-20250514";
  let idx = 0;
  for (const c of arr) {
    idx += 1;
    const theme_name = String(c.theme_name || "Theme " + idx);
    const rawIds = Array.isArray(c.canonical_ids)
      ? c.canonical_ids
      : String(c.canonical_ids || "")
          .split("|")
          .map((s) => s.trim());
    const ids = rawIds.map((id) => String(id).trim()).filter(Boolean);
    const idsSorted = ids.slice().sort();
    const cluster_key = stableHashKey(idsSorted);
    const cluster_id = uuidFromSeed("tv2|" + cluster_key + "|" + LLM_VER);
    trend_cluster_v2_rows.push({
      cluster_id,
      cluster_key,
      cluster_version: LLM_VER,
      primary_topic: theme_name,
      niche: "",
      sub_niche: null,
      source_count: 1,
      signal_count: idsSorted.length,
      supporting_signal_ids: idsSorted,
      aggregate_metrics: { source: "llm" },
      freshness_window: {},
    });
    for (const cid of idsSorted) {
      cluster_members_v2_rows.push({
        member_id: uuidFromSeed("mem|" + cluster_id + "|" + cid),
        cluster_id,
        canonical_id: cid,
        canonical_term: null,
        member_role: "member",
        fit_score: null,
      });
      candidate_cluster_updates.push({ canonical_id: cid, cluster_id });
    }
    const slug = theme_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    cluster_rows.push({
      cluster_id,
      run_date: runDate,
      theme_name,
      theme_slug: slug,
      parent_theme: "",
      theme_summary: String(c.cluster_summary || ""),
      audience: String(c.audience || "trend-led POD shoppers"),
      occasion_type: "",
      seasonality: String(c.seasonality || "unknown"),
      product_fit: "",
      style_fit: "",
      risk_level: "low",
      cluster_score: 0,
      term_count: idsSorted.length,
      status: "draft",
      review_notes: String(c.priority || "medium"),
    });
  }
} else {
  const rows = tierItems
    .map((r) => {
      const canonical_id = String(r.canonical_id || "");
      const scored = scored_lookup.get(canonical_id) || {};
      return {
        canonical_id,
        niche_keyword: String(scored.niche_keyword || r.niche_keyword || ""),
        tier: String(scored.tier || r.tier || ""),
      };
    })
    .filter((r) => r.canonical_id);
  const parts = partitionDeterministic(rows, 20, "deterministic-v1");
  const built = buildLayer2FromPartitions(parts, runDate, "deterministic-v1");
  cluster_rows = built.cluster_rows;
  trend_cluster_v2_rows = built.trend_cluster_v2_rows;
  cluster_members_v2_rows = built.cluster_members_v2_rows;
  candidate_cluster_updates = built.candidate_cluster_updates;
}

return [
  {
    json: {
      cluster_rows,
      trend_cluster_v2_rows,
      cluster_members_v2_rows,
      candidate_cluster_updates,
    },
  },
];
