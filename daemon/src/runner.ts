import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TASK_INSTRUCTION = "Read the file task.md in this workspace and follow the instructions in it.";

export interface RunnerOptions {
  binary: string;
  workspaceDir: string;
  timeoutMs: number;
  model?: string;
}

export async function createChat(opts: RunnerOptions): Promise<string> {
  const { stdout } = await execFileAsync(opts.binary, ["create-chat"], { timeout: 60_000 });
  const chatId = stdout.trim();
  if (!chatId) throw new Error("create-chat returned an empty chat id");
  return chatId;
}

export async function runTask(
  opts: RunnerOptions,
  chatId: string,
  taskContent: string,
): Promise<{ answer?: string; error?: string }> {
  mkdirSync(opts.workspaceDir, { recursive: true });
  writeFileSync(path.join(opts.workspaceDir, "task.md"), taskContent);
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
