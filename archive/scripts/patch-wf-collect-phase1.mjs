/**
 * Phase 1: remove dual_write_mirror_log nodes from wf_collect_trends.json
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wfPath = path.join(__dirname, "..", "n8n/wf_collect_trends.json");

const data = JSON.parse(fs.readFileSync(wfPath, "utf8"));
const wf = data.find((w) => w.name === "wf_collect_trends");
if (!wf) throw new Error("wf_collect_trends not found");

const mirrorIds = new Set([
  "a1000001-0001-4001-8001-000000000115",
  "a1000001-0001-4001-8001-000000000116",
]);
wf.nodes = wf.nodes.filter((n) => !mirrorIds.has(n.id));

const conn = wf.connections;
if (conn["Append workflow_runs (success)"]?.main?.[0]) {
  conn["Append workflow_runs (success)"].main[0] = conn["Append workflow_runs (success)"].main[0].filter(
    (c) => c.node !== "Build raw_signals mirror rows",
  );
}
delete conn["Build raw_signals mirror rows"];

fs.writeFileSync(wfPath, JSON.stringify(data, null, 2), "utf8");
console.log("Patched", wfPath);
