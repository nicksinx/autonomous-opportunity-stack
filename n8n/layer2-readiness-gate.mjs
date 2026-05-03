#!/usr/bin/env node
/**
 * Layer 2 readiness gate.
 *
 * Audits the repo + DB against LAYER2_IMPLEMENTATION_READINESS_CHECKLIST.md.
 * Modelled on n8n/phase1-gate.mjs.
 *
 * Usage:
 *   node n8n/layer2-readiness-gate.mjs                                  # human summary, exit 0 only if all Must pass
 *   node n8n/layer2-readiness-gate.mjs --json                           # machine-readable
 *   node n8n/layer2-readiness-gate.mjs --strict                         # also fail on any 'should' failure
 *   node n8n/layer2-readiness-gate.mjs --skip-db                        # static-only checks (no Postgres)
 *   node n8n/layer2-readiness-gate.mjs --run-tests                      # also exec npm run test + n8n:validate
 *   node n8n/layer2-readiness-gate.mjs --write-report=PATH              # also write markdown report
 *   node n8n/layer2-readiness-gate.mjs --section=must|should|defer|decision   # filter (repeatable)
 *
 * Exit code: 0 if Must Complete passes (and Strongly Recommended passes when --strict), else 1.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import pg from "pg";

import {
  ALL_CHECKS,
  makeCtx,
  parseDecisions,
} from "./lib/readiness-checks.mjs";
import { renderReport, renderHuman } from "./lib/readiness-report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ---------------- env ----------------
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv(path.join(repoRoot, ".env.postgres"));
loadDotEnv(path.join(repoRoot, ".env"));

// ---------------- args ----------------
function parseArgs(argv) {
  const args = {
    json: argv.includes("--json"),
    strict: argv.includes("--strict"),
    skipDb: argv.includes("--skip-db"),
    runTests: argv.includes("--run-tests"),
    writeReport: null,
    sections: [],
  };
  for (const a of argv) {
    if (a.startsWith("--write-report=")) args.writeReport = a.slice("--write-report=".length);
    else if (a === "--write-report") args.writeReport = "LAYER2_READINESS_REPORT.md";
    else if (a.startsWith("--section=")) args.sections.push(a.slice("--section=".length));
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ---------------- repo HEAD ----------------
function gitHead() {
  try {
    const headPath = path.join(repoRoot, ".git", "HEAD");
    if (!fs.existsSync(headPath)) return null;
    const head = fs.readFileSync(headPath, "utf8").trim();
    if (head.startsWith("ref: ")) {
      const refPath = path.join(repoRoot, ".git", head.slice(5));
      if (fs.existsSync(refPath)) return fs.readFileSync(refPath, "utf8").trim().slice(0, 12);
      return head;
    }
    return head.slice(0, 12);
  } catch {
    return null;
  }
}

// ---------------- pool ----------------
function makePool() {
  if (args.skipDb) return null;
  const uri = (process.env.DATABASE_URI_ADMIN || process.env.DATABASE_URI || "").trim();
  if (!uri) {
    console.warn("warn: DATABASE_URI not set; degrading to --skip-db");
    return null;
  }
  return new pg.Pool({ connectionString: uri, max: 4 });
}

// ---------------- run ----------------
async function runChecks(ctx, checks) {
  const out = [];
  for (const c of checks) {
    let r;
    try {
      r = await c.run(ctx);
    } catch (e) {
      r = { status: "fail", evidence: `check threw: ${e.message}`, fixHint: "investigate the gate code" };
    }
    out.push({
      id: c.id,
      section: c.section,
      category: c.category,
      title: c.title,
      status: r.status,
      evidence: r.evidence ?? "",
      fixHint: r.fixHint ?? null,
      refs: r.refs ?? c.refs ?? [],
    });
  }
  return out;
}

function decideVerdict(results, strict) {
  const sectionFail = (sec) => results.some((r) => r.section === sec && r.status === "fail");
  const sectionPartial = (sec) => results.some((r) => r.section === sec && r.status === "partial");
  const mustBad = sectionFail("must");
  const decisionsBad = sectionFail("decision");
  const shouldBad = sectionFail("should");
  if (mustBad || decisionsBad) return "NOT READY";
  if (strict && shouldBad) return "NOT READY";
  if (sectionPartial("must")) return "NEEDS INPUT";
  return "READY";
}

async function main() {
  const pool = makePool();
  const decisionsRaw = (() => {
    try { return fs.readFileSync(path.join(repoRoot, "LAYER2_DECISIONS.md"), "utf8"); } catch { return ""; }
  })();
  const decisions = parseDecisions(decisionsRaw);

  const ctx = makeCtx({
    pool,
    repoRoot,
    decisions,
    runTests: args.runTests,
    skipDb: args.skipDb || !pool,
  });

  const wantedSections = args.sections.length ? new Set(args.sections) : null;
  const checks = wantedSections
    ? ALL_CHECKS.filter((c) => wantedSections.has(c.section))
    : ALL_CHECKS;

  let results;
  try {
    results = await runChecks(ctx, checks);
  } finally {
    if (pool) await pool.end().catch(() => {});
  }

  const verdict = decideVerdict(results, args.strict);

  const payload = {
    verdict,
    generatedAt: new Date().toISOString(),
    repoHead: gitHead(),
    options: {
      strict: args.strict,
      "skip-db": args.skipDb,
      "run-tests": args.runTests,
      sections: args.sections,
    },
    results,
  };

  if (args.writeReport) {
    const md = renderReport(payload);
    const outPath = path.isAbsolute(args.writeReport)
      ? args.writeReport
      : path.join(repoRoot, args.writeReport);
    fs.writeFileSync(outPath, md, "utf8");
    if (!args.json) console.log(`Wrote ${outPath}`);
  }

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderHuman(payload));
  }

  process.exit(verdict === "READY" ? 0 : 1);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
