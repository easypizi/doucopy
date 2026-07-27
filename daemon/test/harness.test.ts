import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "../src/harness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURE = path.resolve(HERE, "fixtures/fake-claude.sh");
const CODEX_FIXTURE = path.resolve(HERE, "fixtures/fake-codex.sh");

const SAVED_ENV = [
  "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_MODE", "FAKE_CLAUDE_ANSWER",
  "FAKE_CODEX_LOG", "FAKE_CODEX_MODE", "FAKE_CODEX_ANSWER",
] as const;
let backup: Record<string, string | undefined> = {};

beforeEach(() => { backup = {}; for (const k of SAVED_ENV) backup[k] = process.env[k]; });
afterEach(() => {
  for (const k of SAVED_ENV) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

describe("ClaudeHarness", () => {
  it("returns a uuid session id without invoking the binary", async () => {
    const harness = createHarness("claude");
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-claude-"));
    const logFile = path.join(dir, "args.log");
    process.env.FAKE_CLAUDE_LOG = logFile;
    const session = await harness.createSession({
      binary: CLAUDE_FIXTURE,
      workspaceDir: path.join(dir, "workspace"),
      timeoutMs: 5000,
    });
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(logFile)).toBe(false);
  });

  it("runTask writes task.md, passes --resume with session id, returns the answer", async () => {
    const harness = createHarness("claude");
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-claude-"));
    const workspace = path.join(dir, "workspace");
    const logFile = path.join(dir, "args.log");
    process.env.FAKE_CLAUDE_LOG = logFile;
    process.env.FAKE_CLAUDE_ANSWER = "42";
    const result = await harness.runTask(
      { binary: CLAUDE_FIXTURE, workspaceDir: workspace, timeoutMs: 5000, model: "sonnet-x" },
      "sid-1",
      "TASK CONTENT",
    );
    expect(result).toEqual({ answer: "42" });
    expect(readFileSync(path.join(workspace, "task.md"), "utf8")).toBe("TASK CONTENT");
    const args = readFileSync(logFile, "utf8").trimEnd().split("\n");
    expect(args).toContain("--session-id");
    expect(args).toContain("sid-1");
    expect(args).toContain("--model");
    expect(args).toContain("sonnet-x");
    expect(args).toContain("-p");
  });

  it("surfaces a failing exit code as an error", async () => {
    const harness = createHarness("claude");
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-claude-"));
    process.env.FAKE_CLAUDE_MODE = "fail";
    const result = await harness.runTask(
      { binary: CLAUDE_FIXTURE, workspaceDir: path.join(dir, "workspace"), timeoutMs: 5000 },
      "sid-2",
      "T",
    );
    expect(result.answer).toBeUndefined();
    expect(result.error).toMatch(/^claude failed:/);
  });

  it("times out if the binary hangs past timeoutMs", async () => {
    const harness = createHarness("claude");
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-claude-"));
    process.env.FAKE_CLAUDE_MODE = "hang";
    const start = Date.now();
    const result = await harness.runTask(
      { binary: CLAUDE_FIXTURE, workspaceDir: path.join(dir, "workspace"), timeoutMs: 250 },
      "sid-3",
      "T",
    );
    expect(Date.now() - start).toBeLessThan(3000);
    expect(result.error).toMatch(/timed out after 250ms/);
  });
});

describe("CodexHarness", () => {
  it("createSession returns a uuid without invoking codex", async () => {
    const harness = createHarness("codex");
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-codex-"));
    const session = await harness.createSession({
      binary: CODEX_FIXTURE,
      workspaceDir: path.join(dir, "workspace"),
      timeoutMs: 5000,
    });
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("runTask uses `exec resume <sid>` and forwards CODEX_SESSION_ID via env", async () => {
    const harness = createHarness("codex");
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-codex-"));
    const logFile = path.join(dir, "args.log");
    process.env.FAKE_CODEX_LOG = logFile;
    process.env.FAKE_CODEX_ANSWER = "codex-answer";
    const result = await harness.runTask(
      { binary: CODEX_FIXTURE, workspaceDir: path.join(dir, "workspace"), timeoutMs: 5000 },
      "codex-sid",
      "TASK",
    );
    expect(result).toEqual({ answer: "codex-answer" });
    const log = readFileSync(logFile, "utf8");
    const lines = log.trimEnd().split("\n");
    expect(lines.slice(0, 3)).toEqual(["exec", "resume", "codex-sid"]);
    expect(lines).toContain("workspace-write");
    expect(log).toContain("CODEX_SESSION_ID=codex-sid");
  });
});
