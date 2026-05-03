import test from "node:test";
import assert from "node:assert/strict";

/** Mirrors computeConfidence shape from layer2_score_code (spot-check stability). */
function computeConfidence(c) {
  const div = Math.min(1, Number(c.source_count || 0) / 5);
  const completeness = 0.7;
  const freshness = Math.max(
    0,
    1 - Math.min(30, Number(c.days_since_first_seen || 0)) / 30,
  );
  const v = ((div + completeness + freshness) / 3) * 10;
  return Math.max(0, Math.min(10, Math.round(v * 10) / 10));
}

test("confidence grows with source diversity", () => {
  const low = computeConfidence({ source_count: 1, days_since_first_seen: 0 });
  const high = computeConfidence({ source_count: 10, days_since_first_seen: 0 });
  assert.ok(high >= low);
});
