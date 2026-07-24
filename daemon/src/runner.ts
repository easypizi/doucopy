import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TASK_INSTRUCTION = "Read the file task.md in this workspace and follow the instructions in it.";
const CREATE_CHAT_TIMEOUT_MS = 30_000;

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
    const proc = spawn(opts.binary, ["create-chat"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!proc.killed) proc.kill();
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
  try {
    const { stdout } = await execFileAsync(opts.binary, args, {
      timeout: opts.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    const answer = stdout.trim();
    return answer ? { answer } : { error: "responder produced empty output" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `cursor-agent failed: ${message.slice(0, 500)}` };
  }
}
