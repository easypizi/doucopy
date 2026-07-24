import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface DaemonConfig {
  relay_url: string;
  self_peer: string;
  token: string;
  memory_sources: { transcripts_glob: string; agents_md_roots: string[]; extra_files: string[] };
  responder: {
    cursor_agent_binary: string;
    workspace_dir: string;
    response_timeout_seconds: number;
    model?: string;
  };
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
  config.memory_sources.transcripts_glob = expandHome(config.memory_sources.transcripts_glob);
  config.memory_sources.agents_md_roots = config.memory_sources.agents_md_roots.map(expandHome);
  config.memory_sources.extra_files = config.memory_sources.extra_files.map(expandHome);
  config.responder.workspace_dir = expandHome(config.responder.workspace_dir);
  return config;
}
