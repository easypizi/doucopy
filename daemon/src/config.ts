import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { compileRedactRules, type RedactConfig } from "./redact.js";

export interface DaemonConfig {
  relay_url: string;
  self_peer: string;
  token: string;
  memory_sources: { transcripts_glob: string; agents_md_roots: string[]; extra_files: string[] };
  responder: {
    cursor_agent_binary: string;
    workspace_dir: string;
    response_timeout_seconds: number;
    max_concurrent?: number;
    model?: string;
  };
  redact?: Partial<RedactConfig>;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

export function loadConfig(filePath = "~/.agent-link/config.json"): DaemonConfig {
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
  if (!config.responder.cursor_agent_binary) {
    throw new Error("config: missing responder.cursor_agent_binary");
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
  return config;
}
