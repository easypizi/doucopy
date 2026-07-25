import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChat, runTask, type RunnerOptions } from "../src/runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "fixtures/fake-cursor-agent.sh");
const TASK_INSTRUCTION =
  "Read the file task.md in this workspace and follow the instructions in it.";

function makeOpts(): RunnerOptions & { logFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-link-run-"));
  return {
    binary: FIXTURE,
    workspaceDir: path.join(dir, "workspace"),
    timeoutMs: 5000,
    model: "test-model",
    logFile: path.join(dir, "args.log"),
  };
}

let savedFakeAgentLog: string | undefined;
let savedFakeAgentMode: string | undefined;

beforeEach(() => {
  savedFakeAgentLog = process.env.FAKE_AGENT_LOG;
  savedFakeAgentMode = process.env.FAKE_AGENT_MODE;
});

afterEach(() => {
  if (savedFakeAgentLog === undefined) {
    delete process.env.FAKE_AGENT_LOG;
  } else {
    process.env.FAKE_AGENT_LOG = savedFakeAgentLog;
  }
  if (savedFakeAgentMode === undefined) {
    delete process.env.FAKE_AGENT_MODE;
  } else {
    process.env.FAKE_AGENT_MODE = savedFakeAgentMode;
  }
});

describe("createChat", () => {
  it("returns the chat id printed by the binary", async () => {
    await expect(createChat(makeOpts())).resolves.toBe("chat-123");
  });

  it("rejects when create-chat returns empty output", async () => {
    process.env.FAKE_AGENT_MODE = "empty";
    await expect(createChat(makeOpts())).rejects.toThrow(/empty chat id/);
  });

  it("returns the chat id and kills the process when create-chat prints then hangs", async () => {
    process.env.FAKE_AGENT_MODE = "create-chat-hang";
    const started = Date.now();
    await expect(createChat(makeOpts())).resolves.toBe("chat-123");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("runTask", () => {
  it("writes task.md and passes the expected flags", async () => {
    const opts = makeOpts();
    process.env.FAKE_AGENT_LOG = opts.logFile;
    const result = await runTask(opts, "chat-123", "# task body");
    expect(result).toEqual({ answer: "STUB ANSWER" });
    expect(readFileSync(path.join(opts.workspaceDir, "task.md"), "utf8")).toBe("# task body");
    const args = readFileSync(opts.logFile, "utf8").trimEnd().split("\n");
    expect(args).toEqual([
      "--resume",
      "chat-123",
      "-p",
      TASK_INSTRUCTION,
      "--output-format",
      "text",
      "--trust",
      "--force",
      "--workspace",
      opts.workspaceDir,
      "--model",
      "test-model",
    ]);
  });

  it("returns empty-output error when the binary prints nothing", async () => {
    process.env.FAKE_AGENT_MODE = "empty";
    const result = await runTask(makeOpts(), "chat-123", "# task body");
    expect(result).toEqual({ error: "responder produced empty output" });
  });

  it("returns an error when the binary exits nonzero", async () => {
    const opts = makeOpts();
    process.env.FAKE_AGENT_MODE = "fail";
    const result = await runTask(opts, "chat-123", "# task body");
    expect(result.error).toMatch(/cursor-agent failed/);
    expect(result.error!.length).toBeLessThanOrEqual("cursor-agent failed: ".length + 500);
    expect(result).not.toHaveProperty("answer");
  });

  it("returns an error when the binary exceeds the timeout", async () => {
    const opts = makeOpts();
    opts.timeoutMs = 500;
    process.env.FAKE_AGENT_MODE = "hang";
    const started = Date.now();
    const result = await runTask(opts, "chat-123", "# task body");
    expect(result.error).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it("still returns the answer when a grandchild keeps the stdio pipes open", async () => {
    const opts = makeOpts();
    process.env.FAKE_AGENT_MODE = "grandchild-hang";
    const started = Date.now();
    const result = await runTask(opts, "chat-123", "# task body");
    expect(result).toEqual({ answer: "STUB ANSWER" });
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);
});
