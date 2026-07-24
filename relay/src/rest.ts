import type { FastifyInstance, FastifyRequest } from "fastify";
import { bearerToken, type PeerRegistry } from "./auth.js";
import type { Mailbox } from "./mailbox.js";

const MAX_WAIT_SECONDS = 25;

export function authPeer(req: FastifyRequest, registry: PeerRegistry): string | null {
  const token = bearerToken(req.headers.authorization);
  return token ? registry.peerForToken(token) : null;
}

export function registerRest(app: FastifyInstance, mailbox: Mailbox, registry: PeerRegistry): void {
  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { peer: string }; Querystring: { wait?: string } }>(
    "/inbox/:peer",
    async (req, reply) => {
      const peer = authPeer(req, registry);
      if (!peer) return reply.code(401).send({ error: "unauthorized" });
      if (peer !== req.params.peer) return reply.code(403).send({ error: "wrong peer" });
      const requested = Number(req.query.wait ?? MAX_WAIT_SECONDS);
      const waitSeconds = Math.min(Number.isFinite(requested) ? requested : MAX_WAIT_SECONDS, MAX_WAIT_SECONDS);
      const question = await mailbox.takeNext(peer, waitSeconds * 1000);
      if (!question) return reply.code(204).send();
      return question;
    },
  );

  app.post<{ Body: { ticket_id?: string; answer?: string; error?: string } }>(
    "/answer",
    async (req, reply) => {
      const peer = authPeer(req, registry);
      if (!peer) return reply.code(401).send({ error: "unauthorized" });
      const { ticket_id, answer, error } = req.body ?? {};
      if (!ticket_id) return reply.code(400).send({ error: "ticket_id required" });
      const ok = mailbox.settle(ticket_id, { answer, error });
      if (!ok) return reply.code(404).send({ error: "unknown_ticket" });
      return { ok: true };
    },
  );
}
