import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonConfig } from "../src/config.js";
import { ConversationStore } from "../src/conversations.js";
import { createHandler } from "../src/handler.js";
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

const SAVED_ENV_KEYS = ["FAKE_AGENT_LOG", "FAKE_AGENT_MODE", "FAKE_AGENT_ANSWER", "AGENT_LINK_PAUSED_FILE"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.AGENT_LINK_PAUSED_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "agent-link-paused-")),
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
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-handler-"));
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
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-handler-"));
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
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-handler-"));
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

  it("redacts configured literals and built-in secrets from the outgoing answer", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-handler-"));
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
