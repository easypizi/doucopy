import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Mailbox } from "./mailbox.js";

const KEEPALIVE_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 240;

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export interface BuildMcpServerOptions {
  keepaliveIntervalMs?: number;
}

export function buildMcpServer(
  mailbox: Mailbox,
  fromPeer: string,
  options?: BuildMcpServerOptions,
): McpServer {
  const keepaliveIntervalMs = options?.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
  const server = new McpServer(
    { name: "agent-link", version: "2.0.0" },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    "list_peers",
    {
      description: "List peers you can ask and whether their responder daemon is online.",
      inputSchema: {},
    },
    async () =>
      json(
        mailbox
          .knownPeers()
          .filter((name) => name !== fromPeer)
          .map((name) => ({ name, online: mailbox.isOnline(name) })),
      ),
  );

  server.registerTool(
    "ask_peer",
    {
      description:
        "Ask another account's agent a question. It answers from its own memory (chat history, notes). " +
        "Pass conversation_id from a previous result to continue the same conversation. " +
        "If status is pending or peer_offline, fetch the answer later with check_reply. " +
        "Peers that are offline or unknown still get the question queued for 24 hours.",
      inputSchema: {
        peer: z.string().describe("Peer name from list_peers"),
        question: z.string(),
        timeout_seconds: z.number().int().positive().optional(),
        conversation_id: z.string().optional(),
      },
    },
    async ({ peer, question, timeout_seconds, conversation_id }, extra) => {
      if (peer === fromPeer) {
        return json({ status: "error", error: "cannot ask yourself" });
      }
      const { ticket_id, conversation_id: convId } = mailbox.enqueue(
        peer,
        fromPeer,
        question,
        conversation_id,
      );
      if (!mailbox.isOnline(peer)) {
        return json({ status: "peer_offline", ticket_id, conversation_id: convId });
      }
      const timeoutMs = Math.min(timeout_seconds ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S) * 1000;
      // Heroku's router kills silent connections after 30s, so ping the SSE stream while waiting.
      let keepaliveFailureLogged = false;
      const keepalive = setInterval(() => {
        void extra
          .sendNotification({
            method: "notifications/message",
            params: { level: "info", data: "waiting for peer answer" },
          })
          .catch((err) => {
            if (keepaliveFailureLogged) return;
            keepaliveFailureLogged = true;
            console.error("ask_peer keepalive notification failed:", err);
          });
      }, keepaliveIntervalMs);
      try {
        const result = await mailbox.waitForAnswer(ticket_id, timeoutMs, extra.signal);
        return json({ ...result, ticket_id, conversation_id: convId });
      } finally {
        clearInterval(keepalive);
      }
    },
  );

  server.registerTool(
    "check_reply",
    {
      description: "Fetch a delayed answer using the ticket_id returned earlier by ask_peer.",
      inputSchema: { ticket_id: z.string() },
    },
    async ({ ticket_id }) => json({ ...mailbox.checkReply(ticket_id), ticket_id }),
  );

  return server;
}
