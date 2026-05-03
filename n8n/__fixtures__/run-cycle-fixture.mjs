#!/usr/bin/env node
/**
 * Regression test for the cycle detector in n8n/validate-workflows.mjs.
 *
 * The historical bug: wf_score_and_cluster contained a graph cycle on the
 * no-Tier-A path (Build run log + mirror rows -> Insert workflow_runs ->
 * Has Tier A opportunities? -> Build run log + mirror rows). The validator
 * shipped without cycle detection so the bug reached production and caused
 * the workflow to hang during Step 10.
 *
 * This test reproduces an analogous cycle in n8n/__fixtures__/wf_with_cycle.json
 * and asserts the validator exits non-zero and prints the cycle.
 *
 * Run:
 *   node n8n/__fixtures__/run-cycle-fixture.mjs
 *
 * Exit 0 = guard works (cycle was detected). Exit 1 = guard regression.
 */

import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const validator = path.join(repoRoot, "n8n", "validate-workflows.mjs");

const result = spawnSync("node", [validator, `--dir=${__dirname}`], {
  cwd: repoRoot,
  encoding: "utf8",
});

const out = `${result.stdout || ""}\n${result.stderr || ""}`;
const detected = /cycle detected in connections:/.test(out);
const failed = result.status !== 0;

if (detected && failed) {
  console.log("PASS: validator detected cycle and exited non-zero");
  process.exit(0);
} else {
  console.error("FAIL: cycle guard regression");
  console.error(`  exit=${result.status}, detected=${detected}`);
  console.error("---validator output---");
  console.error(out);
  process.exit(1);
}
