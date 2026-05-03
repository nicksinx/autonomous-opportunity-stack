# Legacy reference modules (Apps Script era)

These CommonJS files were root-level `module.exports` artifacts from the pre-Postgres pipeline. They are not imported by the current n8n/Postgres runtime; scoring and intake logic lives in n8n Code nodes and in `n8n/lib/` ESM modules.

Kept for historical reference and porting diffs only.

## Status — `dual_write_mirror_log` retirement

- Workflow writes to `dual_write_mirror_log` were stripped in Phase 1.
- Tooling retired in Phase 5 closeout: [`n8n/check-mirror-consistency.mjs`](../../n8n/) deleted; the `n8n:check-mirror` npm script removed; the table dropped from the Phase 1 gate's `REQUIRED_TABLES` and from `db/check-schema-columns.mjs`.
- The table itself was renamed to `dual_write_mirror_log_legacy` and write privileges revoked from `pod_app` in [`db/migrations/0015_retire_dual_write_mirror_log.sql`](../../db/migrations/0015_retire_dual_write_mirror_log.sql); read access stays for forensics.

**Follow-up (gated):** ship `db/migrations/0016_drop_dual_write_mirror_log_legacy.sql` after one full sprint where Gate 6 stays green and `SELECT MAX(created_at) FROM dual_write_mirror_log_legacy` is unchanged.
