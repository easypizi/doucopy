import type { FastifyInstance, FastifyRequest } from "fastify";
import { bearerToken, PEER_NAME_PATTERN, type TokenService } from "./auth.js";
import {
  AttachmentValidationError,
  ConversationFullError,
  HopLimitError,
  MAX_HOPS,
  type Mailbox,
} from "./mailbox.js";

const MAX_WAIT_SECONDS = 25;
const JOIN_WINDOW_MS = 60_000;
const JOIN_LIMIT_PER_WINDOW = 10;
const MAX_INVITE_TTL_HOURS = 720;
// The REST ask/reply pair is polling-based: an ask can request up to
// ASK_MAX_WAIT_SECONDS of synchronous waiting inside the request; anything
// beyond that must be picked up with /reply. Kept identical to /inbox so all
// HTTP endpoints behave consistently under Heroku's 30s router timeout.
const ASK_MAX_WAIT_SECONDS = 25;
const REPLY_MAX_WAIT_SECONDS = 25;

export function authPeer(req: FastifyRequest, tokens: TokenService): string | null {
  const token = bearerToken(req.headers.authorization);
  return token ? tokens.verifyPeerToken(token) : null;
}

export function registerRest(app: FastifyInstance, mailbox: Mailbox, tokens: TokenService): void {
  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { peer: string }; Querystring: { wait?: string } }>(
    "/inbox/:peer",
    async (req, reply) => {
      const peer = authPeer(req, tokens);
      if (!peer) return reply.code(401).send({ error: "unauthorized" });
      if (peer !== req.params.peer) return reply.code(403).send({ error: "wrong peer" });
      const requested = Number(req.query.wait ?? MAX_WAIT_SECONDS);
      const parsed = Number.isFinite(requested) ? requested : MAX_WAIT_SECONDS;
      const waitSeconds = Math.min(Math.max(parsed, 0), MAX_WAIT_SECONDS);
      const question = await mailbox.takeNext(peer, waitSeconds * 1000);
      if (!question) return reply.code(204).send();
      return question;
    },
  );

  app.post<{
    Body: {
      ticket_id?: string;
      answer?: string;
      error?: string;
      answered?: string;
      refused?: string;
    };
  }>("/answer", async (req, reply) => {
    const peer = authPeer(req, tokens);
    if (!peer) return reply.code(401).send({ error: "unauthorized" });
    const { ticket_id, answer, error, answered, refused } = req.body ?? {};
    if (!ticket_id) return reply.code(400).send({ error: "ticket_id required" });
    const ok = mailbox.settle(ticket_id, { answer, error, answered, refused }, peer);
    if (!ok) return reply.code(404).send({ error: "unknown_ticket" });
    return { ok: true };
  });

  app.post<{ Params: { ticket_id: string } }>("/ticket/:ticket_id/cancel", async (req, reply) => {
    const peer = authPeer(req, tokens);
    if (!peer) return reply.code(401).send({ error: "unauthorized" });
    const ok = mailbox.cancelByOwner(req.params.ticket_id, peer);
    if (!ok) return reply.code(404).send({ error: "unknown_ticket" });
    return { ok: true };
  });

  app.post<{ Params: { ticket_id: string }; Body: { answer?: string } }>(
    "/ticket/:ticket_id/answer",
    async (req, reply) => {
      const peer = authPeer(req, tokens);
      if (!peer) return reply.code(401).send({ error: "unauthorized" });
      const answer = req.body?.answer;
      if (!answer || typeof answer !== "string" || !answer.trim()) {
        return reply.code(400).send({ error: "answer required" });
      }
      const ok = mailbox.answerByOwner(req.params.ticket_id, peer, answer);
      if (!ok) return reply.code(404).send({ error: "unknown_ticket" });
      return { ok: true };
    },
  );

  const joinHits = new Map<string, { count: number; windowStart: number }>();
  const joinAllowed = (ip: string): boolean => {
    const now = Date.now();
    const hit = joinHits.get(ip);
    if (!hit || now - hit.windowStart >= JOIN_WINDOW_MS) {
      joinHits.set(ip, { count: 1, windowStart: now });
      return true;
    }
    hit.count += 1;
    return hit.count <= JOIN_LIMIT_PER_WINDOW;
  };

  app.post<{ Body: { invite?: string; name?: string } }>("/join", async (req, reply) => {
    if (!joinAllowed(req.ip)) return reply.code(429).send({ error: "too many join attempts" });
    const { invite, name } = req.body ?? {};
    if (!invite || !tokens.verifyInvite(invite)) {
      return reply.code(403).send({ error: "invalid or expired invite" });
    }
    if (!name || !PEER_NAME_PATTERN.test(name)) {
      return reply.code(400).send({ error: "name must match [A-Za-z0-9._-]{1,64}" });
    }
    if (tokens.isRevoked(name)) return reply.code(403).send({ error: "name is revoked" });
    if (mailbox.isOnline(name)) {
      return reply.code(409).send({ error: "a peer with this name is currently online" });
    }
    return { token: tokens.issuePeerToken(name), peer: name };
  });

  app.post<{ Body: { ttl_hours?: number } }>("/invite", async (req, reply) => {
    const peer = authPeer(req, tokens);
    if (!peer) return reply.code(401).send({ error: "unauthorized" });
    const ttl = req.body?.ttl_hours;
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_INVITE_TTL_HOURS)) {
      return reply.code(400).send({ error: `ttl_hours must be between 1 and ${MAX_INVITE_TTL_HOURS}` });
    }
    return tokens.issueInvite(ttl);
  });

  // REST twin of the MCP `ask_peer` tool for terminal-only clients.
  // Returns { status, ticket_id, conversation_id, answer?, error? } where
  // status ∈ { answered, pending, error, peer_offline }. Long-polls the
  // mailbox for up to `wait_seconds` (default 25) before falling back to
  // pending — the caller resumes with GET /reply/:ticket_id.
  app.post<{
    Body: {
      peer?: string;
      question?: string;
      wait_seconds?: number;
      conversation_id?: string;
      hops?: number;
      mode?: string;
      brief?: string;
      attachments?: Array<{ name?: string; content?: string }>;
    };
  }>("/ask", async (req, reply) => {
    const fromPeer = authPeer(req, tokens);
    if (!fromPeer) return reply.code(401).send({ error: "unauthorized" });
    const { peer, question, wait_seconds, conversation_id, hops, mode, brief, attachments } = req.body ?? {};
    if (!peer || typeof peer !== "string") return reply.code(400).send({ error: "peer required" });
    if (!question || typeof question !== "string") return reply.code(400).send({ error: "question required" });
    if (peer === fromPeer) return reply.code(400).send({ error: "cannot ask yourself" });
    if (hops !== undefined && (!Number.isInteger(hops) || hops < 0 || hops > MAX_HOPS)) {
      return reply.code(400).send({ error: `hops must be an integer between 0 and ${MAX_HOPS}` });
    }
    if (mode !== undefined && mode !== "ask" && mode !== "discuss") {
      return reply.code(400).send({ error: "mode must be ask or discuss" });
    }
    let ticket_id: string;
    let convId: string;
    try {
      ({ ticket_id, conversation_id: convId } = mailbox.enqueue(peer, fromPeer, question, {
        conversationId: conversation_id,
        clientHops: hops ?? 0,
        mode: mode === "discuss" ? "discuss" : "ask",
        brief: typeof brief === "string" ? brief : undefined,
        attachments,
      }));
    } catch (err) {
      if (
        err instanceof HopLimitError ||
        err instanceof ConversationFullError ||
        err instanceof AttachmentValidationError
      ) {
        return reply.code(400).send({ status: "error", error: err.message });
      }
      throw err;
    }
    if (!mailbox.isOnline(peer)) {
      return { status: "peer_offline", ticket_id, conversation_id: convId };
    }
    const requested = Number(wait_seconds ?? ASK_MAX_WAIT_SECONDS);
    const waitSeconds = Math.min(Math.max(Number.isFinite(requested) ? requested : ASK_MAX_WAIT_SECONDS, 0), ASK_MAX_WAIT_SECONDS);
    const result = await mailbox.waitForAnswer(ticket_id, waitSeconds * 1000);
    return { ...result, ticket_id, conversation_id: convId };
  });

  // GET /reply/:ticket_id?wait=N — poll or long-poll for an answer. Returns
  // the same shape as /ask minus routing fields. Consumes the entry on
  // answered/error (single-read semantics), same as the MCP check_reply tool.
  app.get<{ Params: { ticket_id: string }; Querystring: { wait?: string } }>(
    "/reply/:ticket_id",
    async (req, reply) => {
      const peer = authPeer(req, tokens);
      if (!peer) return reply.code(401).send({ error: "unauthorized" });
      const requested = Number(req.query.wait ?? 0);
      const parsed = Number.isFinite(requested) ? requested : 0;
      const waitSeconds = Math.min(Math.max(parsed, 0), REPLY_MAX_WAIT_SECONDS);
      const result = waitSeconds > 0
        ? await mailbox.waitForAnswer(req.params.ticket_id, waitSeconds * 1000)
        : mailbox.checkReply(req.params.ticket_id);
      return { ...result, ticket_id: req.params.ticket_id };
    },
  );

  app.get("/status", async (req, reply) => {
    const peer = authPeer(req, tokens);
    if (!peer) return reply.code(401).send({ error: "unauthorized" });
    return {
      self: peer,
      self_online: mailbox.isOnline(peer),
      peers: mailbox
        .knownPeers()
        .filter((name) => name !== peer)
        .map((name) => ({ name, online: mailbox.isOnline(name) })),
      // Open incoming = queued in inbox OR already delivered to the daemon but
      // not yet answered. Inbox depth alone stays 0 for almost the whole ask
      // (long-poll takes the ticket immediately).
      incoming: mailbox.incomingFor(peer),
      incoming_queued: mailbox.openIncomingCount(peer),
      outgoing: mailbox.outgoingFor(peer),
    };
  });
}
