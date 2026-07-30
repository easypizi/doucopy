import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  expandHome,
  type DaemonConfig,
  type RestrictionsConfig,
  type ResolvedRestrictions,
  BUILTIN_READ_DENY,
  DEFAULT_RESTRICTIONS,
  resolveRestrictions,
} from "./config.js";

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CursorCliPermissions {
  permissions: { allow: string[]; deny: string[] };
}

export interface ClaudeSettingsPermissions {
  permissions: { allow: string[]; deny: string[] };
}

export interface HarnessPermissions {
  restrictions: ResolvedRestrictions;
  writeRoots: string[];
  readDeny: string[];
  cursor: CursorCliPermissions;
  claude: ClaudeSettingsPermissions;
  codexSandbox: CodexSandbox;
  summary: { write: string; read: string; shell: string };
}

const COMMON_HOME_WRITE_DENY = [
  "Desktop",
  "Documents",
  "Downloads",
  "Pictures",
  "Movies",
  "Music",
  "Library",
  "Public",
  "Applications",
];

function asGlobRoot(absPath: string): string {
  const normalized = path.resolve(absPath);
  return normalized.endsWith(path.sep) ? normalized.slice(0, -1) : normalized;
}

function cursorReadToken(absPath: string): string {
  const root = asGlobRoot(absPath);
  return `Read(${root}/**)`;
}

function cursorWriteToken(absPath: string): string {
  const root = asGlobRoot(absPath);
  return `Write(${root}/**)`;
}

/** Claude absolute on-disk paths use a // prefix. */
function claudeAbs(absPath: string): string {
  const root = asGlobRoot(absPath);
  return root.startsWith("/") ? `/${root}` : root;
}

function claudeReadToken(absPath: string): string {
  return `Read(${claudeAbs(absPath)}/**)`;
}

function claudeEditToken(absPath: string): string {
  return `Edit(${claudeAbs(absPath)}/**)`;
}

function claudeWriteToken(absPath: string): string {
  return `Write(${claudeAbs(absPath)}/**)`;
}

function isUnderRoot(candidate: string, root: string): boolean {
  const c = asGlobRoot(candidate);
  const r = asGlobRoot(root);
  return c === r || c.startsWith(`${r}${path.sep}`);
}

function rootsCover(pathToCheck: string, roots: string[]): boolean {
  return roots.some((root) => isUnderRoot(pathToCheck, root) || isUnderRoot(root, pathToCheck));
}

function memoryReadAllows(config: DaemonConfig): string[] {
  const allows = new Set<string>();
  const glob = config.memory_sources.transcripts_glob;
  // Prefer the directory prefix before the first glob metacharacter.
  const meta = glob.search(/[*?[]/);
  const prefix = meta >= 0 ? glob.slice(0, meta).replace(/\/+$/, "") : path.dirname(glob);
  if (prefix) allows.add(prefix);
  for (const root of config.memory_sources.agents_md_roots) allows.add(root);
  for (const file of config.memory_sources.extra_files) allows.add(path.dirname(file));
  return [...allows];
}

function writeRootsFor(config: DaemonConfig, workspaceDir: string, restrictions: ResolvedRestrictions): string[] {
  const roots = [asGlobRoot(workspaceDir)];
  if (restrictions.fs_write.mode === "custom") {
    for (const p of restrictions.fs_write.allow) roots.push(asGlobRoot(p));
  }
  return roots;
}

function readDenyPaths(restrictions: ResolvedRestrictions): string[] {
  const fromBuiltin = BUILTIN_READ_DENY.map((p) => expandHome(p));
  const custom = restrictions.fs_read.deny.map((p) => expandHome(p));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...fromBuiltin, ...custom]) {
    const key = asGlobRoot(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function commonOutsideWriteDenies(writeRoots: string[]): string[] {
  const home = homedir();
  const denies: string[] = [];
  for (const name of COMMON_HOME_WRITE_DENY) {
    const full = path.join(home, name);
    if (rootsCover(full, writeRoots)) continue;
    denies.push(full);
  }
  // Always deny writes into the built-in sensitive dirs (even if somehow covered).
  for (const p of BUILTIN_READ_DENY.map((x) => expandHome(x))) {
    if (rootsCover(p, writeRoots) && writeRoots.some((r) => isUnderRoot(r, p) && asGlobRoot(r) !== asGlobRoot(p))) {
      // Allowed root lives under a sensitive parent (e.g. workspace under ~/.doucopy).
      // Do not blanket-deny the parent. Deny sibling files via specific tokens later if needed.
      continue;
    }
    if (!rootsCover(p, writeRoots)) denies.push(p);
  }
  // Also deny other home top-level entries that are not covered, when they exist.
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") && ![".ssh", ".aws", ".doucopy"].includes(entry.name)) continue;
      const full = path.join(home, entry.name);
      if (rootsCover(full, writeRoots)) continue;
      if (denies.some((d) => asGlobRoot(d) === asGlobRoot(full))) continue;
      if (COMMON_HOME_WRITE_DENY.includes(entry.name) || BUILTIN_READ_DENY.some((b) => expandHome(b) === full)) {
        denies.push(full);
      }
    }
  } catch {
    // home unreadable: keep the static list
  }
  return denies;
}

function shellSummary(restrictions: ResolvedRestrictions): string {
  if (restrictions.shell.mode === "off") return "off";
  if (restrictions.shell.mode === "open") return "open";
  return `deny_patterns(${restrictions.shell.deny.join(", ") || "none"})`;
}

function writeSummary(restrictions: ResolvedRestrictions, writeRoots: string[]): string {
  if (restrictions.fs_write.mode === "workspace_only") return `workspace_only(${writeRoots[0]})`;
  return `custom(${writeRoots.join(", ")})`;
}

function readSummary(readDeny: string[]): string {
  return `deny(${readDeny.join(", ")})`;
}

function mapCodexSandbox(restrictions: ResolvedRestrictions, writeRoots: string[], workspaceDir: string): CodexSandbox {
  const workspace = asGlobRoot(workspaceDir);
  const hasOutsideWrite = writeRoots.some((r) => !isUnderRoot(r, workspace) && asGlobRoot(r) !== workspace);
  if (restrictions.shell.mode === "open" || hasOutsideWrite) return "danger-full-access";
  return "workspace-write";
}

export function buildPermissions(config: DaemonConfig, workspaceDir: string): HarnessPermissions {
  const restrictions = resolveRestrictions(config.restrictions);
  const writeRoots = writeRootsFor(config, workspaceDir, restrictions);
  const readDeny = readDenyPaths(restrictions);
  const memoryAllows = memoryReadAllows(config);
  const outsideWriteDenies = commonOutsideWriteDenies(writeRoots);

  const cursorAllow: string[] = [];
  const cursorDeny: string[] = [];
  const claudeAllow: string[] = ["Read"];
  const claudeDeny: string[] = [];

  cursorAllow.push(cursorReadToken(workspaceDir));
  for (const root of memoryAllows) cursorAllow.push(cursorReadToken(root));
  for (const root of writeRoots) {
    cursorAllow.push(cursorWriteToken(root));
    claudeAllow.push(claudeEditToken(root));
    claudeAllow.push(claudeWriteToken(root));
  }

  for (const denied of readDeny) {
    cursorDeny.push(cursorReadToken(denied));
    claudeDeny.push(claudeReadToken(denied));
  }

  for (const denied of outsideWriteDenies) {
    cursorDeny.push(cursorWriteToken(denied));
    claudeDeny.push(claudeEditToken(denied));
    claudeDeny.push(claudeWriteToken(denied));
  }
  // Also deny writes into every custom read-deny path (owner clearly wants that area locked down).
  for (const denied of restrictions.fs_read.deny.map((p) => expandHome(p))) {
    if (rootsCover(denied, writeRoots)) continue;
    const tokenCursor = cursorWriteToken(denied);
    const tokenEdit = claudeEditToken(denied);
    const tokenWrite = claudeWriteToken(denied);
    if (!cursorDeny.includes(tokenCursor)) cursorDeny.push(tokenCursor);
    if (!claudeDeny.includes(tokenEdit)) claudeDeny.push(tokenEdit);
    if (!claudeDeny.includes(tokenWrite)) claudeDeny.push(tokenWrite);
  }

  if (restrictions.shell.mode === "off") {
    cursorDeny.push("Shell(*)");
    claudeDeny.push("Bash");
  } else if (restrictions.shell.mode === "deny_patterns") {
    for (const pattern of restrictions.shell.deny) {
      const trimmed = pattern.trim();
      if (!trimmed) continue;
      cursorDeny.push(trimmed.startsWith("Shell(") ? trimmed : `Shell(${trimmed})`);
      claudeDeny.push(trimmed.startsWith("Bash(") ? trimmed : `Bash(${trimmed})`);
    }
    claudeAllow.push("Bash");
  } else {
    claudeAllow.push("Bash");
  }

  const codexSandbox = mapCodexSandbox(restrictions, writeRoots, workspaceDir);

  return {
    restrictions,
    writeRoots,
    readDeny,
    cursor: { permissions: { allow: cursorAllow, deny: cursorDeny } },
    claude: { permissions: { allow: claudeAllow, deny: claudeDeny } },
    codexSandbox,
    summary: {
      write: writeSummary(restrictions, writeRoots),
      read: readSummary(readDeny),
      shell: shellSummary(restrictions),
    },
  };
}

export function materializeCursorPermissions(workspaceDir: string, perms: HarnessPermissions): string {
  const dir = path.join(workspaceDir, ".cursor");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "cli.json");
  writeFileSync(file, `${JSON.stringify(perms.cursor, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function claudeSettingsArg(perms: HarnessPermissions): string {
  return JSON.stringify(perms.claude);
}

export function logRestrictionsSummary(perms: HarnessPermissions, log: (msg: string) => void = console.error): void {
  log(
    `restrictions applied: write=${perms.summary.write} read=${perms.summary.read} shell=${perms.summary.shell} codex_sandbox=${perms.codexSandbox}`,
  );
}

export { DEFAULT_RESTRICTIONS, resolveRestrictions };
export type { RestrictionsConfig, ResolvedRestrictions };
