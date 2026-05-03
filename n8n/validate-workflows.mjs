#!/usr/bin/env node
/**
 * Static validation for committed n8n workflow JSON under n8n/.
 *
 * Usage:
 *   node n8n/validate-workflows.mjs
 *   node n8n/validate-workflows.mjs --json
 *   node n8n/validate-workflows.mjs --dir /path/to/n8n
 *   node n8n/validate-workflows.mjs --strict
 *
 * Exit code 0 = all checks passed, 1 = at least one error.
 * --strict also fails if the same workflow name appears in more than one file (import ambiguity).
 * Codex: run after imports or JSON edits; pair with n8n-mcp validate_workflow for runtime checks.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const strict = args.includes("--strict");
const dirArg = args.find((a) => a.startsWith("--dir="));
const n8nDir = dirArg ? dirArg.slice("--dir=".length) : __dirname;

function listWorkflowFiles(root) {
  if (!fs.existsSync(root)) {
    throw new Error(`Directory not found: ${root}`);
  }
  return fs
    .readdirSync(root)
    .filter((f) => f.startsWith("wf_") && f.endsWith(".json"))
    .map((f) => path.join(root, f))
    .sort();
}

function normalizeToArray(data, filePath) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray(data.nodes)) {
    return [data];
  }
  throw new Error(`${filePath}: root must be a JSON array of workflows or a single workflow object`);
}

function collectConnectionTargets(mainBranches) {
  const targets = [];
  if (!Array.isArray(mainBranches)) return targets;
  for (const branch of mainBranches) {
    if (!Array.isArray(branch)) continue;
    for (const link of branch) {
      if (link && typeof link === "object" && typeof link.node === "string") {
        targets.push(link.node);
      }
    }
  }
  return targets;
}

function walkAllConnectionTargets(connections) {
  const targets = [];
  if (!connections || typeof connections !== "object") return targets;
  for (const [, out] of Object.entries(connections)) {
    if (!out || typeof out !== "object" || !Array.isArray(out.main)) continue;
    for (const mainBranch of out.main) {
      if (!Array.isArray(mainBranch)) continue;
      for (const inner of mainBranch) {
        if (Array.isArray(inner)) {
          for (const link of inner) {
            if (link && typeof link.node === "string") targets.push(link.node);
          }
        } else if (inner && typeof inner.node === "string") {
          targets.push(inner.node);
        }
      }
    }
  }
  return targets;
}

// Build a per-source adjacency map of node-name -> [target node names].
// Mirrors walkAllConnectionTargets but keeps the source attribution so we can
// run a directed-graph cycle detector over the workflow.
function buildAdjacency(connections) {
  const adj = new Map();
  if (!connections || typeof connections !== "object") return adj;
  for (const [source, out] of Object.entries(connections)) {
    if (!out || typeof out !== "object" || !Array.isArray(out.main)) continue;
    const targets = [];
    for (const mainBranch of out.main) {
      if (!Array.isArray(mainBranch)) continue;
      for (const inner of mainBranch) {
        if (Array.isArray(inner)) {
          for (const link of inner) {
            if (link && typeof link.node === "string") targets.push(link.node);
          }
        } else if (inner && typeof inner.node === "string") {
          targets.push(inner.node);
        }
      }
    }
    adj.set(source, targets);
  }
  return adj;
}

// Detect cycles in the workflow connection graph using iterative DFS with
// gray/black coloring. Returns an array of cycles, each a node-name array
// where the first and last entries are the same node (e.g. ["A","B","C","A"]).
// Catches the historical wf_score_and_cluster regression where a no-Tier-A
// branch fed back into an upstream "Build run log" node.
function findConnectionCycles(connections, nodeNames) {
  const adj = buildAdjacency(connections);
  const cycles = [];
  const seenCycleKey = new Set();
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const n of nodeNames) color.set(n, WHITE);
  for (const start of nodeNames) {
    if (color.get(start) !== WHITE) continue;
    const stack = [{ node: start, iter: (adj.get(start) || [])[Symbol.iterator]() }];
    color.set(start, GRAY);
    const path = [start];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = frame.iter.next();
      if (next.done) {
        color.set(frame.node, BLACK);
        path.pop();
        stack.pop();
        continue;
      }
      const child = next.value;
      if (typeof child !== "string") continue;
      if (!color.has(child)) color.set(child, WHITE);
      const c = color.get(child);
      if (c === GRAY) {
        const idx = path.indexOf(child);
        if (idx >= 0) {
          const cycle = path.slice(idx).concat(child);
          const key = cycle.join("\u0000");
          if (!seenCycleKey.has(key)) {
            seenCycleKey.add(key);
            cycles.push(cycle);
          }
        }
      } else if (c === WHITE) {
        color.set(child, GRAY);
        path.push(child);
        stack.push({ node: child, iter: (adj.get(child) || [])[Symbol.iterator]() });
      }
    }
  }
  return cycles;
}

const PG_TYPE = "n8n-nodes-base.postgres";
const PG_OPS_REQUIRING_TABLE = new Set(["insert", "upsert", "update", "delete"]);
const PG_OPS_REQUIRING_COLUMNS = new Set(["insert", "upsert", "update"]);
const PG_OPS_REQUIRING_MATCHING = new Set(["upsert", "update"]);
const PG_OPS_KNOWN = new Set([
  "insert", "upsert", "update", "delete", "executeQuery", "select",
]);

function rlValue(rl) {
  if (!rl) return null;
  if (typeof rl === "string") return rl;
  if (typeof rl === "object" && rl.value != null) return String(rl.value);
  return null;
}

function validatePostgresNode(n) {
  const errs = [];
  const params = n?.parameters && typeof n.parameters === "object" ? n.parameters : null;
  const ref = `node "${n.name || n.id || "?"}"`;
  if (!params) {
    errs.push(`${ref}: postgres node missing parameters`);
    return errs;
  }
  const op = params.operation;
  if (!op || typeof op !== "string") {
    errs.push(`${ref}: postgres node missing parameters.operation`);
    return errs;
  }
  if (!PG_OPS_KNOWN.has(op)) {
    errs.push(`${ref}: unknown postgres operation "${op}"`);
  }
  if (PG_OPS_REQUIRING_TABLE.has(op)) {
    const tbl = rlValue(params.table);
    if (!tbl) errs.push(`${ref}: ${op} requires parameters.table.value`);
  }
  if (PG_OPS_REQUIRING_COLUMNS.has(op)) {
    const colsBag = params.columns;
    const schemaList = Array.isArray(colsBag?.schema) ? colsBag.schema : [];
    const valueObj = colsBag?.value && typeof colsBag.value === "object" ? colsBag.value : {};
    const haveColumns = schemaList.length > 0 || Object.keys(valueObj).length > 0;
    if (!haveColumns) errs.push(`${ref}: ${op} requires non-empty parameters.columns`);
  }
  if (PG_OPS_REQUIRING_MATCHING.has(op)) {
    const matching = params.columns?.matchingColumns;
    if (!Array.isArray(matching) || !matching.length) {
      errs.push(`${ref}: ${op} requires parameters.columns.matchingColumns (conflict/key columns)`);
    }
  }
  if (op === "executeQuery") {
    if (typeof params.query !== "string" || !params.query.trim()) {
      errs.push(`${ref}: executeQuery requires parameters.query`);
    }
  }
  if (typeof n.typeVersion !== "number" || n.typeVersion < 2.1) {
    errs.push(`${ref}: postgres typeVersion ${n.typeVersion} is older than 2.1; use 2.5+`);
  }
  const cred = n.credentials?.postgres;
  if (!cred || (typeof cred.name !== "string" && typeof cred.id !== "string")) {
    errs.push(`${ref}: postgres credentials.postgres.name|id missing`);
  }
  return errs;
}

function validateWorkflow(wf, { filePath, idsInFile }) {
  const errors = [];
  const warnings = [];

  if (!wf || typeof wf !== "object") {
    errors.push("workflow is not an object");
    return { errors, warnings };
  }

  if (typeof wf.id !== "string" || !wf.id.trim()) errors.push("missing workflow.id");
  if (typeof wf.name !== "string" || !wf.name.trim()) errors.push("missing workflow.name");

  const nodes = wf.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push("nodes must be a non-empty array");
    return { errors, warnings };
  }

  const nodeByName = new Map();
  const nodeById = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || typeof n !== "object") {
      errors.push(`nodes[${i}] is not an object`);
      continue;
    }
    if (typeof n.id !== "string" || !n.id.trim()) errors.push(`nodes[${i}] missing id`);
    if (typeof n.name !== "string" || !n.name.trim()) errors.push(`nodes[${i}] missing name`);
    if (typeof n.type !== "string" || !n.type.trim()) errors.push(`nodes[${i}] missing type`);
    if (n.name) {
      if (nodeByName.has(n.name)) errors.push(`duplicate node name: "${n.name}"`);
      else nodeByName.set(n.name, n);
    }
    if (n.id) {
      if (nodeById.has(n.id)) errors.push(`duplicate node id: "${n.id}"`);
      else nodeById.set(n.id, n);
    }
    if (n.type === "n8n-nodes-base.googleSheets") {
      errors.push(`node "${n.name}" still uses n8n-nodes-base.googleSheets; cutover incomplete`);
    }
    if (n.type === PG_TYPE) {
      for (const e of validatePostgresNode(n)) errors.push(e);
    }
  }

  const conn = wf.connections;
  if (!conn || typeof conn !== "object") {
    errors.push("connections must be an object");
  } else {
    for (const sourceName of Object.keys(conn)) {
      if (!nodeByName.has(sourceName)) {
        errors.push(`connections source "${sourceName}" is not a node name in this workflow`);
      }
    }
    for (const target of walkAllConnectionTargets(conn)) {
      if (!nodeByName.has(target)) {
        errors.push(`connection target "${target}" is not a node name in this workflow`);
      }
    }
    const cycles = findConnectionCycles(conn, Array.from(nodeByName.keys()));
    for (const cycle of cycles) {
      // n8n's SplitInBatches node is the canonical batch-iteration construct
      // - successor nodes loop back into it to fetch the next batch. Treat
      // those as benign and skip. The closure node is the duplicate first/last
      // entry of the cycle path.
      const closure = cycle[0];
      const closureNode = nodeByName.get(closure);
      if (closureNode && closureNode.type === "n8n-nodes-base.splitInBatches") {
        continue;
      }
      errors.push(`cycle detected in connections: ${cycle.join(" -> ")}`);
    }
  }

  const settings = wf.settings && typeof wf.settings === "object" ? wf.settings : {};
  const errWf = settings.errorWorkflow;
  if (errWf !== undefined && errWf !== null && errWf !== "") {
    if (typeof errWf !== "string") {
      errors.push("settings.errorWorkflow must be a string id when set");
    } else if (!idsInFile.has(errWf)) {
      errors.push(
        `settings.errorWorkflow "${errWf}" does not match any workflow id in the same file (bundle import must include the error workflow in this JSON)`,
      );
    }
  }

  const name = String(wf.name || "");
  if (name.includes("Error Handler")) {
    const hasErrorTrigger = nodes.some((n) => n && n.type === "n8n-nodes-base.errorTrigger");
    if (!hasErrorTrigger) warnings.push('name suggests error handler but no n8n-nodes-base.errorTrigger node');
  }

  if (errWf && !name.includes("Error Handler")) {
    const handler = idsInFile.get(errWf);
    if (handler && typeof handler.name === "string" && !handler.name.includes("Error Handler")) {
      warnings.push("errorWorkflow points to a workflow whose name does not look like an error handler");
    }
  }

  const tags = wf.tags;
  if (Array.isArray(tags)) {
    const tagNames = tags.map((t) => (t && t.name ? t.name : String(t)));
    if (!tagNames.includes("pod-research")) warnings.push('tags do not include "pod-research" (project convention)');
  } else {
    warnings.push("missing tags array (optional but expected for this repo)");
  }

  return { errors, warnings };
}

function main() {
  let files;
  try {
    files = listWorkflowFiles(n8nDir);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`No wf_*.json files under ${n8nDir}`);
    process.exit(1);
  }

  const report = {
    ok: true,
    n8nDir: path.resolve(n8nDir),
    files: [],
    duplicateNamesAcrossFiles: [],
  };

  const nameToFiles = new Map();

  for (const filePath of files) {
    const rel = path.relative(process.cwd(), filePath) || filePath;
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (e) {
      report.ok = false;
      report.files.push({
        file: rel,
        error: `read failed: ${e.message}`,
        workflows: [],
      });
      continue;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      report.ok = false;
      report.files.push({
        file: rel,
        error: `invalid JSON: ${e.message}`,
        workflows: [],
      });
      continue;
    }

    let workflows;
    try {
      workflows = normalizeToArray(data, rel);
    } catch (e) {
      report.ok = false;
      report.files.push({
        file: rel,
        error: e.message,
        workflows: [],
      });
      continue;
    }

    const idsInFile = new Map(workflows.map((w) => [w.id, w]));

    const fileEntry = {
      file: rel,
      workflows: [],
    };

    for (const wf of workflows) {
      const v = validateWorkflow(wf, { filePath: rel, idsInFile });
      const wname = wf.name || "(unnamed)";
      if (v.errors.length) report.ok = false;

      fileEntry.workflows.push({
        id: wf.id,
        name: wname,
        nodeCount: Array.isArray(wf.nodes) ? wf.nodes.length : 0,
        errors: v.errors,
        warnings: v.warnings,
      });

      if (typeof wf.name === "string" && wf.name.trim()) {
        const list = nameToFiles.get(wf.name) || [];
        list.push(rel);
        nameToFiles.set(wf.name, list);
      }
    }

    report.files.push(fileEntry);
  }

  for (const [wname, flist] of nameToFiles) {
    const uniqueFiles = [...new Set(flist)];
    if (uniqueFiles.length > 1) {
      report.duplicateNamesAcrossFiles.push({
        workflowName: wname,
        files: uniqueFiles,
      });
    }
  }

  if (strict && report.duplicateNamesAcrossFiles.length) {
    report.strictDuplicateNamesFailed = true;
    report.ok = false;
  }

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Validated ${files.length} file(s) under ${report.n8nDir}\n`);
    for (const fe of report.files) {
      console.log(`— ${fe.file}`);
      if (fe.error) {
        console.log(`  FILE ERROR: ${fe.error}`);
        continue;
      }
      for (const w of fe.workflows) {
        const status =
          w.errors.length === 0 ? (w.warnings.length ? "PASS (warnings)" : "PASS") : "FAIL";
        console.log(`  [${status}] ${w.name} (${w.nodeCount} nodes)`);
        for (const e of w.errors) console.log(`    ERROR: ${e}`);
        for (const x of w.warnings) console.log(`    WARN:  ${x}`);
      }
    }
    if (report.duplicateNamesAcrossFiles.length) {
      console.log("\nDuplicate workflow names across files (resolve by importing one source of truth):");
      for (const d of report.duplicateNamesAcrossFiles) {
        console.log(`  "${d.workflowName}":`);
        for (const f of d.files) console.log(`    - ${f}`);
      }
      if (strict) console.error("\n--strict: duplicate workflow names treated as failure.");
    }
  }

  process.exit(report.ok ? 0 : 1);
}

main();
