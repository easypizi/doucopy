import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandHome, loadConfig } from "../src/config.js";

const VALID = {
  relay_url: "https://example.com",
  self_peer: "work",
  token: "tok",
  memory_sources: {
    transcripts_glob: "~/.cursor/projects/*/agent-transcripts/*.jsonl",
    agents_md_roots: ["~/dev"],
    extra_files: [],
  },
  responder: {
    cursor_agent_binary: "cursor-agent",
    workspace_dir: "~/.agent-link/workspace",
    response_timeout_seconds: 300,
    model: "sonnet-4-thinking",
  },
};

describe("expandHome", () => {
  it("expands the tilde prefix", () => {
    expect(expandHome("~/x")).toBe(path.join(homedir(), "x"));
    expect(expandHome("/abs/x")).toBe("/abs/x");
  });
});

describe("loadConfig", () => {
  it("loads and expands paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(VALID));
    const config = loadConfig(file);
    expect(config.self_peer).toBe("work");
    expect(config.responder.workspace_dir).toBe(path.join(homedir(), ".agent-link/workspace"));
    expect(config.memory_sources.agents_md_roots[0]).toBe(path.join(homedir(), "dev"));
  });

  it("rejects a config without a token", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-link-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...VALID, token: "" }));
    expect(() => loadConfig(file)).toThrow(/token/);
  });
});
