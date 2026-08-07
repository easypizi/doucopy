import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConversationFullError, HopLimitError, MAX_HOPS, type Mailbox } from "./mailbox.js";

const KEEPALIVE_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 240;
const DEFAULT_CHECK_WAIT_S = 0;
const MAX_CHECK_WAIT_S = 240;

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export interface BuildMcpServerOptions {
  keepaliveIntervalMs?: number;
}

type ToolExtra = {
  signal: AbortSignal;
  sendNotification: (notification: {
    method: "notifications/message";
    params: { level: "info"; data: string };
  }) => Promise<void>;
};

function withKeepalive<T>(
  extra: ToolExtra,
  keepaliveIntervalMs: number,
  message: string,
  work: () => Promise<T>,
): Promise<T> {
  // Heroku's router kills silent connections after 30s, so ping the SSE stream while waiting.
  let keepaliveFailureLogged = false;
  const keepalive = setInterval(() => {
    void extra
      .sendNotification({
        method: "notifications/message",
        params: { level: "info", data: message },
      })
      .catch((err) => {
        if (keepaliveFailureLogged) return;
        keepaliveFailureLogged = true;
        console.error("MCP keepalive notification failed:", err);
      });
  }, keepaliveIntervalMs);
  return work().finally(() => clearInterval(keepalive));
}

export function buildMcpServer(
  mailbox: Mailbox,
  fromPeer: string,
  options?: BuildMcpServerOptions,
): McpServer {
  const keepaliveIntervalMs = options?.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
  const server = new McpServer(
    { name: "doucopy", version: "2.0.0" },
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
        "mode=discuss: collaborative multi-turn; reformulate as needed and pass brief instructions; " +
        "keep going until you can give the human a FINAL answer (do not dump intermediate chatter). " +
        "Hosts may abort long waits and return pending early — that is normal. " +
        "On pending or peer_offline, immediately call check_reply with wait_seconds (do not ask the user). " +
        "Peers that are offline or unknown still get the question queued for 24 hours. " +
        `Counter-questions: set hops=1 to ask a follow-up back to the asker inside the same conversation_id (max depth ${MAX_HOPS}).`,
      inputSchema: {
        peer: z.string().describe("Peer name from list_peers"),
        question: z.string(),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "First wait budget in seconds (default 120, max 240). Prefer 15 if the host often aborts long MCP calls, then finish with check_reply wait_seconds.",
          ),
        conversation_id: z.string().optional(),
        hops: z.number().int().min(0).max(MAX_HOPS).optional(),
        mode: z.enum(["ask", "discuss"]).optional().describe("ask (default) or discuss"),
        brief: z
          .string()
          .optional()
          .describe("Short instructions for the responding agent (discuss/ask). Not shown as the question."),
      },
    },
    async ({ peer, question, timeout_seconds, conversation_id, hops, mode, brief }, extra) => {
      if (peer === fromPeer) {
        return json({ status: "error", error: "cannot ask yourself" });
      }
      let ticket_id: string;
      let convId: string;
      try {
        ({ ticket_id, conversation_id: convId } = mailbox.enqueue(peer, fromPeer, question, {
          conversationId: conversation_id,
          clientHops: hops ?? 0,
          mode: mode === "discuss" ? "discuss" : "ask",
          brief,
        }));
      } catch (err) {
        if (err instanceof HopLimitError || err instanceof ConversationFullError) {
          return json({ status: "error", error: err.message });
        }
        throw err;
      }
      if (!mailbox.isOnline(peer)) {
        return json({ status: "peer_offline", ticket_id, conversation_id: convId });
      }
      const timeoutMs = Math.min(timeout_seconds ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S) * 1000;
      const result = await withKeepalive(
        extra,
        keepaliveIntervalMs,
        "waiting for peer answer",
        () => mailbox.waitForAnswer(ticket_id, timeoutMs, extra.signal),
      );
      return json({ ...result, ticket_id, conversation_id: convId });
    },
  );

  server.registerTool(
    "check_reply",
    {
      description:
        "Fetch a delayed answer using the ticket_id from ask_peer. " +
        "Pass wait_seconds (up to 240) to long-poll until answered/error/timeout. " +
        "On pending, call again with wait_seconds — do not ask the user whether to continue. " +
        "Omit wait_seconds (or 0) for a single non-blocking read.",
      inputSchema: {
        ticket_id: z.string(),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_CHECK_WAIT_S)
          .optional()
          .describe("Long-poll budget in seconds (default 0 = instant read, max 240)."),
      },
    },
    async ({ ticket_id, wait_seconds }, extra) => {
      const waitS = Math.min(wait_seconds ?? DEFAULT_CHECK_WAIT_S, MAX_CHECK_WAIT_S);
      if (waitS <= 0) {
        return json({ ...mailbox.checkReply(ticket_id), ticket_id });
      }
      const result = await withKeepalive(
        extra,
        keepaliveIntervalMs,
        "waiting for peer answer",
        () => mailbox.waitForAnswer(ticket_id, waitS * 1000, extra.signal),
      );
      return json({ ...result, ticket_id });
    },
  );

  return server;
}
