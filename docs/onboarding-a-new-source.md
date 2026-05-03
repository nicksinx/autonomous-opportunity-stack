# Onboarding a new signal source

1. **Add `sources_config` row** — set `source_name`, `source_type` (`marketplace`, `search`, `social`, `reviews`, `csv`, `internal`), `enabled`, and scheduling hints (`pull_frequency`).
2. **Optional mapping** — for CSV or fixed-schema feeds, add `db/contracts/source-mappings/<source>.json` describing column → canonical contract fields.
3. **Ingest** — raw rows land in `raw_signals` with `canonical_id` resolved to `normalized_terms` where possible; `wf_normalize_terms` updates lineage.
4. **`canonical_signals`** — `wf_normalize_terms` / enrich workflows upsert contract rows; validate with `validateCanonicalSignal` in `db/contract_validator.mjs`.
5. **Scoring** — after enrichment, opportunities flow through `wf_score_and_cluster`; tune `score_weights` and record history via `score_weight_history` when calibrating.

See `db/contracts/canonical_signal_v1.json` for the intake contract shape.
