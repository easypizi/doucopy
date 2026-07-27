import type { FastifyInstance, FastifyRequest } from "fastify";
import { bearerToken, PEER_NAME_PATTERN, type TokenService } from "./auth.js";
import type { Mailbox } from "./mailbox.js";

const MAX_WAIT_SECONDS = 25;
const JOIN_WINDOW_MS = 60_000;
const JOIN_LIMIT_PER_WINDOW = 10;
const MAX_INVITE_TTL_HOURS = 720;

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

  app.post<{ Body: { ticket_id?: string; answer?: string; error?: string } }>(
    "/answer",
    async (req, reply) => {
      const peer = authPeer(req, tokens);
      if (!peer) return reply.code(401).send({ error: "unauthorized" });
      const { ticket_id, answer, error } = req.body ?? {};
      if (!ticket_id) return reply.code(400).send({ error: "ticket_id required" });
      const ok = mailbox.settle(ticket_id, { answer, error }, peer);
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
      incoming_queued: mailbox.queuedCount(peer),
      outgoing: mailbox.outgoingFor(peer),
    };
  });
}
