#!/usr/bin/env node
/**
 * Deterministic clustering CLI — mirrors n8n CLUSTER_ENGINE=deterministic behaviour.
 */
import fs from "node:fs";
import path from "path";
import { partitionDeterministic } from "../../n8n/lib/clusterer.mjs";

function demoRows() {
  return [
    { canonical_id: "norm_demo_a", niche_keyword: "demo niche", tier: "A" },
    { canonical_id: "norm_demo_b", niche_keyword: "demo niche two", tier: "B" },
  ];
}

async function main() {
  const fileArg = process.argv[2];
  let rows = [];
  if (fileArg === "-" || process.argv.includes("--stdin")) {
    const chunks = [];
    for await (const ch of process.stdin) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (raw) rows = JSON.parse(raw);
  } else if (fileArg) {
    const p = path.resolve(process.cwd(), fileArg);
    rows = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  if (!Array.isArray(rows) || !rows.length) {
    rows = demoRows();
  }
  const clusters = partitionDeterministic(rows, { maxPerCluster: 20, clusterVersion: "deterministic-v1" });
  console.info(JSON.stringify({ clusters: clusters.length, partitions: clusters }, null, 2));
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
