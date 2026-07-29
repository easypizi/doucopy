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

## Never reveal

Anything listed here is stripped from every outgoing answer automatically.
One item per line, prefixed with \`-\`. Wrap regular expressions in slashes:
\`- /internal-project-\\d+/\`. Edits take effect on the next question, no
daemon restart needed.

- 
`;

export function renderPolicyWithNeverReveal(items: string[]): string {
  const cleaned = items.map((s) => s.trim()).filter((s) => s.length > 0);
  const bullets = cleaned.length > 0
    ? cleaned.map((s) => `- ${s}`).join("\n")
    : "- ";
  return DEFAULT_POLICY.replace(/- \n$/, `${bullets}\n`);
}

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

export function writeDefaultPolicy(home: string, neverReveal: string[] = []): boolean {
  const dir = path.join(home, ".agent-link");
  const file = path.join(dir, "policy.md");
  if (existsSync(file)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, renderPolicyWithNeverReveal(neverReveal));
  return true;
}

export type HarnessKind = "cursor-agent" | "claude" | "codex";

// Asker detection is "does this machine already have that tool's config dir",
// which tells us where to drop an MCP config entry. It says nothing about
// whether the same tool can *run* as a responder.
export interface DetectedAskers {
  cursor: boolean;
  claude: boolean;
  codex: boolean;
}

// Responder detection is strictly "is this binary on PATH", because that is
// what the daemon will actually shell out to.
export interface DetectedResponders {
  cursor: boolean;
  claude: boolean;
  codex: boolean;
}

// Kept for backwards compatibility so callers/tests that used the old combined
// shape continue to work. `cursor` field mirrors asker detection (config dir
// present), the others mirror responder detection.
export interface DetectedHarnesses {
  cursor: boolean;
  claude: boolean;
  codex: boolean;
}

export function detectAskers(home: string): DetectedAskers {
  return {
    cursor: existsSync(path.join(home, ".cursor")),
    claude: existsSync(path.join(home, ".claude.json")) || existsSync(path.join(home, ".claude")),
    codex: existsSync(path.join(home, ".codex")),
  };
}

export function detectResponders(): DetectedResponders {
  return {
    cursor: which("cursor-agent"),
    claude: which("claude"),
    codex: which("codex"),
  };
}

export function detectHarnesses(home: string): DetectedHarnesses {
  const askers = detectAskers(home);
  const responders = detectResponders();
  return {
    cursor: askers.cursor || responders.cursor,
    claude: responders.claude,
    codex: responders.codex,
  };
}

function which(binary: string): boolean {
  const res = spawnSync("command", ["-v", binary], { shell: "/bin/bash", stdio: "ignore" });
  return res.status === 0;
}

// `strictParse` controls what happens if the existing file is unparseable JSON.
// - Cursor's ~/.cursor/mcp.json only holds MCP config: silently start fresh.
// - Claude's ~/.claude.json holds the *entire* Claude Code state (projects,
//   sessions, todos). Overwriting it would wipe the user's history, so we
//   refuse and let the user recover the file themselves.
function writeMcpJson(file: string, relayUrl: string, token: string, strictParse = false): void {
  mkdirSync(path.dirname(file), { recursive: true });
  let data: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        data = parsed as typeof data;
      } else if (strictParse) {
        throw new Error(`${file} does not contain a JSON object; refusing to overwrite`);
      }
    } catch (err) {
      if (strictParse) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`${file} is not valid JSON; refusing to overwrite (fix or move it, then re-run). Parse error: ${detail}`);
      }
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
  writeMcpJson(file, relayUrl, token, false);
  return file;
}

export function mergeClaudeMcp(home: string, relayUrl: string, token: string): string {
  const file = path.join(home, ".claude.json");
  writeMcpJson(file, relayUrl, token, true);
  return file;
}

// Merges the [mcp_servers.agent-link] block into ~/.codex/config.toml.
// A line-based parser is used instead of a regex so section bodies that
// contain "[" (e.g. TOML arrays like `enabled_tools = ["x"]`) aren't cut
// short. The section runs from its header up to the next line that starts
// with "[" at column 0 (a new table/array-of-tables header) or EOF.
export function mergeCodexToml(home: string, relayUrl: string, token: string): string {
  const dir = path.join(home, ".codex");
  const file = path.join(dir, "config.toml");
  mkdirSync(dir, { recursive: true });
  const url = `${relayUrl.replace(/\/+$/, "")}/mcp`;
  const block = [
    "[mcp_servers.agent-link]",
    `url = "${url}"`,
    `bearer_token = "${token}"`,
  ];
  let existing = "";
  if (existsSync(file)) {
    existing = readFileSync(file, "utf8");
    writeFileSync(`${file}.bak`, existing);
  }
  const merged = replaceCodexAgentLinkSection(existing, block);
  writeFileSync(file, merged.endsWith("\n") ? merged : `${merged}\n`, { mode: 0o600 });
  return file;
}

// Exported for tests. Splits `input` into lines, finds
// `[mcp_servers.agent-link]`, drops everything until the next header line
// (starts with "["), then splices in `blockLines`. Preserves neighbouring
// blank lines. If the section is absent, appends the block with a blank line
// separator.
export function replaceCodexAgentLinkSection(input: string, blockLines: string[]): string {
  const HEADER = "[mcp_servers.agent-link]";
  const lines = input.length === 0 ? [] : input.split("\n");
  // Split may leave a trailing empty string when input ends with "\n"; keep it
  // for round-trip stability.
  const start = lines.findIndex((line) => line.trim() === HEADER);
  if (start === -1) {
    const trimmed = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    if (trimmed.length === 0) return `${blockLines.join("\n")}\n`;
    return `${trimmed.join("\n")}\n\n${blockLines.join("\n")}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("[")) { end = i; break; }
  }
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const parts: string[] = [];
  if (before.length > 0) parts.push(before.join("\n").replace(/\n+$/, ""));
  parts.push(blockLines.join("\n"));
  const rest = after.join("\n").replace(/^\n+/, "");
  if (rest.length > 0) parts.push(rest);
  const joined = parts.join("\n\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}
