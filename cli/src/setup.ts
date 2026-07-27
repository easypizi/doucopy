import fg from "fast-glob";
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

export function mergeMcpJson(home: string, relayUrl: string, token: string): string {
  const file = path.join(home, ".cursor", "mcp.json");
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
    url: `${relayUrl.replace(/\/+$/, "")}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  };
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}
