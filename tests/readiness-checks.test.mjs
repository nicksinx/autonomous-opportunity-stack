import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ALL_CHECKS,
  DECISION_KEYS,
  checksBySection,
  extractDecisionRecords,
  parseDecisionBody,
  parseDecisions,
  makeCtx,
} from "../n8n/lib/readiness-checks.mjs";
import { renderReport, renderHuman } from "../n8n/lib/readiness-report.mjs";

function tempRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "l2-readiness-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  }
  return root;
}

test("ALL_CHECKS has expected sections and unique ids", () => {
  const ids = ALL_CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  assert.ok(checksBySection("must").length >= 5);
  assert.ok(checksBySection("should").length >= 5);
  assert.ok(checksBySection("defer").length >= 5);
  assert.equal(checksBySection("decision").length, DECISION_KEYS.length);
});

test("extractDecisionRecords splits on `## decision:` headings", () => {
  const md = `Intro\n\n## decision: contract_version_policy\nstatus: resolved\nowner: alice\nresolution: stamp 2026-05-01\n\n## decision: identity_strategy\nstatus: pending\n`;
  const blocks = extractDecisionRecords(md);
  assert.equal(blocks.size, 2);
  assert.match(blocks.get("contract_version_policy"), /status: resolved/);
  assert.match(blocks.get("identity_strategy"), /status: pending/);
});

test("parseDecisionBody handles key:value lines and ignores prose", () => {
  const body = `status: resolved\nowner: bob\nresolution: yes\nrandom prose line`;
  const r = parseDecisionBody(body);
  assert.equal(r.status, "resolved");
  assert.equal(r.owner, "bob");
  assert.equal(r.resolution, "yes");
});

test("parseDecisions returns one entry per known decision id (missing -> empty body)", () => {
  const r = parseDecisions("");
  assert.equal(r.size, DECISION_KEYS.length);
  for (const id of DECISION_KEYS) {
    assert.ok(r.has(id), `missing ${id}`);
    assert.equal(r.get(id).status, null);
  }
});

test("makeCtx exposes file helpers anchored at repoRoot", () => {
  const root = tempRepo({ "package.json": "{}" });
  const ctx = makeCtx({ pool: null, repoRoot: root, decisions: new Map(), runTests: false, skipDb: true });
  assert.equal(ctx.exists("package.json"), true);
  assert.equal(ctx.exists("nope.json"), false);
  assert.equal(ctx.read("package.json"), "{}");
  assert.deepEqual(ctx.readJson("package.json"), {});
});

test("intake_writes_canonical check passes when JSON contains UPSERT canonical_signals", async () => {
  const root = tempRepo({ "n8n/wf_normalize_terms.json": "INSERT INTO canonical_signals (signal_id) VALUES ($1)" });
  const ctx = makeCtx({ pool: null, repoRoot: root, decisions: new Map(), runTests: false, skipDb: true });
  const check = ALL_CHECKS.find((c) => c.id === "must.contract.intake_writes_canonical");
  const r = await check.run(ctx);
  assert.equal(r.status, "pass");
});

test("intake_writes_canonical check fails when JSON lacks canonical_signals write", async () => {
  const root = tempRepo({ "n8n/wf_normalize_terms.json": "{}" });
  const ctx = makeCtx({ pool: null, repoRoot: root, decisions: new Map(), runTests: false, skipDb: true });
  const check = ALL_CHECKS.find((c) => c.id === "must.contract.intake_writes_canonical");
  const r = await check.run(ctx);
  assert.equal(r.status, "fail");
});

test("no_mirror_writes flags any wf_*.json that mentions dual_write_mirror_log", async () => {
  const root = tempRepo({
    "n8n/wf_a.json": "clean",
    "n8n/wf_b.json": "INSERT INTO dual_write_mirror_log (...)",
  });
  const ctx = makeCtx({ pool: null, repoRoot: root, decisions: new Map(), runTests: false, skipDb: true });
  const check = ALL_CHECKS.find((c) => c.id === "must.workflow.no_mirror_writes");
  const r = await check.run(ctx);
  assert.equal(r.status, "fail");
  assert.match(r.evidence, /wf_b\.json/);
});

test("no_handedits_helper passes when the helper is absent", async () => {
  const root = tempRepo({ ".keep": "" });
  const ctx = makeCtx({ pool: null, repoRoot: root, decisions: new Map(), runTests: false, skipDb: true });
  const check = ALL_CHECKS.find((c) => c.id === "should.workflow.no_handedits_helper");
  const r = await check.run(ctx);
  assert.equal(r.status, "pass");
});

test("vestigial_js_archived passes when files live under archive/legacy-modules/", async () => {
  const modules = [
    "scoringEngine.js", "opportunityBuilder.js", "clusterScoringEngine.js", "clusterMergeSplit.js",
    "clusterHistoryTracker.js", "clusteringPayloadBuilder.js", "weightCalibrator.js", "scoringConfigLoader.js",
    "normalizationAuditor.js", "observabilityEnvelope.js", "sourceContractValidator.js",
  ];
  const files = Object.fromEntries(modules.map((m) => [`archive/legacy-modules/${m}`, "// archived"]));
  const root = tempRepo(files);
  const ctx = makeCtx({ pool: null, repoRoot: root, decisions: new Map(), runTests: false, skipDb: true });
  const check = ALL_CHECKS.find((c) => c.id === "should.workflow.vestigial_js_archived");
  const r = await check.run(ctx);
  assert.equal(r.status, "pass");
});

test("decision check passes when status=resolved with owner+resolution", async () => {
  const md = `## decision: contract_version_policy\nstatus: resolved\nowner: alice\nresolution: stamp 2026-05-01`;
  const decisions = parseDecisions(md);
  const check = ALL_CHECKS.find((c) => c.id === "decision.contract_version_policy");
  const r = await check.run({ decisions });
  assert.equal(r.status, "pass");
});

test("decision check fails when block missing", async () => {
  const decisions = parseDecisions("");
  const check = ALL_CHECKS.find((c) => c.id === "decision.contract_version_policy");
  // Empty parsed decisions still has the key (with nulls) — gate treats null status as fail.
  const r = await check.run({ decisions });
  assert.equal(r.status, "fail");
});

function fakePool({ tables = new Map(), maxByTable = new Map() } = {}) {
  return {
    async query(sql, params) {
      if (/information_schema\.columns/.test(sql)) {
        const name = params?.[0];
        const cols = tables.get(name);
        if (!cols) return { rows: [] };
        return { rows: cols.map((c) => ({ column_name: c, data_type: "text", is_nullable: "YES" })) };
      }
      const m = sql.match(/MAX\(created_at\) AS m FROM (\w+)/);
      if (m) {
        const name = m[1];
        const v = maxByTable.has(name) ? maxByTable.get(name) : null;
        return { rows: [{ m: v }] };
      }
      return { rows: [] };
    },
  };
}

test("dual_write_mirror_table check PASSes when both live and legacy tables are gone", async () => {
  const check = ALL_CHECKS.find((c) => c.id === "defer.cleanup.dual_write_mirror_table");
  const r = await check.run({ pool: fakePool() });
  assert.equal(r.status, "pass");
  assert.match(r.evidence, /dropped/);
});

test("dual_write_mirror_table check PASSes when only the *_legacy table exists (post-0015)", async () => {
  const check = ALL_CHECKS.find((c) => c.id === "defer.cleanup.dual_write_mirror_table");
  const last = "2026-04-29T01:00:00.000Z";
  const tables = new Map([
    ["dual_write_mirror_log_legacy", ["mirror_id", "created_at"]],
  ]);
  const maxByTable = new Map([["dual_write_mirror_log_legacy", last]]);
  const r = await check.run({ pool: fakePool({ tables, maxByTable }) });
  assert.equal(r.status, "pass");
  assert.match(r.evidence, /renamed to dual_write_mirror_log_legacy/);
  assert.match(r.evidence, /2026-04-29T01:00:00\.000Z/);
});

test("dual_write_mirror_table check stays DEFERRED when migration 0015 has not run", async () => {
  const check = ALL_CHECKS.find((c) => c.id === "defer.cleanup.dual_write_mirror_table");
  const tables = new Map([
    ["dual_write_mirror_log", ["mirror_id", "created_at"]],
  ]);
  const r = await check.run({ pool: fakePool({ tables }) });
  assert.equal(r.status, "deferred");
  assert.match(r.evidence, /Apply 0015_retire_dual_write_mirror_log\.sql/);
});

test("renderReport produces sections for every present status", () => {
  const md = renderReport({
    verdict: "READY",
    generatedAt: "2026-05-03T00:00:00Z",
    repoHead: "abc123def456",
    results: [
      { id: "x.y", section: "must", category: "schema", title: "T", status: "pass", evidence: "ok" },
      { id: "x.z", section: "should", category: "schema", title: "T2", status: "fail", evidence: "no", fixHint: "fix me" },
    ],
  });
  assert.match(md, /Verdict: \*\*READY\*\*/);
  assert.match(md, /## Must Complete/);
  assert.match(md, /## Strongly Recommended/);
  assert.match(md, /\| `x\.y` \| T \| PASS/);
});

test("renderHuman lists failing checks with fix hints", () => {
  const text = renderHuman({
    verdict: "NOT READY",
    results: [
      { id: "x.y", section: "must", title: "T", status: "fail", evidence: "boom", fixHint: "do thing" },
    ],
  });
  assert.match(text, /Layer 2 readiness: NOT READY/);
  assert.match(text, /\[FAIL\] x\.y/);
  assert.match(text, /-> do thing/);
});
