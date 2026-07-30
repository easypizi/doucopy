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

/** Always denied for reads. Cannot be cleared by config. */
export const BUILTIN_READ_DENY = ["~/.ssh", "~/.aws", "~/.doucopy"] as const;

export const DEFAULT_RESTRICTIONS: ResolvedRestrictions = {
  fs_write: { mode: "workspace_only", allow: [] },
  fs_read: { deny: [] },
  shell: { mode: "off", deny: [] },
};

export interface DaemonConfig {
  relay_url: string;
  self_peer: string;
  token: string;
  memory_sources: { transcripts_glob: string; agents_md_roots: string[]; extra_files: string[] };
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
  if (
    !config.memory_sources.transcripts_glob ||
    typeof config.memory_sources.transcripts_glob !== "string"
  ) {
    throw new Error("config: missing memory_sources.transcripts_glob");
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
  config.memory_sources.transcripts_glob = expandHome(config.memory_sources.transcripts_glob);
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
