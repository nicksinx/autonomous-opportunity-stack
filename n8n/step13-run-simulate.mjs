#!/usr/bin/env node
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const backupsDir = path.join(repoRoot, "backups", "n8n");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = path.join(backupsDir, `step13-simulate-run-${stamp}.log`);

fs.mkdirSync(backupsDir, { recursive: true });

const startedAt = new Date().toISOString();
let log = `step13 simulate start: ${startedAt}\ncommand: npm run n8n:simulate\n\n`;

const child = spawn("npm", ["run", "n8n:simulate"], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  log += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  log += chunk.toString();
});

child.on("close", (code) => {
  const finishedAt = new Date().toISOString();
  log += `\nstep13 simulate end: ${finishedAt}\nexitCode: ${code}\n`;
  fs.writeFileSync(logPath, log);
  console.log(JSON.stringify({ startedAt, finishedAt, exitCode: code, artifact: logPath }, null, 2));
  process.exit(code || 0);
});
