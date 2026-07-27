import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  discoverMemorySources,
  mergeMcpJson,
  writeConfig,
  writeDefaultPolicy,
} from "../src/setup.js";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-link-home-"));
}

describe("discoverMemorySources", () => {
  it("finds AGENTS.md roots and global cursor markdown", () => {
    const home = makeHome();
    mkdirSync(path.join(home, "dev/proj"), { recursive: true });
    writeFileSync(path.join(home, "dev/proj/AGENTS.md"), "memory");
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(path.join(home, ".cursor/SKILLS_INDEX.md"), "index");
    const found = discoverMemorySources(home);
    expect(found.agents_md_roots).toEqual([path.join(home, "dev")]);
    expect(found.extra_files).toEqual([path.join(home, ".cursor/SKILLS_INDEX.md")]);
  });

  it("returns empty lists for a bare home", () => {
    expect(discoverMemorySources(makeHome())).toEqual({ agents_md_roots: [], extra_files: [] });
  });
});

describe("writeConfig", () => {
  it("writes 0600 config json under ~/.agent-link", () => {
    const home = makeHome();
    const file = writeConfig(home, defaultConfig("https://r.example.com", "mbp", "tok", {
      agents_md_roots: [], extra_files: [],
    }));
    expect(file).toBe(path.join(home, ".agent-link/config.json"));
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { self_peer: string; responder: { max_concurrent: number } };
    expect(parsed.self_peer).toBe("mbp");
    expect(parsed.responder.max_concurrent).toBe(3);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("writeDefaultPolicy", () => {
  it("creates policy.md once and never overwrites", () => {
    const home = makeHome();
    expect(writeDefaultPolicy(home)).toBe(true);
    const file = path.join(home, ".agent-link/policy.md");
    writeFileSync(file, "customized");
    expect(writeDefaultPolicy(home)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("customized");
  });
});

describe("mergeMcpJson", () => {
  it("merges into an existing mcp.json with a backup", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    const file = path.join(home, ".cursor/mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { url: "http://x" } } }));
    mergeMcpJson(home, "https://r.example.com", "tok");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(parsed.mcpServers.other.url).toBe("http://x");
    expect(parsed.mcpServers["agent-link"]).toEqual({
      url: "https://r.example.com/mcp",
      headers: { Authorization: "Bearer tok" },
    });
    expect(readFileSync(`${file}.bak`, "utf8")).toContain("other");
  });

  it("creates mcp.json when missing", () => {
    const home = makeHome();
    const file = mergeMcpJson(home, "https://r.example.com", "tok");
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveProperty("mcpServers.agent-link");
  });
});
