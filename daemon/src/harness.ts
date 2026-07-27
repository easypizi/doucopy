import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import { createChat as cursorCreateChat, runTask as cursorRunTask, type RunnerOptions } from "./runner.js";

export type HarnessKind = "cursor-agent" | "claude" | "codex";

export interface HarnessOptions extends RunnerOptions {
  extraArgs?: string[];
}

export interface Harness {
  readonly kind: HarnessKind;
  createSession(opts: HarnessOptions): Promise<string>;
  runTask(opts: HarnessOptions, sessionId: string, task: string): Promise<{ answer?: string; error?: string }>;
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function killTree(proc: ChildProcess): void {
  if (proc.pid !== undefined) {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { /* group gone */ }
  }
  try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  proc.stdout?.destroy();
  proc.stderr?.destroy();
}

function writeTaskFile(workspaceDir: string, taskContent: string): string {
  mkdirSync(workspaceDir, { recursive: true });
  const taskPath = path.join(workspaceDir, "task.md");
  writeFileSync(taskPath, taskContent, { mode: 0o600 });
  chmodSync(taskPath, 0o600);
  return taskPath;
}

interface SpawnRunOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  labelForError: string;
}

// Generic "run to completion, capture stdout, kill on timeout" driver used by
// the Claude and Codex harnesses. Cursor keeps its own path in runner.ts
// because of the grandchild-pipe workaround.
function spawnAndCapture(opts: SpawnRunOptions): Promise<{ answer?: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: { answer?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(proc);
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({ error: `${opts.labelForError} failed: timed out after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        settle({ error: `${opts.labelForError} failed: output exceeded 10MB` });
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      settle({ error: `${opts.labelForError} failed: ${err.message.slice(0, 500)}` });
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || `exited with code ${code}`;
        settle({ error: `${opts.labelForError} failed: ${detail.slice(0, 500)}` });
        return;
      }
      const answer = stdout.trim();
      settle(answer ? { answer } : { error: `${opts.labelForError} produced empty output` });
    });
  });
}

class CursorHarness implements Harness {
  readonly kind: HarnessKind = "cursor-agent";
  createSession(opts: HarnessOptions): Promise<string> {
    return cursorCreateChat(opts);
  }
  runTask(opts: HarnessOptions, sessionId: string, task: string): Promise<{ answer?: string; error?: string }> {
    return cursorRunTask(opts, sessionId, task);
  }
}

class ClaudeHarness implements Harness {
  readonly kind: HarnessKind = "claude";
  // Claude accepts an externally supplied uuid via --session-id, so we can
  // skip a warmup call entirely and jump straight into the first --resume turn.
  async createSession(_opts: HarnessOptions): Promise<string> {
    return uuidv7();
  }
  runTask(opts: HarnessOptions, sessionId: string, task: string): Promise<{ answer?: string; error?: string }> {
    writeTaskFile(opts.workspaceDir, task);
    const args = [
      "-p",
      "Read the file task.md in this workspace and follow the instructions in it.",
      "--output-format", "text",
      "--session-id", sessionId,
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.extraArgs ?? []),
    ];
    return spawnAndCapture({
      cmd: opts.binary,
      args,
      cwd: opts.workspaceDir,
      timeoutMs: opts.timeoutMs,
      labelForError: "claude",
    });
  }
}

class CodexHarness implements Harness {
  readonly kind: HarnessKind = "codex";
  // Codex has no "create empty session" call; the session appears after the
  // first exec. We emit a stable session id ourselves and pass it via
  // CODEX_SESSION_ID (Codex 0.75+ honours it) so both turns use the same id.
  async createSession(_opts: HarnessOptions): Promise<string> {
    return uuidv7();
  }
  runTask(opts: HarnessOptions, sessionId: string, task: string): Promise<{ answer?: string; error?: string }> {
    writeTaskFile(opts.workspaceDir, task);
    const args = [
      "exec", "resume", sessionId,
      "--skip-git-repo-check",
      "--sandbox", "workspace-write",
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.extraArgs ?? []),
      "Read the file task.md in this workspace and follow the instructions in it.",
    ];
    return spawnAndCapture({
      cmd: opts.binary,
      args,
      cwd: opts.workspaceDir,
      env: { ...process.env, CODEX_SESSION_ID: sessionId },
      timeoutMs: opts.timeoutMs,
      labelForError: "codex",
    });
  }
}

export function createHarness(kind: HarnessKind): Harness {
  switch (kind) {
    case "cursor-agent": return new CursorHarness();
    case "claude": return new ClaudeHarness();
    case "codex": return new CodexHarness();
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unknown harness: ${_exhaustive as string}`);
    }
  }
}
