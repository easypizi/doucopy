import fg from "fast-glob";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

export const CURSOR_TRANSCRIPTS_GLOB = "~/.cursor/projects/*/agent-transcripts/**/*.jsonl";
export const CLAUDE_TRANSCRIPTS_GLOB = "~/.claude/projects/**/*.jsonl";
export const CODEX_TRANSCRIPTS_GLOB = "~/.codex/sessions/**/*.jsonl";

/** Detect transcript globs from directories that exist under home. Fallback: Cursor glob. */
export function detectTranscriptGlobs(home: string): string[] {
  const globs: string[] = [];
  if (existsSync(path.join(home, ".cursor", "projects"))) globs.push(CURSOR_TRANSCRIPTS_GLOB);
  if (existsSync(path.join(home, ".claude", "projects"))) globs.push(CLAUDE_TRANSCRIPTS_GLOB);
  if (existsSync(path.join(home, ".codex", "sessions"))) globs.push(CODEX_TRANSCRIPTS_GLOB);
  return globs.length > 0 ? globs : [CURSOR_TRANSCRIPTS_GLOB];
}

export function discoverMemorySources(home: string): MemoryDiscovery {
  const agents_md_roots: string[] = [];
  for (const rel of DEV_ROOT_CANDIDATES) {
    const root = path.join(home, rel);
    if (!existsSync(root)) continue;
    const found = fg.sync("**/AGENTS.md", { cwd: root, deep: 4, suppressErrors: true });
    if (found.length > 0) agents_md_roots.push(root);
  }
  const extra_files: string[] = [];
  const cursorDir = path.join(home, ".cursor");
  if (existsSync(cursorDir)) {
    extra_files.push(...fg.sync("*.md", { cwd: cursorDir, absolute: true, suppressErrors: true }));
  }
  const claudeMd = path.join(home, ".claude", "CLAUDE.md");
  if (existsSync(claudeMd)) extra_files.push(claudeMd);
  return { agents_md_roots, extra_files };
}

export function defaultConfig(
  relayUrl: string,
  peer: string,
  token: string,
  discovery: MemoryDiscovery,
  home: string = homedir(),
): object {
  const globs = detectTranscriptGlobs(home);
  return {
    relay_url: relayUrl,
    self_peer: peer,
    token,
    memory_sources: {
      transcripts_glob: globs.length === 1 ? globs[0] : globs,
      agents_md_roots: discovery.agents_md_roots,
      extra_files: discovery.extra_files,
    },
    responder: {
      cursor_agent_binary: "cursor-agent",
      workspace_dir: "~/.doucopy/workspace",
      response_timeout_seconds: 300,
      max_concurrent: 3,
    },
    restrictions: {
      fs_write: { mode: "workspace_only", allow: [] },
      fs_read: { deny: [] },
      shell: { mode: "off", deny: [] },
    },
    redact: { literals: [], patterns: [] },
    keep_awake: {
      enabled: true,
      confirm_days: 3,
      confirm_grace_hours: 24,
    },
  };
}

export function writeConfig(home: string, config: object): string {
  const dir = path.join(home, ".doucopy");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function writeDefaultPolicy(home: string, neverReveal: string[] = []): boolean {
  const dir = path.join(home, ".doucopy");
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

export interface BinaryOnPathOptions {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  pathSep?: string;
  exists?: (candidate: string) => boolean;
}

/** Walk PATH for a binary. On win32 also checks .exe/.cmd/.bat/.ps1. */
export function binaryOnPath(binary: string, opts: BinaryOnPathOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const pathSep = opts.pathSep ?? path.delimiter;
  const exists = opts.exists ?? existsSync;
  const names =
    platform === "win32"
      ? [binary, `${binary}.exe`, `${binary}.cmd`, `${binary}.bat`, `${binary}.ps1`]
      : [binary];
  for (const dir of pathEnv.split(pathSep)) {
    if (!dir) continue;
    for (const name of names) {
      if (exists(path.join(dir, name))) return true;
    }
  }
  return false;
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

/** Why a responder harness choice should be disabled in Setup/Settings UI. */
export function responderHarnessDisabledReason(
  present: boolean,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "darwin" && platform !== "win32") {
    return "(responder daemon unsupported on this OS)";
  }
  if (!present) return "(not found on PATH)";
  return undefined;
}

function which(binary: string): boolean {
  if (binaryOnPath(binary)) return true;
  // Fallback for unusual installs (symlinks, functions) on Unix.
  if (process.platform === "win32") {
    const res = spawnSync("where.exe", [binary], { stdio: "ignore" });
    return res.status === 0;
  }
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
  // Drop the legacy key from the agent-link days so a machine that upgrades
  // doesn't end up with two MCP servers pointed at the same relay.
  delete data.mcpServers["agent-link"];
  data.mcpServers["doucopy"] = {
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

/** Escape a value for a double-quoted TOML string. */
export function tomlQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Codex MCP block for ~/.codex/config.toml.
 * Codex >= 0.146 rejects `bearer_token` on streamable HTTP. Use http_headers.
 * Re-running join/setup replaces any older bearer_token block.
 */
export function codexDoucopyMcpBlock(relayUrl: string, token: string): string[] {
  const url = `${relayUrl.replace(/\/+$/, "")}/mcp`;
  return [
    "[mcp_servers.doucopy]",
    `url = "${tomlQuoted(url)}"`,
    `http_headers = { Authorization = "Bearer ${tomlQuoted(token)}" }`,
  ];
}

// Merges the [mcp_servers.doucopy] block into ~/.codex/config.toml.
// A line-based parser is used instead of a regex so section bodies that
// contain "[" (e.g. TOML arrays like `enabled_tools = ["x"]`) aren't cut
// short. The section runs from its header up to the next line that starts
// with "[" at column 0 (a new table/array-of-tables header) or EOF.
export function mergeCodexToml(home: string, relayUrl: string, token: string): string {
  const dir = path.join(home, ".codex");
  const file = path.join(dir, "config.toml");
  mkdirSync(dir, { recursive: true });
  const block = codexDoucopyMcpBlock(relayUrl, token);
  let existing = "";
  if (existsSync(file)) {
    existing = readFileSync(file, "utf8");
    writeFileSync(`${file}.bak`, existing);
  }
  // Drop the legacy agent-link section first (upgrade path), then merge in
  // the current doucopy one.
  const withoutLegacy = replaceDoucopyMcpSection(existing, null, "[mcp_servers.agent-link]");
  const merged = replaceDoucopyMcpSection(withoutLegacy, block, "[mcp_servers.doucopy]");
  writeFileSync(file, merged.endsWith("\n") ? merged : `${merged}\n`, { mode: 0o600 });
  return file;
}

// Exported for tests. Splits `input` into lines, finds `header`, drops
// everything until the next header line (starts with "["), then splices in
// `blockLines` (or removes the section entirely when `blockLines` is null).
// Preserves neighbouring blank lines. If the section is absent and
// `blockLines` is provided, appends the block with a blank line separator.
export function replaceDoucopyMcpSection(
  input: string,
  blockLines: string[] | null,
  header = "[mcp_servers.doucopy]",
): string {
  const lines = input.length === 0 ? [] : input.split("\n");
  // Split may leave a trailing empty string when input ends with "\n"; keep it
  // for round-trip stability.
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    if (blockLines === null) return input;
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
  if (blockLines === null) {
    const parts: string[] = [];
    if (before.length > 0) parts.push(before.join("\n").replace(/\n+$/, ""));
    const rest = after.join("\n").replace(/^\n+/, "");
    if (rest.length > 0) parts.push(rest);
    if (parts.length === 0) return "";
    const joined = parts.join("\n\n");
    return joined.endsWith("\n") ? joined : `${joined}\n`;
  }
  const parts: string[] = [];
  if (before.length > 0) parts.push(before.join("\n").replace(/\n+$/, ""));
  parts.push(blockLines.join("\n"));
  const rest = after.join("\n").replace(/^\n+/, "");
  if (rest.length > 0) parts.push(rest);
  const joined = parts.join("\n\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}
