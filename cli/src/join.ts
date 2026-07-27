import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fetchStatus, joinRelay, normalizeRelayUrl } from "./api.js";
import { installDaemon } from "./launchd.js";
import {
  defaultConfig,
  detectHarnesses,
  discoverMemorySources,
  mergeClaudeMcp,
  mergeCodexToml,
  mergeMcpJson,
  writeConfig,
  writeDefaultPolicy,
  type DetectedHarnesses,
  type HarnessKind,
} from "./setup.js";

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

async function chooseResponderHarness(detected: DetectedHarnesses, rl: ReturnType<typeof createInterface>): Promise<HarnessKind> {
  const available: HarnessKind[] = [];
  if (detected.cursor) available.push("cursor-agent");
  if (detected.claude) available.push("claude");
  if (detected.codex) available.push("codex");
  if (available.length === 0) {
    console.log("no harness detected on PATH, defaulting to cursor-agent (install it before starting the daemon)");
    return "cursor-agent";
  }
  if (available.length === 1) {
    console.log(`responder harness: ${available[0]} (only one detected)`);
    return available[0];
  }
  const labelled = available.map((h, i) => `${i + 1}) ${h}`).join("  ");
  while (true) {
    const raw = (await rl.question(`Which harness should answer questions? [${labelled}]: `)).trim();
    if (raw === "") return available[0];
    const asNum = Number(raw);
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= available.length) return available[asNum - 1];
    if ((available as string[]).includes(raw)) return raw as HarnessKind;
    console.log("pick a number from the list, or type the harness name");
  }
}

export async function runJoin(relayUrlArg: string, invite: string): Promise<void> {
  const relayUrl = normalizeRelayUrl(relayUrlArg);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let name = "";
  let harness: HarnessKind = "cursor-agent";
  try {
    while (!NAME_PATTERN.test(name)) {
      name = (await rl.question("Peer name for this machine (letters, digits, . _ -): ")).trim();
    }
    const home = homedir();
    harness = await chooseResponderHarness(detectHarnesses(home), rl);
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
  const base = defaultConfig(relayUrl, peer, token, discovery) as { responder: { harness?: HarnessKind; binary?: string; cursor_agent_binary?: string } };
  base.responder.harness = harness;
  base.responder.binary = harness;
  if (harness !== "cursor-agent") delete base.responder.cursor_agent_binary;
  const configPath = writeConfig(home, base);
  console.log(`wrote ${configPath}`);
  if (writeDefaultPolicy(home)) console.log("wrote default ~/.agent-link/policy.md");

  const detected = detectHarnesses(home);
  if (detected.cursor) console.log(`updated ${mergeMcpJson(home, relayUrl, token)}`);
  if (detected.claude) console.log(`updated ${mergeClaudeMcp(home, relayUrl, token)}`);
  if (detected.codex) console.log(`updated ${mergeCodexToml(home, relayUrl, token)}`);

  installDaemon(home);
  console.log("installed and started the responder daemon");

  for (let i = 0; i < 15; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const status = await fetchStatus(relayUrl, token);
      if (status.self_online) {
        console.log("daemon is online, setup complete");
        console.log("restart your coding agent (Cursor / Claude Code / Codex) so it picks up the agent-link MCP server");
        return;
      }
    } catch {
      // relay may briefly reject while the daemon warms up, keep waiting
    }
  }
  console.error("daemon did not come online within 30s, check: agent-link logs");
  process.exitCode = 1;
}
