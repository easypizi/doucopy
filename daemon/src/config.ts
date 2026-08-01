import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { compileRedactRules, type RedactConfig } from "./redact.js";

export type HarnessKind = "cursor-agent" | "claude" | "codex";

export type FsWriteMode = "workspace_only" | "custom";
export type ShellMode = "off" | "deny_patterns" | "open";

export interface RestrictionsConfig {
  fs_write?: { mode?: FsWriteMode; allow?: string[] };
  fs_read?: { deny?: string[] };
  shell?: { mode?: ShellMode; deny?: string[] };
}

export interface ResolvedRestrictions {
  fs_write: { mode: FsWriteMode; allow: string[] };
  fs_read: { deny: string[] };
  shell: { mode: ShellMode; deny: string[] };
}

/**
 * Always denied for reads. Cannot be cleared by config.
 * Note: `~/.doucopy` is NOT listed here as a blanket root. The conversation
 * workspace lives under it, and Cursor deny-wins would block `task.md`.
 * `buildPermissions` adds targeted denials for config/policy/sibling workspaces.
 */
export const BUILTIN_READ_DENY = ["~/.ssh", "~/.aws"] as const;

/** Home dir for doucopy state. Targeted read/write denials are derived from this. */
export const DOUCOPY_HOME = "~/.doucopy" as const;

export const DEFAULT_RESTRICTIONS: ResolvedRestrictions = {
  fs_write: { mode: "workspace_only", allow: [] },
  fs_read: { deny: [] },
  shell: { mode: "off", deny: [] },
};

export interface KeepAwakeConfig {
  /** Prevent idle sleep while the responder daemon runs (via caffeinate). Default true. */
  enabled?: boolean;
  /** Ask every N days whether to keep the daemon. 0 = never ask. Default 3. */
  confirm_days?: number;
  /** Hours to wait for a confirm answer before stopping the daemon. Default 24. */
  confirm_grace_hours?: number;
}

export interface ResolvedKeepAwake {
  enabled: boolean;
  confirm_days: number;
  confirm_grace_hours: number;
}

export const DEFAULT_KEEP_AWAKE: ResolvedKeepAwake = {
  enabled: true,
  confirm_days: 3,
  confirm_grace_hours: 24,
};

export interface DaemonConfig {
  relay_url: string;
  self_peer: string;
  token: string;
  memory_sources: {
    /** One glob or several (Cursor + Claude Code + Codex). Normalized to string[] on load. */
    transcripts_glob: string | string[];
    agents_md_roots: string[];
    extra_files: string[];
  };
  responder: {
    harness?: HarnessKind;
    binary?: string;
    cursor_agent_binary?: string;
    workspace_dir: string;
    response_timeout_seconds: number;
    max_concurrent?: number;
    model?: string;
    persona?: string;
    extra_args?: string[];
  };
  restrictions?: RestrictionsConfig;
  redact?: Partial<RedactConfig>;
  keep_awake?: KeepAwakeConfig;
}

/** Normalize transcripts_glob to a non-empty string array (after expandHome). */
export function normalizeTranscriptGlobs(value: string | string[]): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((g) => g.trim()).filter((g) => g.length > 0);
}

const HARNESS_DEFAULT_BINARY: Record<HarnessKind, string> = {
  "cursor-agent": "cursor-agent",
  claude: "claude",
  codex: "codex",
};

export function resolveHarness(config: DaemonConfig): { kind: HarnessKind; binary: string } {
  const kind = config.responder.harness ?? "cursor-agent";
  const binary =
    config.responder.binary
    ?? (kind === "cursor-agent" ? config.responder.cursor_agent_binary : undefined)
    ?? HARNESS_DEFAULT_BINARY[kind];
  return { kind, binary };
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

export function resolveRestrictions(raw?: RestrictionsConfig): ResolvedRestrictions {
  if (raw === undefined) {
    return {
      fs_write: { ...DEFAULT_RESTRICTIONS.fs_write, allow: [] },
      fs_read: { deny: [] },
      shell: { ...DEFAULT_RESTRICTIONS.shell, deny: [] },
    };
  }
  const writeMode = raw.fs_write?.mode ?? "workspace_only";
  const shellMode = raw.shell?.mode ?? "off";
  return {
    fs_write: {
      mode: writeMode,
      allow: [...(raw.fs_write?.allow ?? [])],
    },
    fs_read: {
      deny: [...(raw.fs_read?.deny ?? [])],
    },
    shell: {
      mode: shellMode,
      deny: [...(raw.shell?.deny ?? [])],
    },
  };
}

export function resolveKeepAwake(raw?: KeepAwakeConfig): ResolvedKeepAwake {
  return {
    enabled: raw?.enabled ?? DEFAULT_KEEP_AWAKE.enabled,
    confirm_days: raw?.confirm_days ?? DEFAULT_KEEP_AWAKE.confirm_days,
    confirm_grace_hours: raw?.confirm_grace_hours ?? DEFAULT_KEEP_AWAKE.confirm_grace_hours,
  };
}

function validateKeepAwake(raw: unknown): KeepAwakeConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config: keep_awake must be an object");
  }
  const k = raw as KeepAwakeConfig;
  if (k.enabled !== undefined && typeof k.enabled !== "boolean") {
    throw new Error("config: keep_awake.enabled must be a boolean");
  }
  if (k.confirm_days !== undefined) {
    if (typeof k.confirm_days !== "number" || !Number.isInteger(k.confirm_days) || k.confirm_days < 0) {
      throw new Error("config: keep_awake.confirm_days must be a non-negative integer");
    }
  }
  if (k.confirm_grace_hours !== undefined) {
    if (
      typeof k.confirm_grace_hours !== "number"
      || !Number.isFinite(k.confirm_grace_hours)
      || k.confirm_grace_hours <= 0
    ) {
      throw new Error("config: keep_awake.confirm_grace_hours must be a positive number");
    }
  }
  return k;
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
    throw new Error(`config: ${label} must be an array of strings`);
  }
}

function validateRestrictions(raw: unknown): RestrictionsConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config: restrictions must be an object");
  }
  const r = raw as RestrictionsConfig;
  if (r.fs_write !== undefined) {
    if (typeof r.fs_write !== "object" || r.fs_write === null) {
      throw new Error("config: restrictions.fs_write must be an object");
    }
    if (r.fs_write.mode !== undefined && r.fs_write.mode !== "workspace_only" && r.fs_write.mode !== "custom") {
      throw new Error(`config: restrictions.fs_write.mode must be workspace_only or custom, got ${r.fs_write.mode}`);
    }
    if (r.fs_write.allow !== undefined) assertStringArray(r.fs_write.allow, "restrictions.fs_write.allow");
  }
  if (r.fs_read !== undefined) {
    if (typeof r.fs_read !== "object" || r.fs_read === null) {
      throw new Error("config: restrictions.fs_read must be an object");
    }
    if (r.fs_read.deny !== undefined) assertStringArray(r.fs_read.deny, "restrictions.fs_read.deny");
  }
  if (r.shell !== undefined) {
    if (typeof r.shell !== "object" || r.shell === null) {
      throw new Error("config: restrictions.shell must be an object");
    }
    if (
      r.shell.mode !== undefined
      && r.shell.mode !== "off"
      && r.shell.mode !== "deny_patterns"
      && r.shell.mode !== "open"
    ) {
      throw new Error(`config: restrictions.shell.mode must be off, deny_patterns or open, got ${r.shell.mode}`);
    }
    if (r.shell.deny !== undefined) assertStringArray(r.shell.deny, "restrictions.shell.deny");
  }
  return r;
}

export function loadConfig(filePath = "~/.doucopy/config.json"): DaemonConfig {
  const config = JSON.parse(readFileSync(expandHome(filePath), "utf8")) as DaemonConfig;
  for (const key of ["relay_url", "self_peer", "token"] as const) {
    if (!config[key]) throw new Error(`config: missing ${key}`);
  }
  if (!config.memory_sources || typeof config.memory_sources !== "object") {
    throw new Error("config: missing memory_sources");
  }
  const rawGlob = config.memory_sources.transcripts_glob;
  if (
    rawGlob === undefined
    || rawGlob === null
    || rawGlob === ""
    || (Array.isArray(rawGlob) && rawGlob.length === 0)
  ) {
    throw new Error("config: missing memory_sources.transcripts_glob");
  }
  if (typeof rawGlob !== "string" && !(Array.isArray(rawGlob) && rawGlob.every((v) => typeof v === "string"))) {
    throw new Error("config: memory_sources.transcripts_glob must be a string or an array of strings");
  }
  if (!Array.isArray(config.memory_sources.agents_md_roots)) {
    throw new Error("config: missing memory_sources.agents_md_roots");
  }
  if (!Array.isArray(config.memory_sources.extra_files)) {
    throw new Error("config: missing memory_sources.extra_files");
  }
  if (!config.responder || typeof config.responder !== "object") {
    throw new Error("config: missing responder");
  }
  if (config.responder.harness !== undefined && !["cursor-agent", "claude", "codex"].includes(config.responder.harness)) {
    throw new Error(`config: responder.harness must be cursor-agent, claude or codex, got ${config.responder.harness}`);
  }
  const isCursor = (config.responder.harness ?? "cursor-agent") === "cursor-agent";
  if (isCursor && !config.responder.binary && !config.responder.cursor_agent_binary) {
    throw new Error("config: missing responder.binary (or legacy responder.cursor_agent_binary)");
  }
  if (config.responder.extra_args !== undefined && !(Array.isArray(config.responder.extra_args) && config.responder.extra_args.every((v) => typeof v === "string"))) {
    throw new Error("config: responder.extra_args must be an array of strings");
  }
  if (config.responder.persona !== undefined && typeof config.responder.persona !== "string") {
    throw new Error("config: responder.persona must be a string");
  }
  if (!config.responder.workspace_dir) {
    throw new Error("config: missing responder.workspace_dir");
  }
  if (
    typeof config.responder.response_timeout_seconds !== "number" ||
    config.responder.response_timeout_seconds <= 0
  ) {
    throw new Error("config: missing responder.response_timeout_seconds");
  }
  if (
    config.responder.max_concurrent !== undefined &&
    (!Number.isInteger(config.responder.max_concurrent) || config.responder.max_concurrent <= 0)
  ) {
    throw new Error("config: responder.max_concurrent must be a positive integer");
  }
  config.restrictions = validateRestrictions(config.restrictions);
  config.keep_awake = validateKeepAwake(config.keep_awake);
  if (config.redact !== undefined) {
    if (typeof config.redact !== "object" || config.redact === null) {
      throw new Error("config: redact must be an object");
    }
    for (const key of ["literals", "patterns"] as const) {
      const value = config.redact[key];
      if (value !== undefined && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
        throw new Error(`config: redact.${key} must be an array of strings`);
      }
    }
    try {
      compileRedactRules(config.redact);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`config: invalid redact pattern: ${message}`);
    }
  }
  config.relay_url = config.relay_url.replace(/\/+$/, "");
  config.memory_sources.transcripts_glob = normalizeTranscriptGlobs(config.memory_sources.transcripts_glob).map(expandHome);
  if (config.memory_sources.transcripts_glob.length === 0) {
    throw new Error("config: memory_sources.transcripts_glob must contain at least one non-empty glob");
  }
  config.memory_sources.agents_md_roots = config.memory_sources.agents_md_roots.map(expandHome);
  config.memory_sources.extra_files = config.memory_sources.extra_files.map(expandHome);
  config.responder.workspace_dir = expandHome(config.responder.workspace_dir);
  if (config.restrictions?.fs_write?.allow) {
    config.restrictions.fs_write.allow = config.restrictions.fs_write.allow.map(expandHome);
  }
  if (config.restrictions?.fs_read?.deny) {
    config.restrictions.fs_read.deny = config.restrictions.fs_read.deny.map(expandHome);
  }
  return config;
}
