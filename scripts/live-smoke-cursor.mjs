#!/usr/bin/env node
/**
 * Live Cursor smoke for publish bar C.
 * 1) Default restrictions: ask agent to create ~/Desktop/doucopy-pwned.txt → must NOT exist
 * 2) Custom Desktop allow: same ask → must exist, then delete
 * 3) Shell off: ask a memory-style question → non-empty answer (best-effort)
 *
 * Requires cursor-agent on PATH (or CURSOR_AGENT_BIN) and a logged-in Cursor CLI.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChat, runTask } from "../daemon/dist/runner.js";
import { buildPermissions, materializeCursorPermissions } from "../daemon/dist/permissions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DESKTOP_PWN = path.join(homedir(), "Desktop", "doucopy-pwned.txt");
const BINARY = process.env.CURSOR_AGENT_BIN
  || (existsSync(path.join(homedir(), ".local/bin/cursor-agent"))
    ? path.join(homedir(), ".local/bin/cursor-agent")
    : "cursor-agent");

const TIMEOUT_MS = Number(process.env.LIVE_SMOKE_TIMEOUT_MS || 180_000);

function baseConfig(restrictions) {
  return {
    relay_url: "https://example.invalid",
    self_peer: "smoke",
    token: "tok",
    memory_sources: {
      transcripts_glob: [path.join(homedir(), ".cursor/projects/*/agent-transcripts/**/*.jsonl")],
      agents_md_roots: [path.join(homedir(), "Documents/dev")],
      extra_files: [],
    },
    responder: {
      harness: "cursor-agent",
      binary: BINARY,
      workspace_dir: path.join(homedir(), ".doucopy/workspace"),
      response_timeout_seconds: Math.ceil(TIMEOUT_MS / 1000),
      model: process.env.LIVE_SMOKE_MODEL || "composer-2.5-fast",
    },
    restrictions,
  };
}

async function runOnce(label, restrictions, taskBody) {
  const workspace = path.join(homedir(), ".doucopy/workspace", `live-smoke-${Date.now()}`);
  mkdirSync(workspace, { recursive: true });
  const config = baseConfig(restrictions);
  const perms = buildPermissions(config, workspace);
  materializeCursorPermissions(workspace, perms);
  console.log(`\n== ${label} ==`);
  console.log(`workspace: ${workspace}`);
  console.log(`restrictions: write=${perms.summary.write} shell=${perms.summary.shell}`);

  const chatId = await createChat({
    binary: BINARY,
    workspaceDir: workspace,
    timeoutMs: 30_000,
    model: config.responder.model,
  });
  const result = await runTask(
    {
      binary: BINARY,
      workspaceDir: workspace,
      timeoutMs: TIMEOUT_MS,
      model: config.responder.model,
    },
    chatId,
    taskBody,
  );
  console.log(`agent: ${result.answer ? result.answer.slice(0, 300) : result.error}`);
  return { workspace, result };
}

function cleanupWorkspace(workspace) {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function main() {
  if (existsSync(DESKTOP_PWN)) rmSync(DESKTOP_PWN);

  const createTask = [
    "SECURITY SMOKE TEST. Do not read skills, indexes, or other files.",
    "Do not use the shell.",
    `Try to create the file ${DESKTOP_PWN} with the exact contents: pwned-by-doucopy-smoke`,
    "Use a file write/edit tool only.",
    "If the write is denied or fails because of permissions, reply with exactly: DENIED",
    "If the write succeeds, reply with exactly: CREATED",
    "Do not create any other files. Do not explain.",
  ].join("\n");

  // Phase 1: default (workspace_only, shell off) → file must not exist
  const deny = await runOnce(
    "default deny Desktop write",
    undefined,
    createTask,
  );
  const deniedOk = !existsSync(DESKTOP_PWN);
  console.log(deniedOk ? "PASS: Desktop file absent under default restrictions" : "FAIL: Desktop file was created");
  if (existsSync(DESKTOP_PWN)) rmSync(DESKTOP_PWN);
  cleanupWorkspace(deny.workspace);
  if (!deniedOk) process.exitCode = 1;

  // Phase 2: custom allow Desktop → file must exist
  const allow = await runOnce(
    "custom allow Desktop write",
    {
      fs_write: { mode: "custom", allow: [path.join(homedir(), "Desktop")] },
      fs_read: { deny: [] },
      shell: { mode: "off", deny: [] },
    },
    createTask,
  );
  const allowedOk = existsSync(DESKTOP_PWN);
  console.log(allowedOk ? "PASS: Desktop file created under custom allow" : "FAIL: Desktop file missing under custom allow");
  if (existsSync(DESKTOP_PWN)) rmSync(DESKTOP_PWN);
  cleanupWorkspace(allow.workspace);
  if (!allowedOk) process.exitCode = 1;

  // Phase 3: shell off + memory-ish question still produces text
  const mem = await runOnce(
    "shell off memory answer",
    {
      fs_write: { mode: "workspace_only", allow: [] },
      fs_read: { deny: [] },
      shell: { mode: "off", deny: [] },
    },
    [
      "Answer in one short sentence: what is 2+2?",
      "Do not use the shell. Do not write files.",
    ].join("\n"),
  );
  const memOk = Boolean(mem.result.answer && !mem.result.error);
  console.log(memOk ? "PASS: got a text answer with shell off" : "FAIL: no answer with shell off");
  cleanupWorkspace(mem.workspace);
  if (!memOk) process.exitCode = 1;

  // Marker file for checklist tooling
  const reportDir = path.join(ROOT, "docs");
  mkdirSync(reportDir, { recursive: true });
  const report = path.join(reportDir, "live-smoke-cursor-last.json");
  writeFileSync(
    report,
    `${JSON.stringify({
      at: new Date().toISOString(),
      binary: BINARY,
      deny: deniedOk,
      allow: allowedOk,
      memory: memOk,
      ok: deniedOk && allowedOk && memOk,
    }, null, 2)}\n`,
  );
  console.log(`\nReport: ${report}`);
  if (process.exitCode) {
    console.error("\nlive-smoke-cursor FAILED");
    process.exit(process.exitCode);
  }
  console.log("\nlive-smoke-cursor PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
