import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fetchStatus, joinRelay, normalizeRelayUrl } from "./api.js";
import { installDaemon } from "./launchd.js";
import {
  defaultConfig,
  discoverMemorySources,
  mergeMcpJson,
  writeConfig,
  writeDefaultPolicy,
} from "./setup.js";

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export async function runJoin(relayUrlArg: string, invite: string): Promise<void> {
  const relayUrl = normalizeRelayUrl(relayUrlArg);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let name = "";
  try {
    while (!NAME_PATTERN.test(name)) {
      name = (await rl.question("Peer name for this machine (letters, digits, . _ -): ")).trim();
    }
  } finally {
    rl.close();
  }

  const { token, peer } = await joinRelay(relayUrl, invite, name);
  console.log(`joined the relay as "${peer}"`);

  const home = homedir();
  const discovery = discoverMemorySources(home);
  if (discovery.agents_md_roots.length > 0) {
    console.log(`memory roots: ${discovery.agents_md_roots.join(", ")}`);
  }
  const configPath = writeConfig(home, defaultConfig(relayUrl, peer, token, discovery));
  console.log(`wrote ${configPath}`);
  if (writeDefaultPolicy(home)) console.log("wrote default ~/.agent-link/policy.md");
  const mcpPath = mergeMcpJson(home, relayUrl, token);
  console.log(`updated ${mcpPath}`);

  installDaemon(home);
  console.log("installed and started the responder daemon");

  for (let i = 0; i < 15; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const status = await fetchStatus(relayUrl, token);
      if (status.self_online) {
        console.log("daemon is online, setup complete");
        console.log("restart Cursor so it picks up the agent-link MCP server");
        return;
      }
    } catch {
      // relay may briefly reject while the daemon warms up, keep waiting
    }
  }
  console.error("daemon did not come online within 30s, check: agent-link logs");
  process.exitCode = 1;
}
