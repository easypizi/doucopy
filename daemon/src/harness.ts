import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { CodexSandbox } from "./permissions.js";
import { createChat as cursorCreateChat, runTask as cursorRunTask, type RunnerOptions } from "./runner.js";
import { killProcessTree, resolveSpawn } from "./win-spawn.js";

export type HarnessKind = "cursor-agent" | "claude" | "codex";

export interface HarnessOptions extends RunnerOptions {
  extraArgs?: string[];
  /** Inline Claude Code settings JSON (permissions). Passed as --settings. */
  claudeSettingsJson?: string;
  /** Codex --sandbox mode derived from restrictions. Defaults to workspace-write. */
  codexSandbox?: CodexSandbox;
}

export interface HarnessResult {
  answer?: string;
  error?: string;
  sessionId?: string;
}

export interface Harness {
  readonly kind: HarnessKind;
  runFirstTask(opts: HarnessOptions, task: string): Promise<HarnessResult>;
  runFollowupTask(opts: HarnessOptions, sessionId: string, task: string): Promise<HarnessResult>;
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

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

interface SpawnRunResult {
  answer?: string;
  error?: string;
}

/** Real user Codex home (auth/keychain). Never invent a per-workspace fake home. */
export function resolveUserCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME?.trim();
  if (fromEnv) return fromEnv;
  return path.join(homedir(), ".codex");
}

/** Prefer a short actionable line over Codex session banners in stderr. */
export function summarizeHarnessStderr(
  stderr: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const text = stderr.replace(/\s+/gu, " ").trim();
  if (!text) return "";
  const errorMatch = text.match(/\bError:\s*[^.]{1,200}/i)
    ?? text.match(/\berror:\s*[^.]{1,200}/i);
  let detail = errorMatch?.[0]?.trim() ?? "";
  if (!detail && /Reading additional input from stdin/i.test(text)) {
    detail = "stdin hang (codex waited for piped input). doucopy closes stdin after spawn.";
  }
  if (!detail) detail = text.slice(0, 500);
  if (/401|unauthorized/i.test(detail) || /401|unauthorized/i.test(text)) {
    if (!/codex login/i.test(detail)) {
      const codexHome = resolveUserCodexHome(env);
      detail = `${detail} — codex auth missing for CODEX_HOME=${codexHome}; run: codex login`;
    }
  }
  return detail.slice(0, 500);
}

// Generic "run to completion, capture stdout, kill on timeout" driver used by
// the Claude and Codex harnesses. Cursor keeps its own path in runner.ts
// because of the grandchild-pipe workaround.
function spawnAndCapture(opts: SpawnRunOptions): Promise<SpawnRunResult> {
  return new Promise((resolve) => {
    const invoked = resolveSpawn(opts.cmd, opts.args);
    // Use an explicit stdin pipe and close it immediately. Codex `exec` treats
    // an open non-TTY stdin as "read more prompt" and hangs forever; `ignore`
    // is not always enough across Codex versions / detached spawns.
    const proc = spawn(invoked.command, invoked.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: invoked.detached,
      shell: invoked.shell,
      windowsHide: invoked.windowsHide,
    });
    try {
      proc.stdin?.end();
    } catch {
      // already closed
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: SpawnRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(proc);
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({ error: `${opts.labelForError} failed: timed out after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        settle({ error: `${opts.labelForError} failed: output exceeded 10MB` });
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      settle({ error: `${opts.labelForError} failed: ${err.message.slice(0, 500)}` });
    });
    proc.on("close", (code) => {
      const answer = stdout.trim();
      // Codex may print a usable final message on stdout and still exit
      // non-zero after a stdin/banner quirk. Prefer the answer when present.
      if (answer) {
        settle({ answer });
        return;
      }
      if (code !== 0) {
        const detail = summarizeHarnessStderr(stderr) || `exited with code ${code}`;
        settle({ error: `${opts.labelForError} failed: ${detail.slice(0, 500)}` });
        return;
      }
      settle({ error: `${opts.labelForError} produced empty output` });
    });
  });
}

class CursorHarness implements Harness {
  readonly kind: HarnessKind = "cursor-agent";
  async runFirstTask(opts: HarnessOptions, task: string): Promise<HarnessResult> {
    let sessionId: string;
    try {
      sessionId = await cursorCreateChat(opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `cursor-agent failed: ${message.slice(0, 500)}` };
    }
    const result = await cursorRunTask(opts, sessionId, task);
    return { ...result, sessionId: result.answer !== undefined ? sessionId : undefined };
  }
  async runFollowupTask(opts: HarnessOptions, sessionId: string, task: string): Promise<HarnessResult> {
    const result = await cursorRunTask(opts, sessionId, task);
    return result;
  }
}

// Claude Code accepts an externally-supplied uuid via --session-id ONLY on
// session creation. Subsequent invocations for the same session must use
// --resume, so we branch first vs follow-up here.
class ClaudeHarness implements Harness {
  readonly kind: HarnessKind = "claude";
  private claudeArgs(opts: HarnessOptions, sessionFlags: string[]): string[] {
    return [
      "-p",
      "Read the file task.md in this workspace and follow the instructions in it.",
      "--output-format", "text",
      "--permission-mode", "dontAsk",
      ...sessionFlags,
      ...(opts.claudeSettingsJson ? ["--settings", opts.claudeSettingsJson] : []),
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.extraArgs ?? []),
    ];
  }

  async runFirstTask(opts: HarnessOptions, task: string): Promise<HarnessResult> {
    const sessionId = uuidv7();
    writeTaskFile(opts.workspaceDir, task);
    const result = await spawnAndCapture({
      cmd: opts.binary,
      args: this.claudeArgs(opts, ["--session-id", sessionId]),
      cwd: opts.workspaceDir,
      timeoutMs: opts.timeoutMs,
      labelForError: "claude",
    });
    return { ...result, sessionId: result.answer !== undefined ? sessionId : undefined };
  }
  async runFollowupTask(opts: HarnessOptions, sessionId: string, task: string): Promise<HarnessResult> {
    writeTaskFile(opts.workspaceDir, task);
    return spawnAndCapture({
      cmd: opts.binary,
      args: this.claudeArgs(opts, ["--resume", sessionId]),
      cwd: opts.workspaceDir,
      timeoutMs: opts.timeoutMs,
      labelForError: "claude",
    });
  }
}

// Codex has no "create empty session" call. The first turn is a plain
// `codex exec`; the session id appears afterwards in $CODEX_HOME/sessions
// as the last component of the rollout filename.
//
// We MUST use the real user CODEX_HOME (~/.codex). Auth (auth.json / OS
// keychain) is bound to that path. A per-workspace fake home causes 401
// even when `codex` interactive login works. Parallel dialogs are separated
// by picking rollouts with mtime >= run start instead of isolating homes.
class CodexHarness implements Harness {
  readonly kind: HarnessKind = "codex";

  private sandbox(opts: HarnessOptions): CodexSandbox {
    return opts.codexSandbox ?? "workspace-write";
  }

  async runFirstTask(opts: HarnessOptions, task: string): Promise<HarnessResult> {
    writeTaskFile(opts.workspaceDir, task);
    const codexHome = resolveUserCodexHome();
    mkdirSync(codexHome, { recursive: true });
    const runStartedAt = Date.now();
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox", this.sandbox(opts),
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.extraArgs ?? []),
      "Read the file task.md in this workspace and follow the instructions in it.",
    ];
    const result = await spawnAndCapture({
      cmd: opts.binary,
      args,
      cwd: opts.workspaceDir,
      env: { ...process.env, CODEX_HOME: codexHome },
      timeoutMs: opts.timeoutMs,
      labelForError: "codex",
    });
    if (result.error !== undefined || result.answer === undefined) return result;
    const sessionId = findLatestCodexSessionId(codexHome, { minMtimeMs: runStartedAt - 2000 });
    if (!sessionId) {
      return { error: "codex failed: could not locate session rollout in CODEX_HOME" };
    }
    return { ...result, sessionId };
  }

  runFollowupTask(opts: HarnessOptions, sessionId: string, task: string): Promise<HarnessResult> {
    writeTaskFile(opts.workspaceDir, task);
    const codexHome = resolveUserCodexHome();
    mkdirSync(codexHome, { recursive: true });
    // `codex exec resume` rejects `--sandbox` even before the subcommand:
    // that flag is not global (only plain `codex exec` accepts it). Use the
    // global `-c sandbox_mode=...` override instead. `--skip-git-repo-check`
    // and `--model` are global and remain fine.
    const args = [
      "exec",
      "--skip-git-repo-check",
      "-c", `sandbox_mode="${this.sandbox(opts)}"`,
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.extraArgs ?? []),
      "resume", sessionId,
      "Read the file task.md in this workspace and follow the instructions in it.",
    ];
    return spawnAndCapture({
      cmd: opts.binary,
      args,
      cwd: opts.workspaceDir,
      env: { ...process.env, CODEX_HOME: codexHome },
      timeoutMs: opts.timeoutMs,
      labelForError: "codex",
    });
  }
}

const CODEX_ROLLOUT_RE = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface FindLatestCodexSessionOptions {
  /** Ignore rollouts older than this (ms since epoch). Filters parallel dialogs. */
  minMtimeMs?: number;
}

// Walk $CODEX_HOME/sessions recursively, pick the newest rollout-*.jsonl by
// mtime, extract the trailing uuid. Codex organises sessions under date-based
// subdirectories so we cannot glob a single level.
export function findLatestCodexSessionId(
  codexHome: string,
  opts: FindLatestCodexSessionOptions = {},
): string | null {
  const root = path.join(codexHome, "sessions");
  const minMtimeMs = opts.minMtimeMs ?? 0;
  const state: { best: { mtimeMs: number; id: string } | null } = { best: null };
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const match = entry.name.match(CODEX_ROLLOUT_RE);
      if (!match) continue;
      let mtimeMs = 0;
      try { mtimeMs = statSync(full).mtimeMs; } catch { continue; }
      if (mtimeMs < minMtimeMs) continue;
      if (!state.best || mtimeMs > state.best.mtimeMs) {
        state.best = { mtimeMs, id: match[1] };
      }
    }
  };
  walk(root);
  return state.best ? state.best.id : null;
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
