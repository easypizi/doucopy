import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadPeersFromEnv } from "../src/auth.js";
import { Mailbox } from "../src/mailbox.js";
import { buildMcpServer } from "../src/mcp.js";

function makeRegistry() {
  return loadPeersFromEnv({
    PEER_TOKEN_PERSONAL: "tok-personal",
    PEER_TOKEN_WORK: "tok-work",
  } as NodeJS.ProcessEnv);
}

async function connect(mailbox: Mailbox, fromPeer: string) {
  const server = buildMcpServer(mailbox, makeRegistry(), fromPeer);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("MCP tools", () => {
  it("list_peers excludes the caller and reports presence", async () => {
    const mailbox = new Mailbox();
    await mailbox.takeNext("work", 0);
    const client = await connect(mailbox, "personal");
    const result = payload(await client.callTool({ name: "list_peers", arguments: {} }));
    expect(result).toEqual([{ name: "work", online: true }]);
  });

  it("ask_peer returns peer_offline with a ticket when the peer never polled", async () => {
    const mailbox = new Mailbox();
    const client = await connect(mailbox, "personal");
    const result = payload(
      await client.callTool({ name: "ask_peer", arguments: { peer: "work", question: "hi" } }),
    );
    expect(result.status).toBe("peer_offline");
    expect(result.ticket_id).toBeTruthy();
    expect(result.conversation_id).toBeTruthy();
  });

  it("ask_peer rejects unknown peers", async () => {
    const mailbox = new Mailbox();
    const client = await connect(mailbox, "personal");
    const result = payload(
      await client.callTool({ name: "ask_peer", arguments: { peer: "nobody", question: "hi" } }),
    );
    expect(result.status).toBe("error");
  });

  it("ask_peer returns the answer once the daemon settles the ticket", async () => {
    const mailbox = new Mailbox();
    await mailbox.takeNext("work", 0);
    const client = await connect(mailbox, "personal");
    const asking = client.callTool({
      name: "ask_peer",
      arguments: { peer: "work", question: "hi", timeout_seconds: 5 },
    });
    const question = await mailbox.takeNext("work", 2000);
    expect(question?.question).toBe("hi");
    mailbox.settle(question!.ticket_id, { answer: "42" });
    const result = payload(await asking);
    expect(result.status).toBe("answered");
    expect(result.answer).toBe("42");
    expect(result.conversation_id).toBe(question!.conversation_id);
  });

  it("check_reply fetches a late answer", async () => {
    const mailbox = new Mailbox();
    const { ticket_id } = mailbox.enqueue("work", "personal", "hi");
    mailbox.settle(ticket_id, { answer: "late" });
    const client = await connect(mailbox, "personal");
    const result = payload(
      await client.callTool({ name: "check_reply", arguments: { ticket_id } }),
    );
    expect(result).toMatchObject({ status: "answered", answer: "late", ticket_id });
  });
});
