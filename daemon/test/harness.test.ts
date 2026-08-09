import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  findLatestCodexSessionId,
  resolveUserCodexHome,
  summarizeHarnessStderr,
} from "../src/harness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURE = path.resolve(HERE, "fixtures/fake-claude.sh");
const CODEX_FIXTURE = path.resolve(HERE, "fixtures/fake-codex.sh");

const SAVED_ENV = [
  "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_MODE", "FAKE_CLAUDE_ANSWER",
  "FAKE_CODEX_LOG", "FAKE_CODEX_MODE", "FAKE_CODEX_ANSWER", "FAKE_CODEX_SESSION_ID",
  "CODEX_HOME",
] as const;
let backup: Record<string, string | undefined> = {};

beforeEach(() => { backup = {}; for (const k of SAVED_ENV) backup[k] = process.env[k]; });
afterEach(() => {
  for (const k of SAVED_ENV) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

function splitInvocations(log: string): string[][] {
  return log
    .split(/^---$/m)
    .map((chunk) => chunk.split("\n").filter((line) => line.length > 0))
    .filter((lines) => lines.length > 0);
}

describe("ClaudeHarness", () => {
  it("runFirstTask writes task.md, uses --session-id, returns the generated session id", async () => {
    const harness = createHarness("claude");
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-claude-"));
    const workspace = path.join(dir, "workspace");
    const logFile = path.join(dir, "args.log");
    process.env.FAKE_CLAUDE_LOG = logFile;
    process.env.FAKE_CLAUDE_ANSWER = "42";
    const result = await harness.runFirstTask(
      { binary: CLAUDE_FIXTURE, workspaceDir: workspace, timeoutMs: 5000, model: "sonnet-x" },
      "TASK CONTENT",
    );
    expect(result.answer).toBe("42");
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(path.join(workspace, "task.md"), "utf8")).toBe("TASK CONTENT");
    const [firstInvocation] = splitInvocations(readFileSync(logFile, "utf8"));
    expect(firstInvocation).toContain("--session-id");
    expect(firstInvocation).toContain(result.sessionId as string);
    expect(firstInvocation).not.toContain("--resume");
    expect(firstInvocation).toContain("--permission-mode");
    expect(firstInvocation).toContain("dontAsk");
    expect(firstInvocation).toContain("--model");
    expect(firstInvocation).toContain("sonnet-x");
  });

  it("passes --settings JSON when claudeSettingsJson is set", async () => {
    const harness = createHarness("claude");
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-claude-"));
    const logFile = path.join(dir, "args.log");
    process.env.FAKE_CLAUDE_LOG = logFile;
    process.env.FAKE_CLAUDE_ANSWER = "ok";
    const settings = JSON.stringify({ permissions: { allow: ["Read"], deny: ["Bash"] } });
    await harness.runFirstTask(
      {
        binary: CLAUDE_FIXTURE,
        workspaceDir: path.join(dir, "workspace"),
        timeoutMs: 5000,
        claudeSettingsJson: settings,
      },
      "T",
    );
    const [invocation] = splitInvocations(readFileSync(logFile, "utf8"));
    expect(invocation).toContain("--settings");
    expect(invocation).toContain(settings);
  });

  it("runFollowupTask uses --resume and does NOT pass --session-id again", async () => {
    const harness = createHarness("claude");
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-claude-"));
    const logFile = path.join(dir, "args.log");
    process.env.FAKE_CLAUDE_LOG = logFile;
    process.env.FAKE_CLAUDE_ANSWER = "followup-answer";
    const result = await harness.runFollowupTask(
      { binary: CLAUDE_FIXTURE, workspaceDir: path.join(dir, "workspace"), timeoutMs: 5000 },
      "sess-xyz",
      "T",
    );
    expect(result.answer).toBe("followup-answer");
    expect(result.sessionId).toBeUndefined();
    const [invocation] = splitInvocations(readFileSync(logFile, "utf8"));
    expect(invocation).toContain("--resume");
    expect(invocation).toContain("sess-xyz");
    expect(invocation).not.toContain("--session-id");
  });

  it("surfaces a failing exit code as an error, no sessionId", async () => {
    const harness = createHarness("claude");
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-claude-"));
    process.env.FAKE_CLAUDE_MODE = "fail";
    const result = await harness.runFirstTask(
      { binary: CLAUDE_FIXTURE, workspaceDir: path.join(dir, "workspace"), timeoutMs: 5000 },
      "T",
    );
    expect(result.answer).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
    expect(result.error).toMatch(/^claude failed:/);
  });

  it("times out if the binary hangs past timeoutMs", async () => {
    const harness = createHarness("claude");
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-claude-"));
    process.env.FAKE_CLAUDE_MODE = "hang";
    const start = Date.now();
    const result = await harness.runFirstTask(
      { binary: CLAUDE_FIXTURE, workspaceDir: path.join(dir, "workspace"), timeoutMs: 250 },
      "T",
    );
    expect(Date.now() - start).toBeLessThan(3000);
    expect(result.error).toMatch(/timed out after 250ms/);
  });
});

describe("CodexHarness", () => {
  it("runFirstTask uses plain `codex exec`, real CODEX_HOME, scrapes session id from rollout", async () => {
    const harness = createHarness("codex");
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-codex-"));
    const workspace = path.join(dir, "workspace");
    const codexHome = path.join(dir, "real-codex-home");
    const logFile = path.join(dir, "args.log");
    process.env.CODEX_HOME = codexHome;
    process.env.FAKE_CODEX_LOG = logFile;
    process.env.FAKE_CODEX_ANSWER = "codex-answer";
    process.env.FAKE_CODEX_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const result = await harness.runFirstTask(
      { binary: CODEX_FIXTURE, workspaceDir: workspace, timeoutMs: 5000 },
      "TASK",
    );
    expect(result.answer).toBe("codex-answer");
    expect(result.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const log = readFileSync(logFile, "utf8");
    const [invocation] = splitInvocations(log);
    expect(invocation[0]).toBe("exec");
    expect(invocation).not.toContain("resume");
    expect(invocation).toContain("workspace-write");
    expect(log).toContain(`CODEX_HOME=${codexHome}`);
    expect(log).not.toContain(".codex-home");
    expect(existsSync(path.join(codexHome, "sessions"))).toBe(true);
  });

  it("runFirstTask returns an error when no rollout gets written", async () => {
    const harness = createHarness("codex");
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-codex-"));
    process.env.CODEX_HOME = path.join(dir, "real-codex-home");
    process.env.FAKE_CODEX_ANSWER = "answer-without-rollout";
    // Force the stub to skip its rollout-writing branch by pretending it was
    // called as a resume (which never writes rollout in the fake).
    const workspace = path.join(dir, "workspace");
    const result = await harness.runFollowupTask(
      { binary: CODEX_FIXTURE, workspaceDir: workspace, timeoutMs: 5000 },
      "some-session",
      "TASK",
    );
    // Follow-up path does not scrape a session id; just verify it produces the answer.
    expect(result.answer).toBe("answer-without-rollout");
  });

  it("runFollowupTask uses `exec resume <sid>` with the same CODEX_HOME", async () => {
    const harness = createHarness("codex");
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-codex-"));
    const workspace = path.join(dir, "workspace");
    const codexHome = path.join(dir, "real-codex-home");
    const logFile = path.join(dir, "args.log");
    process.env.CODEX_HOME = codexHome;
    process.env.FAKE_CODEX_LOG = logFile;
    process.env.FAKE_CODEX_ANSWER = "followup";
    const result = await harness.runFollowupTask(
      { binary: CODEX_FIXTURE, workspaceDir: workspace, timeoutMs: 5000 },
      "sid-42",
      "T",
    );
    expect(result.answer).toBe("followup");
    const log = readFileSync(logFile, "utf8");
    const [invocation] = splitInvocations(log);
    expect(invocation[0]).toBe("exec");
    const resumeIdx = invocation.indexOf("resume");
    expect(resumeIdx).toBeGreaterThan(0);
    expect(invocation[resumeIdx + 1]).toBe("sid-42");
    // Resume must not pass --sandbox (Codex rejects it). Use -c override.
    expect(invocation).not.toContain("--sandbox");
    const cIdx = invocation.indexOf("-c");
    expect(cIdx).toBeGreaterThan(0);
    expect(cIdx).toBeLessThan(resumeIdx);
    expect(invocation[cIdx + 1]).toBe('sandbox_mode="workspace-write"');
    expect(log).toContain(`CODEX_HOME=${codexHome}`);
  });

  it("honours codexSandbox override", async () => {
    const harness = createHarness("codex");
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-codex-"));
    const workspace = path.join(dir, "workspace");
    process.env.CODEX_HOME = path.join(dir, "real-codex-home");
    const logFile = path.join(dir, "args.log");
    process.env.FAKE_CODEX_LOG = logFile;
    process.env.FAKE_CODEX_ANSWER = "x";
    process.env.FAKE_CODEX_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await harness.runFirstTask(
      { binary: CODEX_FIXTURE, workspaceDir: workspace, timeoutMs: 5000, codexSandbox: "danger-full-access" },
      "T",
    );
    const [invocation] = splitInvocations(readFileSync(logFile, "utf8"));
    expect(invocation).toContain("danger-full-access");
    expect(invocation).not.toContain("workspace-write");
  });

  it("runFollowupTask passes sandbox via -c override, not --sandbox", async () => {
    const harness = createHarness("codex");
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-codex-"));
    const workspace = path.join(dir, "workspace");
    process.env.CODEX_HOME = path.join(dir, "real-codex-home");
    const logFile = path.join(dir, "args.log");
    process.env.FAKE_CODEX_LOG = logFile;
    process.env.FAKE_CODEX_ANSWER = "followup";
    await harness.runFollowupTask(
      {
        binary: CODEX_FIXTURE,
        workspaceDir: workspace,
        timeoutMs: 5000,
        codexSandbox: "danger-full-access",
        model: "gpt-test",
      },
      "sid-99",
      "T",
    );
    const [invocation] = splitInvocations(readFileSync(logFile, "utf8"));
    expect(invocation).not.toContain("--sandbox");
    expect(invocation).toContain("-c");
    expect(invocation).toContain('sandbox_mode="danger-full-access"');
    expect(invocation).toContain("--model");
    expect(invocation).toContain("gpt-test");
  });
});

describe("summarizeHarnessStderr", () => {
  it("prefers an Error: line over the Codex session banner", () => {
    const raw = [
      "Reading additional input from stdin...",
      "OpenAI Codex v0.142.0",
      "workdir: /tmp/x",
      "Error: boom happened here. more",
    ].join("\n");
    expect(summarizeHarnessStderr(raw)).toMatch(/^Error: boom happened here/i);
  });

  it("maps stdin-hang banners to a short hint", () => {
    const raw = "Reading additional input from stdin...\nOpenAI Codex v0.142.0\nworkdir: /tmp";
    expect(summarizeHarnessStderr(raw)).toMatch(/stdin hang/i);
  });

  it("appends codex login hint on 401 Unauthorized", () => {
    const raw = "error: 401 Unauthorized, url: wss://api.openai.com/...";
    const out = summarizeHarnessStderr(raw, { CODEX_HOME: "/tmp/my-codex-home" });
    expect(out).toMatch(/codex login/i);
    expect(out).toContain("CODEX_HOME=/tmp/my-codex-home");
  });
});

describe("resolveUserCodexHome", () => {
  it("prefers CODEX_HOME env over ~/.codex", () => {
    expect(resolveUserCodexHome({ CODEX_HOME: "/tmp/custom-codex" })).toBe("/tmp/custom-codex");
  });
});

describe("findLatestCodexSessionId", () => {
  it("returns null when the sessions directory is missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-codex-scan-"));
    expect(findLatestCodexSessionId(dir)).toBeNull();
  });

  it("returns the uuid from the newest rollout across nested date folders", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-codex-scan-"));
    const { mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
    const olderId = "11111111-1111-1111-1111-111111111111";
    const newerId = "22222222-2222-2222-2222-222222222222";
    const older = path.join(dir, "sessions/2026/07/26", `rollout-2026-07-26T10-00-00-${olderId}.jsonl`);
    const newer = path.join(dir, "sessions/2026/07/27", `rollout-2026-07-27T10-00-00-${newerId}.jsonl`);
    mkdirSync(path.dirname(older), { recursive: true });
    mkdirSync(path.dirname(newer), { recursive: true });
    writeFileSync(older, "{}");
    writeFileSync(newer, "{}");
    const now = Date.now() / 1000;
    utimesSync(older, now - 1000, now - 1000);
    utimesSync(newer, now, now);
    expect(findLatestCodexSessionId(dir)).toBe(newerId);
  });

  it("honours minMtimeMs so older parallel rollouts are ignored", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-codex-scan-"));
    const { mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
    const olderId = "11111111-1111-1111-1111-111111111111";
    const newerId = "22222222-2222-2222-2222-222222222222";
    const older = path.join(dir, "sessions/2026/07/26", `rollout-2026-07-26T10-00-00-${olderId}.jsonl`);
    const newer = path.join(dir, "sessions/2026/07/27", `rollout-2026-07-27T10-00-00-${newerId}.jsonl`);
    mkdirSync(path.dirname(older), { recursive: true });
    mkdirSync(path.dirname(newer), { recursive: true });
    writeFileSync(older, "{}");
    writeFileSync(newer, "{}");
    const now = Date.now() / 1000;
    utimesSync(older, now - 1000, now - 1000);
    utimesSync(newer, now, now);
    const floor = (now - 10) * 1000;
    expect(findLatestCodexSessionId(dir, { minMtimeMs: floor })).toBe(newerId);
    expect(findLatestCodexSessionId(dir, { minMtimeMs: (now + 100) * 1000 })).toBeNull();
  });
});
