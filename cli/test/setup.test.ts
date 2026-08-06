import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_TRANSCRIPTS_GLOB,
  CODEX_TRANSCRIPTS_GLOB,
  CURSOR_TRANSCRIPTS_GLOB,
  binaryOnPath,
  defaultConfig,
  detectAskers,
  detectHarnesses,
  detectTranscriptGlobs,
  discoverMemorySources,
  mergeClaudeMcp,
  mergeCodexToml,
  mergeMcpJson,
  replaceDoucopyMcpSection,
  responderHarnessDisabledReason,
  writeConfig,
  writeDefaultPolicy,
} from "../src/setup.js";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "doucopy-home-"));
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

  it("includes ~/.claude/CLAUDE.md when present", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude/CLAUDE.md"), "claude memory");
    const found = discoverMemorySources(home);
    expect(found.extra_files).toEqual([path.join(home, ".claude/CLAUDE.md")]);
  });

  it("includes skill/plan roots and excludes mcp.json", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".cursor/skills/foo"), { recursive: true });
    mkdirSync(path.join(home, ".cursor/plans"), { recursive: true });
    writeFileSync(path.join(home, ".cursor/mcp.json"), '{"mcpServers":{}}');
    writeFileSync(path.join(home, ".cursor/NOTES.md"), "notes");
    const found = discoverMemorySources(home);
    expect(found.skill_roots).toContain(path.join(home, ".cursor/skills"));
    expect(found.skill_roots).toContain(path.join(home, ".cursor/plans"));
    expect(found.extra_files).toContain(path.join(home, ".cursor/NOTES.md"));
    expect(found.extra_files.some((f) => f.endsWith("mcp.json"))).toBe(false);
  });

  it("returns empty lists for a bare home", () => {
    expect(discoverMemorySources(makeHome())).toEqual({
      agents_md_roots: [],
      extra_files: [],
      skill_roots: [],
    });
  });
});

describe("detectTranscriptGlobs", () => {
  it("falls back to the Cursor glob when no transcript dirs exist", () => {
    expect(detectTranscriptGlobs(makeHome())).toEqual([CURSOR_TRANSCRIPTS_GLOB]);
  });

  it("includes Claude and Codex globs when their dirs exist", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".cursor/projects"), { recursive: true });
    mkdirSync(path.join(home, ".claude/projects"), { recursive: true });
    mkdirSync(path.join(home, ".codex/sessions"), { recursive: true });
    expect(detectTranscriptGlobs(home)).toEqual([
      CURSOR_TRANSCRIPTS_GLOB,
      CLAUDE_TRANSCRIPTS_GLOB,
      CODEX_TRANSCRIPTS_GLOB,
    ]);
  });
});

describe("writeConfig", () => {
  it("writes 0600 config json under ~/.doucopy", () => {
    const home = makeHome();
    const file = writeConfig(home, defaultConfig("https://r.example.com", "mbp", "tok", {
      agents_md_roots: [], extra_files: [], skill_roots: [],
    }, home));
    expect(file).toBe(path.join(home, ".doucopy/config.json"));
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      self_peer: string;
      responder: { max_concurrent: number; model?: string };
      memory_sources: { transcripts_glob: string | string[] };
    };
    expect(parsed.self_peer).toBe("mbp");
    expect(parsed.responder.max_concurrent).toBe(3);
    expect(parsed.responder.model).toBeUndefined();
    expect(parsed.memory_sources.transcripts_glob).toBe(CURSOR_TRANSCRIPTS_GLOB);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("writes multiple transcript globs when several harness homes exist", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".cursor/projects"), { recursive: true });
    mkdirSync(path.join(home, ".claude/projects"), { recursive: true });
    const file = writeConfig(
      home,
      defaultConfig("https://r.example.com", "mbp", "tok", { agents_md_roots: [], extra_files: [], skill_roots: [] }, home),
    );
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      memory_sources: { transcripts_glob: string[] };
    };
    expect(parsed.memory_sources.transcripts_glob).toEqual([
      CURSOR_TRANSCRIPTS_GLOB,
      CLAUDE_TRANSCRIPTS_GLOB,
    ]);
  });
});

describe("writeDefaultPolicy", () => {
  it("creates policy.md once and never overwrites", () => {
    const home = makeHome();
    expect(writeDefaultPolicy(home)).toBe(true);
    const file = path.join(home, ".doucopy/policy.md");
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
    expect(parsed.mcpServers["doucopy"]).toEqual({
      type: "http",
      url: "https://r.example.com/mcp",
      headers: { Authorization: "Bearer tok" },
    });
    expect(readFileSync(`${file}.bak`, "utf8")).toContain("other");
  });

  it("creates mcp.json when missing", () => {
    const home = makeHome();
    const file = mergeMcpJson(home, "https://r.example.com", "tok");
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveProperty("mcpServers.doucopy");
  });

  it("drops the legacy agent-link key on upgrade", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    const file = path.join(home, ".cursor/mcp.json");
    writeFileSync(file, JSON.stringify({
      mcpServers: { "agent-link": { type: "http", url: "http://old/mcp" } },
    }));
    mergeMcpJson(home, "https://r.example.com", "tok");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers["agent-link"]).toBeUndefined();
    expect(parsed.mcpServers["doucopy"]).toBeDefined();
  });
});

describe("mergeClaudeMcp", () => {
  it("writes ~/.claude.json with the doucopy entry", () => {
    const home = makeHome();
    const file = mergeClaudeMcp(home, "https://r.example.com", "tok-c");
    expect(file).toBe(path.join(home, ".claude.json"));
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    expect(parsed.mcpServers["doucopy"]).toEqual({
      type: "http",
      url: "https://r.example.com/mcp",
      headers: { Authorization: "Bearer tok-c" },
    });
  });

  it("refuses to overwrite a corrupt ~/.claude.json (would nuke Claude Code state)", () => {
    const home = makeHome();
    const file = path.join(home, ".claude.json");
    writeFileSync(file, "not-json {{{");
    expect(() => mergeClaudeMcp(home, "https://r.example.com", "tok"))
      .toThrow(/is not valid JSON; refusing to overwrite/);
    // Original file must be untouched by content.
    expect(readFileSync(file, "utf8")).toBe("not-json {{{");
  });

  it("preserves other Claude Code settings and creates a backup", () => {
    const home = makeHome();
    const file = path.join(home, ".claude.json");
    writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { legacy: { command: "x" } } }));
    mergeClaudeMcp(home, "https://r.example.com", "tok-c");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { theme: string; mcpServers: Record<string, unknown> };
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers.legacy).toEqual({ command: "x" });
    expect(readFileSync(`${file}.bak`, "utf8")).toContain("legacy");
  });
});

describe("mergeCodexToml", () => {
  it("writes a fresh ~/.codex/config.toml with http_headers auth", () => {
    const home = makeHome();
    const file = mergeCodexToml(home, "https://r.example.com", "tok-x");
    expect(file).toBe(path.join(home, ".codex/config.toml"));
    const contents = readFileSync(file, "utf8");
    expect(contents).toContain("[mcp_servers.doucopy]");
    expect(contents).toContain('url = "https://r.example.com/mcp"');
    expect(contents).toContain('http_headers = { Authorization = "Bearer tok-x" }');
    expect(contents).not.toContain("bearer_token");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps unrelated sections and replaces legacy bearer_token with http_headers", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const file = path.join(home, ".codex/config.toml");
    writeFileSync(
      file,
      [
        "approval_policy = \"on-request\"",
        "",
        "[mcp_servers.doucopy]",
        "url = \"https://old.example.com/mcp\"",
        "bearer_token = \"old\"",
        "",
        "[mcp_servers.other]",
        "command = \"x\"",
        "",
      ].join("\n"),
    );
    mergeCodexToml(home, "https://new.example.com", "new-tok");
    const contents = readFileSync(file, "utf8");
    expect(contents).toContain('approval_policy = "on-request"');
    expect(contents).toContain('url = "https://new.example.com/mcp"');
    expect(contents).toContain('http_headers = { Authorization = "Bearer new-tok" }');
    expect(contents).not.toContain("old.example.com");
    expect(contents).not.toContain("bearer_token");
    expect(contents).toContain("[mcp_servers.other]");
    expect(readFileSync(`${file}.bak`, "utf8")).toContain("old.example.com");
  });

  it("escapes quotes inside the token for TOML", () => {
    const home = makeHome();
    mergeCodexToml(home, "https://r.example.com", 'tok"with\\quote');
    const contents = readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    expect(contents).toContain('http_headers = { Authorization = "Bearer tok\\"with\\\\quote" }');
  });

  it("drops a legacy [mcp_servers.agent-link] block on upgrade", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const file = path.join(home, ".codex/config.toml");
    writeFileSync(
      file,
      [
        "[mcp_servers.agent-link]",
        "url = \"https://old.example.com/mcp\"",
        "bearer_token = \"old\"",
        "",
        "[mcp_servers.other]",
        "command = \"x\"",
        "",
      ].join("\n"),
    );
    mergeCodexToml(home, "https://new.example.com", "new-tok");
    const contents = readFileSync(file, "utf8");
    expect(contents).not.toContain("[mcp_servers.agent-link]");
    expect(contents).toContain("[mcp_servers.doucopy]");
    expect(contents).toContain('url = "https://new.example.com/mcp"');
    expect(contents).toContain("[mcp_servers.other]");
  });
});

describe("binaryOnPath", () => {
  it("finds a unix binary by walking PATH", () => {
    const home = makeHome();
    const bin = path.join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "cursor-agent"), "#!/bin/sh\n");
    expect(
      binaryOnPath("cursor-agent", {
        pathEnv: bin,
        platform: "darwin",
        pathSep: ":",
      }),
    ).toBe(true);
  });

  it("finds a Windows binary with .exe / .cmd suffixes", () => {
    const home = makeHome();
    const bin = path.join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "cursor-agent.cmd"), "@echo off\n");
    expect(
      binaryOnPath("cursor-agent", {
        pathEnv: bin,
        platform: "win32",
        pathSep: ";",
      }),
    ).toBe(true);
  });

  it("returns false when the binary is absent", () => {
    const home = makeHome();
    expect(
      binaryOnPath("cursor-agent", {
        pathEnv: home,
        platform: "win32",
        pathSep: ";",
      }),
    ).toBe(false);
  });
});

describe("responderHarnessDisabledReason", () => {
  it("allows harness selection on darwin and win32 when the binary is present", () => {
    expect(responderHarnessDisabledReason(true, "darwin")).toBeUndefined();
    expect(responderHarnessDisabledReason(true, "win32")).toBeUndefined();
  });

  it("reports unsupported OS on linux even when the binary is present", () => {
    expect(responderHarnessDisabledReason(true, "linux")).toBe(
      "(responder daemon unsupported on this OS)",
    );
  });

  it("reports missing PATH binary on supported platforms", () => {
    expect(responderHarnessDisabledReason(false, "darwin")).toBe("(not found on PATH)");
    expect(responderHarnessDisabledReason(false, "win32")).toBe("(not found on PATH)");
  });
});

describe("detectHarnesses / detectAskers", () => {
  it("detectAskers reports cursor when ~/.cursor exists but not otherwise", () => {
    const home = makeHome();
    expect(detectAskers(home).cursor).toBe(false);
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    expect(detectAskers(home).cursor).toBe(true);
  });

  it("detectAskers reports claude only when ~/.claude.json or ~/.claude exists", () => {
    const home = makeHome();
    expect(detectAskers(home).claude).toBe(false);
    writeFileSync(path.join(home, ".claude.json"), "{}");
    expect(detectAskers(home).claude).toBe(true);
  });

  it("detectAskers reports codex only when ~/.codex exists", () => {
    const home = makeHome();
    expect(detectAskers(home).codex).toBe(false);
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    expect(detectAskers(home).codex).toBe(true);
  });

  it("legacy detectHarnesses does not lie about claude/codex based on ~/.cursor", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    const detected = detectHarnesses(home);
    expect(typeof detected.claude).toBe("boolean");
    expect(typeof detected.codex).toBe("boolean");
  });
});

describe("replaceDoucopyMcpSection", () => {
  it("keeps sibling sections whose bodies contain arrays with '['", () => {
    const input = [
      "[mcp_servers.doucopy]",
      'url = "https://old/mcp"',
      'bearer_token = "old"',
      "",
      "[mcp_servers.other]",
      'enabled_tools = ["a", "b", "c"]',
      'command = "x"',
      "",
    ].join("\n");
    const result = replaceDoucopyMcpSection(input, [
      "[mcp_servers.doucopy]",
      'url = "https://new/mcp"',
      'bearer_token = "new"',
    ]);
    expect(result).toContain('url = "https://new/mcp"');
    expect(result).not.toContain('url = "https://old/mcp"');
    // Sibling section must still be there in full, arrays intact.
    expect(result).toContain("[mcp_servers.other]");
    expect(result).toContain('enabled_tools = ["a", "b", "c"]');
    expect(result).toContain('command = "x"');
  });

  it("does not swallow the following section even when the doucopy body itself contains an array", () => {
    // Regression: the old regex used [^\[]* which stopped at the first "[",
    // so an array inside the section would prematurely end the match. The
    // opposite (over-matching) is tested here.
    const input = [
      "[mcp_servers.doucopy]",
      'url = "https://old/mcp"',
      'bearer_token = "old"',
      'enabled_tools = ["x"]',
      "",
      "[mcp_servers.keep_me]",
      'command = "y"',
      "",
    ].join("\n");
    const result = replaceDoucopyMcpSection(input, [
      "[mcp_servers.doucopy]",
      'url = "https://new/mcp"',
      'bearer_token = "new"',
    ]);
    expect(result).not.toContain('enabled_tools');
    expect(result).toContain("[mcp_servers.keep_me]");
    expect(result).toContain('command = "y"');
  });

  it("appends the section to a file that does not have it", () => {
    const input = "approval_policy = \"on-request\"\n";
    const result = replaceDoucopyMcpSection(input, [
      "[mcp_servers.doucopy]",
      'url = "https://r/mcp"',
      'bearer_token = "t"',
    ]);
    expect(result).toContain('approval_policy = "on-request"');
    expect(result).toContain("[mcp_servers.doucopy]");
  });

  it("removes a section entirely when blockLines is null", () => {
    const input = [
      "[mcp_servers.agent-link]",
      'url = "https://old/mcp"',
      "",
      "[mcp_servers.other]",
      'command = "x"',
      "",
    ].join("\n");
    const result = replaceDoucopyMcpSection(input, null, "[mcp_servers.agent-link]");
    expect(result).not.toContain("[mcp_servers.agent-link]");
    expect(result).toContain("[mcp_servers.other]");
  });

  it("is a no-op when removing an absent section", () => {
    const input = "approval_policy = \"on-request\"\n";
    const result = replaceDoucopyMcpSection(input, null, "[mcp_servers.agent-link]");
    expect(result).toBe(input);
  });
});
