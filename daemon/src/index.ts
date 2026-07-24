import { existsSync, readFileSync } from "node:fs";
import { expandHome, loadConfig } from "./config.js";
import { ConversationStore } from "./conversations.js";
import { createHandler } from "./handler.js";
import { Poller } from "./poller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const policyPath = expandHome("~/.agent-link/policy.md");
  const policy = existsSync(policyPath) ? readFileSync(policyPath, "utf8") : "";
  const store = new ConversationStore(expandHome("~/.agent-link/conversations.json"));
  const poller = new Poller(config, createHandler(config, store, policy));
  console.log(`agent-link responder started as peer "${config.self_peer}"`);
  await poller.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
