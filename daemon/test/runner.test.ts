import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createChat, runTask, type RunnerOptions } from "../src/runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "fixtures/fake-cursor-agent.sh");

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

afterEach(() => {
  delete process.env.FAKE_AGENT_LOG;
  delete process.env.FAKE_AGENT_MODE;
});

describe("createChat", () => {
  it("returns the chat id printed by the binary", async () => {
    await expect(createChat(makeOpts())).resolves.toBe("chat-123");
  });
});

describe("runTask", () => {
  it("writes task.md and passes the expected flags", async () => {
    const opts = makeOpts();
    process.env.FAKE_AGENT_LOG = opts.logFile;
    const result = await runTask(opts, "chat-123", "# task body");
    expect(result).toEqual({ answer: "STUB ANSWER" });
    expect(readFileSync(path.join(opts.workspaceDir, "task.md"), "utf8")).toBe("# task body");
    const args = readFileSync(opts.logFile, "utf8");
    expect(args).toContain("--resume chat-123");
    expect(args).toContain("--trust");
    expect(args).toContain("--force");
    expect(args).toContain("--output-format text");
    expect(args).toContain("--model test-model");
    expect(args).toContain(`--workspace ${opts.workspaceDir}`);
  });

  it("returns an error when the binary exits nonzero", async () => {
    const opts = makeOpts();
    process.env.FAKE_AGENT_MODE = "fail";
    const result = await runTask(opts, "chat-123", "# task body");
    expect(result.error).toMatch(/cursor-agent failed/);
  });

  it("returns an error when the binary exceeds the timeout", async () => {
    const opts = makeOpts();
    opts.timeoutMs = 500;
    process.env.FAKE_AGENT_MODE = "hang";
    const result = await runTask(opts, "chat-123", "# task body");
    expect(result.error).toMatch(/cursor-agent failed/);
  }, 10_000);
});
