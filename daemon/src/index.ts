import { expandHome, loadConfig } from "./config.js";
import { ConversationStore } from "./conversations.js";
import { createHandler } from "./handler.js";
import { Poller } from "./poller.js";
import { pruneWorkspaces } from "./workspace.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pruned = pruneWorkspaces(config.responder.workspace_dir);
  if (pruned > 0) console.log(`pruned ${pruned} stale conversation workspace(s)`);
  const policyPath = expandHome("~/.agent-link/policy.md");
  const store = new ConversationStore(expandHome("~/.agent-link/conversations.json"));
  const poller = new Poller(config, createHandler(config, store, policyPath));

  const controller = new AbortController();
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.error(`received ${signal}, finishing current work and shutting down`);
    controller.abort();
    // In-flight cursor-agent runs cannot be interrupted mid-task, so cap the
    // graceful shutdown and force-exit if the current question takes too long.
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(`agent-link responder started as peer "${config.self_peer}"`);
  await poller.run(controller.signal);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
