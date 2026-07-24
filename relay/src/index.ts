import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance } from "fastify";
import { loadPeersFromEnv } from "./auth.js";
import { Mailbox } from "./mailbox.js";
import { buildMcpServer } from "./mcp.js";
import { authPeer, registerRest } from "./rest.js";

export function buildApp(env: NodeJS.ProcessEnv = process.env): FastifyInstance {
  const registry = loadPeersFromEnv(env);
  const mailbox = new Mailbox();
  const app = Fastify({ logger: true });
  registerRest(app, mailbox, registry);

  // Stateless streamable HTTP: a fresh server+transport pair per request.
  app.post("/mcp", async (req, reply) => {
    const peer = authPeer(req, registry);
    if (!peer) return reply.code(401).send({ error: "unauthorized" });
    const server = buildMcpServer(mailbox, registry, peer);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      app.log.error(err);
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader("content-type", "application/json");
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "internal server error" },
            id: null,
          }),
        );
      } else {
        reply.raw.destroy();
      }
    }
  });

  return app;
}

const isMain = process.argv[1]?.endsWith("index.js") ?? false;
if (isMain) {
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
