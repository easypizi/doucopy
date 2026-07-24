import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../relay/src/index.js";
import type { DaemonConfig } from "../src/config.js";
import { ConversationStore } from "../src/conversations.js";
import { createHandler } from "../src/handler.js";
import { Poller } from "../src/poller.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "fixtures/fake-cursor-agent.sh");

describe("full cycle: MCP ask_peer -> daemon -> answer", () => {
  const app = buildApp({
    PEER_TOKEN_PERSONAL: "tok-personal",
    PEER_TOKEN_WORK: "tok-work",
  } as NodeJS.ProcessEnv);
  let baseUrl: string;
  const abort = new AbortController();

  beforeAll(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-e2e-"));
    const config: DaemonConfig = {
      relay_url: baseUrl,
      self_peer: "work",
      token: "tok-work",
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
    const store = new ConversationStore(path.join(dir, "conversations.json"));
    const poller = new Poller(config, createHandler(config, store, "test policy"));
    void poller.run(abort.signal);
    // Let the daemon register presence with its first poll.
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    abort.abort();
    await app.close();
  });

  it("answers a question end to end and keeps the conversation id", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: "Bearer tok-personal" } },
    });
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "ask_peer",
      arguments: { peer: "work", question: "what do you know about me?", timeout_seconds: 30 },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(parsed.status).toBe("answered");
    expect(parsed.answer).toBe("STUB ANSWER");
    expect(parsed.conversation_id).toBeTruthy();

    const followup = await client.callTool({
      name: "ask_peer",
      arguments: {
        peer: "work",
        question: "and more?",
        timeout_seconds: 30,
        conversation_id: parsed.conversation_id,
      },
    });
    const followupContent = followup.content as Array<{ type: string; text: string }>;
    const followupParsed = JSON.parse(followupContent[0].text) as Record<string, unknown>;
    expect(followupParsed.status).toBe("answered");
    expect(followupParsed.conversation_id).toBe(parsed.conversation_id);

    await client.close();
  }, 30_000);
});
