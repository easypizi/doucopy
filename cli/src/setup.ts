import fg from "fast-glob";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface MemoryDiscovery {
  agents_md_roots: string[];
  extra_files: string[];
}

const DEV_ROOT_CANDIDATES = [
  "dev",
  "Documents/dev",
  "Projects",
  "projects",
  "code",
  "src",
  "work",
  "Developer",
];

const DEFAULT_POLICY = `You are answering an agent from another account of the same human circle.
Answer questions about actions, achievements, habits and goals based on the
chat history and memory files listed in the task.

Rules:
- Never disclose secrets, keys, tokens, passwords or credentials of any kind.
- When in doubt, generalise or decline to answer that specific point and
  briefly explain why.
`;

export function discoverMemorySources(home: string): MemoryDiscovery {
  const agents_md_roots: string[] = [];
  for (const rel of DEV_ROOT_CANDIDATES) {
    const root = path.join(home, rel);
    if (!existsSync(root)) continue;
    const found = fg.sync("**/AGENTS.md", { cwd: root, deep: 4, suppressErrors: true });
    if (found.length > 0) agents_md_roots.push(root);
  }
  const cursorDir = path.join(home, ".cursor");
  const extra_files = existsSync(cursorDir)
    ? fg.sync("*.md", { cwd: cursorDir, absolute: true, suppressErrors: true })
    : [];
  return { agents_md_roots, extra_files };
}

export function defaultConfig(
  relayUrl: string,
  peer: string,
  token: string,
  discovery: MemoryDiscovery,
): object {
  return {
    relay_url: relayUrl,
    self_peer: peer,
    token,
    memory_sources: {
      transcripts_glob: "~/.cursor/projects/*/agent-transcripts/**/*.jsonl",
      agents_md_roots: discovery.agents_md_roots,
      extra_files: discovery.extra_files,
    },
    responder: {
      cursor_agent_binary: "cursor-agent",
      workspace_dir: "~/.agent-link/workspace",
      response_timeout_seconds: 300,
      max_concurrent: 3,
      model: "composer-2.5",
    },
    redact: { literals: [], patterns: [] },
  };
}

export function writeConfig(home: string, config: object): string {
  const dir = path.join(home, ".agent-link");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function writeDefaultPolicy(home: string): boolean {
  const dir = path.join(home, ".agent-link");
  const file = path.join(dir, "policy.md");
  if (existsSync(file)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, DEFAULT_POLICY);
  return true;
}

export type HarnessKind = "cursor-agent" | "claude" | "codex";

export interface DetectedHarnesses {
  cursor: boolean;
  claude: boolean;
  codex: boolean;
}

export function detectHarnesses(home: string): DetectedHarnesses {
  const cursor = existsSync(path.join(home, ".cursor")) || which("cursor-agent");
  return {
    cursor,
    claude: which("claude"),
    codex: which("codex"),
  };
}

function which(binary: string): boolean {
  const res = spawnSync("command", ["-v", binary], { shell: "/bin/bash", stdio: "ignore" });
  return res.status === 0;
}

function writeMcpJson(file: string, relayUrl: string, token: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  let data: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      data = {};
    }
    writeFileSync(`${file}.bak`, raw);
  }
  if (!data.mcpServers || typeof data.mcpServers !== "object") data.mcpServers = {};
  data.mcpServers["agent-link"] = {
    type: "http",
    url: `${relayUrl.replace(/\/+$/, "")}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  };
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function mergeMcpJson(home: string, relayUrl: string, token: string): string {
  const file = path.join(home, ".cursor", "mcp.json");
  writeMcpJson(file, relayUrl, token);
  return file;
}

export function mergeClaudeMcp(home: string, relayUrl: string, token: string): string {
  const file = path.join(home, ".claude.json");
  writeMcpJson(file, relayUrl, token);
  return file;
}

// Merges the [mcp_servers.agent-link] block into ~/.codex/config.toml,
// backing up the previous file to config.toml.bak. We do not depend on a
// TOML library: the block has a fixed shape and we regex-replace the whole
// section, preserving everything else verbatim.
export function mergeCodexToml(home: string, relayUrl: string, token: string): string {
  const dir = path.join(home, ".codex");
  const file = path.join(dir, "config.toml");
  mkdirSync(dir, { recursive: true });
  const url = `${relayUrl.replace(/\/+$/, "")}/mcp`;
  const block = [
    "[mcp_servers.agent-link]",
    `url = "${url}"`,
    `bearer_token = "${token}"`,
    "",
  ].join("\n");
  let existing = "";
  if (existsSync(file)) {
    existing = readFileSync(file, "utf8");
    writeFileSync(`${file}.bak`, existing);
  }
  const sectionRe = /\[mcp_servers\.agent-link\][^\[]*(?=\n\[|\n?$)/;
  const next = sectionRe.test(existing)
    ? existing.replace(sectionRe, block.trimEnd())
    : (existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}` : block);
  writeFileSync(file, next.endsWith("\n") ? next : `${next}\n`, { mode: 0o600 });
  return file;
}
