import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonConfig } from "../src/config.js";
import { ConversationStore } from "../src/conversations.js";
import { createHandler } from "../src/handler.js";
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
    created_at: 0,
    deadline: 1,
    ...overrides,
  };
}

let savedFakeAgentLog: string | undefined;
let savedFakeAgentMode: string | undefined;

beforeEach(() => {
  savedFakeAgentLog = process.env.FAKE_AGENT_LOG;
  savedFakeAgentMode = process.env.FAKE_AGENT_MODE;
});

afterEach(() => {
  if (savedFakeAgentLog === undefined) delete process.env.FAKE_AGENT_LOG;
  else process.env.FAKE_AGENT_LOG = savedFakeAgentLog;
  if (savedFakeAgentMode === undefined) delete process.env.FAKE_AGENT_MODE;
  else process.env.FAKE_AGENT_MODE = savedFakeAgentMode;
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

    const taskMd = readFileSync(path.join(config.responder.workspace_dir, "task.md"), "utf8");
    expect(taskMd).toContain("Memory sources");
  });
});
