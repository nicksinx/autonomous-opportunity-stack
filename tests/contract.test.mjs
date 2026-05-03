import test from "node:test";
import assert from "node:assert/strict";
import { validateCanonicalSignal } from "../db/contract_validator.mjs";

test("validateCanonicalSignal accepts minimal valid row", () => {
  const r = validateCanonicalSignal({
    signal_id: "cs_x_2026-05-01",
    contract_version: "2026-05-01",
    source_type: "search",
    source_name: "google_trends",
    lineage: { normalized_term_id: "norm_foo" },
    dedupe_key: "foo",
    status: "ready",
  });
  assert.equal(r.ok, true);
});
