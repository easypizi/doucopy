import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { killProcessTree, resolveSpawn } from "./win-spawn.js";

const TASK_INSTRUCTION = "Read the file task.md in this workspace and follow the instructions in it.";
const CREATE_CHAT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface RunnerOptions {
  binary: string;
  workspaceDir: string;
  timeoutMs: number;
  model?: string;
}

// Some cursor-agent builds (>=2026.07) print the new chat id to stdout and then
// keep the process alive, so execFile hangs until the outer timeout. Read the
// first line ourselves and terminate the child once we have the id.
export async function createChat(opts: RunnerOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // cwd must be the conversation workspace so project `.cursor/cli.json`
    // permissions are loaded (Cursor resolves project config from cwd).
    mkdirSync(opts.workspaceDir, { recursive: true });
    const invoked = resolveSpawn(opts.binary, ["create-chat"]);
    const proc = spawn(invoked.command, invoked.args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: invoked.detached,
      shell: invoked.shell,
      windowsHide: invoked.windowsHide,
      cwd: opts.workspaceDir,
    });
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(proc);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("create-chat timed out")));
    }, CREATE_CHAT_TIMEOUT_MS);
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const chatId = buffer.slice(0, nl).trim();
      finish(() => {
        if (chatId) resolve(chatId);
        else reject(new Error("create-chat returned an empty chat id"));
      });
    });
    proc.on("error", (err) => finish(() => reject(err)));
    proc.on("close", () => {
      const chatId = buffer.split("\n")[0]?.trim() ?? "";
      finish(() => {
        if (chatId) resolve(chatId);
        else reject(new Error("create-chat returned an empty chat id"));
      });
    });
  });
}

export async function runTask(
  opts: RunnerOptions,
  chatId: string,
  taskContent: string,
): Promise<{ answer?: string; error?: string }> {
  mkdirSync(opts.workspaceDir, { recursive: true });
  const taskPath = path.join(opts.workspaceDir, "task.md");
  writeFileSync(taskPath, taskContent, { mode: 0o600 });
  chmodSync(taskPath, 0o600);
  const args = [
    "--resume", chatId,
    "-p", TASK_INSTRUCTION,
    "--output-format", "text",
    "--trust",
    "--force",
    "--workspace", opts.workspaceDir,
  ];
  if (opts.model) args.push("--model", opts.model);
  return new Promise((resolve) => {
    // Same cwd requirement as createChat: without it, deny rules in
    // `<workspace>/.cursor/cli.json` are ignored and `--force` allows writes.
    const invoked = resolveSpawn(opts.binary, args);
    const proc = spawn(invoked.command, invoked.args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: invoked.detached,
      shell: invoked.shell,
      windowsHide: invoked.windowsHide,
      cwd: opts.workspaceDir,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const settle = (result: { answer?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      killProcessTree(proc);
      resolve(result);
    };
    const finalize = (code: number | null) => {
      if (code !== 0) {
        const detail = stderr.trim() || `exited with code ${code}`;
        settle({ error: `cursor-agent failed: ${detail.slice(0, 500)}` });
        return;
      }
      const answer = stdout.trim();
      settle(answer ? { answer } : { error: "responder produced empty output" });
    };
    // Settle immediately on timeout instead of waiting for "close": the whole
    // point is to survive processes that never release their stdio pipes.
    const timer = setTimeout(() => {
      settle({ error: `cursor-agent failed: timed out after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        settle({ error: "cursor-agent failed: output exceeded 10MB" });
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      settle({ error: `cursor-agent failed: ${err.message.slice(0, 500)}` });
    });
    // "close" waits for stdio to drain, which never happens when a grandchild
    // keeps the pipes open. Back it up with "exit" plus a short grace period so
    // an answer printed before exit is still delivered.
    proc.on("exit", (code) => {
      graceTimer = setTimeout(() => finalize(code), 1500);
    });
    proc.on("close", (code) => finalize(code));
  });
}
