import test from "node:test";
import assert from "node:assert/strict";
import { partitionDeterministic, stableHashKey } from "../n8n/lib/clusterer.mjs";

test("stableHashKey is deterministic", () => {
  const a = stableHashKey(["norm_a", "norm_b"]);
  const b = stableHashKey(["norm_a", "norm_b"]);
  assert.equal(a, b);
});

test("partitionDeterministic chunks by maxPerCluster", () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({
    canonical_id: `norm_${i}`,
    niche_keyword: "x",
    tier: "A",
  }));
  const parts = partitionDeterministic(rows, { maxPerCluster: 20 });
  assert.equal(parts.length, 3);
  assert.equal(parts[0].canonical_ids.length, 20);
});
