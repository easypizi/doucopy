import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenService } from "../../relay/src/auth.js";
import { buildApp } from "../../relay/src/index.js";
import type { DaemonConfig } from "../src/config.js";
import { ConversationStore } from "../src/conversations.js";
import { createHandler } from "../src/handler.js";
import { Poller } from "../src/poller.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "fixtures/fake-cursor-agent.sh");

function toolPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

async function waitForPeerOnline(client: Client, peerName: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: "list_peers", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const peers = JSON.parse(content[0].text) as Array<{ name: string; online: boolean }>;
    if (peers.some((peer) => peer.name === peerName && peer.online)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Peer "${peerName}" did not come online within ${timeoutMs}ms`);
}

describe("full cycle: MCP ask_peer -> daemon -> answer", () => {
  const SECRET = "e2e-secret-0123456789abcdef";
  const tokens = createTokenService(SECRET);
  const personalToken = tokens.issuePeerToken("personal");
  const workToken = tokens.issuePeerToken("work");
  const app = buildApp({ RELAY_SECRET: SECRET } as NodeJS.ProcessEnv);
  let baseUrl: string;
  let pollerRunPromise: Promise<void>;
  let logFile: string;
  let workspaceDir: string;
  const abort = new AbortController();
  const savedFakeAgentLog = process.env.FAKE_AGENT_LOG;

  beforeAll(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-e2e-"));
    logFile = path.join(dir, "args.log");
    process.env.FAKE_AGENT_LOG = logFile;
    workspaceDir = path.join(dir, "workspace");
    const config: DaemonConfig = {
      relay_url: baseUrl,
      self_peer: "work",
      token: workToken,
      memory_sources: {
        transcripts_glob: path.join(dir, "none/*.jsonl"),
        agents_md_roots: [],
        extra_files: [],
      },
      responder: {
        cursor_agent_binary: FIXTURE,
        workspace_dir: workspaceDir,
        response_timeout_seconds: 30,
      },
    };
    const store = new ConversationStore(path.join(dir, "conversations.json"));
    const poller = new Poller(config, createHandler(config, store, "test policy"));
    pollerRunPromise = poller.run(abort.signal);
  });

  afterAll(async () => {
    abort.abort();
    await pollerRunPromise;
    await app.close();
    if (savedFakeAgentLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = savedFakeAgentLog;
  });

  it("answers a question end to end and keeps the conversation id", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${personalToken}` } },
    });
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);

    try {
      await waitForPeerOnline(client, "work");

      const parsed = toolPayload(
        await client.callTool({
          name: "ask_peer",
          arguments: { peer: "work", question: "what do you know about me?", timeout_seconds: 30 },
        }),
      );
      expect(parsed.status).toBe("answered");
      expect(parsed.answer).toBe("STUB ANSWER");
      expect(parsed.conversation_id).toBeTruthy();

      const followupParsed = toolPayload(
        await client.callTool({
          name: "ask_peer",
          arguments: {
            peer: "work",
            question: "and more?",
            timeout_seconds: 30,
            conversation_id: parsed.conversation_id,
          },
        }),
      );
      expect(followupParsed.status).toBe("answered");
      expect(followupParsed.answer).toBe("STUB ANSWER");
      expect(followupParsed.conversation_id).toBe(parsed.conversation_id);

      const logLines = readFileSync(logFile, "utf8").trimEnd().split("\n");
      const createChatLines = logLines.filter((line) => line === "create-chat");
      expect(createChatLines).toHaveLength(1);
      const resumeIndexes = logLines.flatMap((line, i) => (line === "--resume" ? [i] : []));
      expect(resumeIndexes).toHaveLength(2);
      for (const i of resumeIndexes) expect(logLines[i + 1]).toBe("chat-123");

      const convDirs = readdirSync(workspaceDir);
      expect(convDirs.length).toBeGreaterThan(0);
      const taskMd = readFileSync(path.join(workspaceDir, convDirs[0], "task.md"), "utf8");
      expect(taskMd).not.toContain("Memory sources");
    } finally {
      await client.close();
    }
  }, 30_000);
});
