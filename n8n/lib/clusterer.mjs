/**
 * Deterministic clustering helpers — used by services/cluster-engine and mirrored into n8n Code nodes.
 */

/** Deterministic UUID-style id from a seed string (FNV-1a inspired mix). */
export function uuidFromSeed(seed) {
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

export function stableHashKey(sortedCanonIds) {
  let h = 5381;
  const s = sortedCanonIds.join("|");
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) + h + s.charCodeAt(i);
    h |= 0;
  }
  return `h_${Math.abs(h).toString(16)}`;
}

/**
 * @param {Array<{ canonical_id: string, niche_keyword?: string, tier?: string }>} rows
 * @param {{ maxPerCluster?: number, clusterVersion?: string }} [opts]
 */
export function partitionDeterministic(rows, opts = {}) {
  const maxPerCluster = opts.maxPerCluster ?? 20;
  const clusterVersion = opts.clusterVersion ?? "deterministic-v1";
  const sorted = [...rows].sort((a, b) =>
    String(a.canonical_id).localeCompare(String(b.canonical_id)),
  );
  const clusters = [];
  for (let i = 0; i < sorted.length; i += maxPerCluster) {
    const slice = sorted.slice(i, i + maxPerCluster);
    const ids = slice.map((r) => String(r.canonical_id)).filter(Boolean).sort();
    const cluster_key = stableHashKey(ids);
    const primary_topic = String(slice[0]?.niche_keyword || "mixed_cluster");
    clusters.push({
      cluster_key,
      cluster_version: clusterVersion,
      primary_topic,
      niche: "",
      sub_niche: null,
      source_count: 1,
      signal_count: ids.length,
      canonical_ids: ids,
      tiers: slice.map((r) => r.tier || ""),
    });
  }
  return clusters;
}
