import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonConfig } from "../src/config.js";
import { ConversationStore } from "../src/conversations.js";
import { createHandler } from "../src/handler.js";
import type { Harness, HarnessOptions, HarnessResult } from "../src/harness.js";
import { pausePeer } from "../src/paused.js";
import type { Question } from "../src/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "fixtures/fake-cursor-agent.sh");

function makeConfig(dir: string): DaemonConfig {
  return {
    relay_url: "https://relay.test",
    self_peer: "work",
    token: "tok",
    memory_sources: {
      transcripts_glob: path.join(dir, "none/*.jsonl"),
      agents_md_roots: [],
      extra_files: [],
    },
    responder: {
      cursor_agent_binary: FIXTURE,
      workspace_dir: path.join(dir, "workspace"),
      response_timeout_seconds: 30,
    },
  };
}

function writePolicy(dir: string, contents = "test policy"): string {
  const p = path.join(dir, "policy.md");
  writeFileSync(p, contents);
  return p;
}

function question(overrides: Partial<Question> = {}): Question {
  return {
    ticket_id: "t-1",
    from_peer: "personal",
    question: "hi",
    conversation_id: "conv-1",
    hops: 0,
    created_at: 0,
    deadline: 1,
    ...overrides,
  };
}

const SAVED_ENV_KEYS = ["FAKE_AGENT_LOG", "FAKE_AGENT_MODE", "FAKE_AGENT_ANSWER", "DOUCOPY_PAUSED_FILE"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.DOUCOPY_PAUSED_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "doucopy-paused-")),
    "paused.json",
  );
});

afterEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("createHandler", () => {
  it("does not bind the conversation to a chat when the run fails, so a retry starts a fresh first turn", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-handler-"));
    const logFile = path.join(dir, "args.log");
    process.env.FAKE_AGENT_LOG = logFile;
    process.env.FAKE_AGENT_MODE = "fail";

    const config = makeConfig(dir);
    const store = new ConversationStore(path.join(dir, "conversations.json"));
    const handler = createHandler(config, store, "test policy");

    const first = await handler(question());
    expect(first.error).toBeTruthy();
    expect(store.get("conv-1")).toBeNull();

    process.env.FAKE_AGENT_MODE = "ok";
    const second = await handler(question());
    expect(second.answer).toBe("STUB ANSWER");
    expect(store.get("conv-1")).toBe("chat-123");

    const logLines = readFileSync(logFile, "utf8").trimEnd().split("\n");
    const createChatCalls = logLines.filter((line) => line === "create-chat");
    expect(createChatCalls).toHaveLength(2);

    const taskMd = readFileSync(
      path.join(config.responder.workspace_dir, "conv-1", "task.md"),
      "utf8",
    );
    expect(taskMd).toContain("Memory sources");
  });

  it("keeps two conversations in separate workspace directories", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-handler-"));
    process.env.FAKE_AGENT_MODE = "ok";
    const config = makeConfig(dir);
    const store = new ConversationStore(path.join(dir, "conversations.json"));
    const handler = createHandler(config, store, "test policy");
    await handler(question({ conversation_id: "conv-a" }));
    await handler(question({ conversation_id: "conv-b" }));
    expect(
      readFileSync(path.join(config.responder.workspace_dir, "conv-a", "task.md"), "utf8"),
    ).toContain("Memory sources");
    expect(
      readFileSync(path.join(config.responder.workspace_dir, "conv-b", "task.md"), "utf8"),
    ).toContain("Memory sources");
  });

  it("returns a paused error without running cursor-agent when the asker is paused", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-handler-"));
    const logFile = path.join(dir, "args.log");
    process.env.FAKE_AGENT_LOG = logFile;
    process.env.FAKE_AGENT_MODE = "ok";
    pausePeer("personal", null);

    const config = makeConfig(dir);
    const store = new ConversationStore(path.join(dir, "conversations.json"));
    const handler = createHandler(config, store, "test policy");
    const result = await handler(question());
    expect(result.error).toMatch(/^peer paused/);
    expect(result.answer).toBeUndefined();
    expect(existsSync(logFile)).toBe(false);
  });

  it("uses the injected harness across a two-turn dialog (first task then follow-up)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-handler-"));
    interface Call { kind: "first" | "followup"; opts: HarnessOptions; sessionId?: string; task: string }
    const calls: Call[] = [];
    const fake: Harness = {
      kind: "cursor-agent",
      async runFirstTask(opts, task): Promise<HarnessResult> {
        calls.push({ kind: "first", opts, task });
        return { answer: "first-answer", sessionId: "sess-abc" };
      },
      async runFollowupTask(opts, sessionId, task): Promise<HarnessResult> {
        calls.push({ kind: "followup", opts, sessionId, task });
        return { answer: "followup-answer" };
      },
    };
    const config = makeConfig(dir);
    const store = new ConversationStore(path.join(dir, "conversations.json"));
    const handler = createHandler(config, store, "test policy", fake);

    const first = await handler(question());
    expect(first.answer).toBe("first-answer");
    expect(store.get("conv-1")).toBe("sess-abc");

    const followup = await handler(question({ ticket_id: "t-2", question: "and then?" }));
    expect(followup.answer).toBe("followup-answer");
    expect(store.get("conv-1")).toBe("sess-abc");

    expect(calls.map((c) => c.kind)).toEqual(["first", "followup"]);
    expect(calls[0].task).toContain("Memory sources");
    expect(calls[1].sessionId).toBe("sess-abc");
    expect(calls[1].task).toContain("Follow-up question in the same conversation");
  });

  it("does not persist a session id when the injected harness returns an error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-handler-"));
    const fake: Harness = {
      kind: "cursor-agent",
      async runFirstTask(): Promise<HarnessResult> {
        return { error: "boom" };
      },
      async runFollowupTask(): Promise<HarnessResult> {
        throw new Error("should not be called");
      },
    };
    const config = makeConfig(dir);
    const store = new ConversationStore(path.join(dir, "conversations.json"));
    const handler = createHandler(config, store, "test policy", fake);
    const result = await handler(question());
    expect(result.error).toBe("boom");
    expect(store.get("conv-1")).toBeNull();
  });

  it("picks up new `## Never reveal` items from policy.md without a restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-handler-"));
    const policyPath = writePolicy(dir, "You are a responder.\n");
    process.env.FAKE_AGENT_ANSWER = "trace: BetaCorp, Gamma";
    const config = makeConfig(dir);
    const store = new ConversationStore(path.join(dir, "conversations.json"));
    const handler = createHandler(config, store, policyPath);

    const first = await handler(question());
    expect(first.answer).toBe("trace: BetaCorp, Gamma");

    writeFileSync(policyPath, "## Never reveal\n\n- BetaCorp\n- /Gamm[a-z]/\n");
    process.env.FAKE_AGENT_ANSWER = "trace: BetaCorp, Gamma";
    const second = await handler(question({ ticket_id: "t-2", conversation_id: "conv-2" }));
    expect(second.answer).toBe("trace: [redacted], [redacted]");
  });

  it("merges legacy config.redact with policy.md Never reveal", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-handler-"));
    const policyPath = writePolicy(dir, "## Never reveal\n\n- Zeta\n");
    process.env.FAKE_AGENT_ANSWER = "we used Acme Corp and Zeta together";
    const config = makeConfig(dir);
    config.redact = { literals: ["Acme Corp"] };
    const store = new ConversationStore(path.join(dir, "conversations.json"));
    const handler = createHandler(config, store, policyPath);
    const result = await handler(question());
    expect(result.answer).toBe("we used [redacted] and [redacted] together");
  });

  it("redacts configured literals and built-in secrets from the outgoing answer", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-handler-"));
    process.env.FAKE_AGENT_ANSWER =
      "I worked on Acme Corp with key sk-abcdefghij0123456789 last quarter.";

    const config = makeConfig(dir);
    config.redact = { literals: ["Acme Corp"] };
    const store = new ConversationStore(path.join(dir, "conversations.json"));
    const handler = createHandler(config, store, "test policy");

    const result = await handler(question());
    expect(result.answer).toBe("I worked on [redacted] with key [redacted] last quarter.");
  });
});
