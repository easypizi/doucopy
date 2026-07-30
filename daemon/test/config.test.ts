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
    workspace_dir: "~/.doucopy/workspace",
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
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(VALID));
    const config = loadConfig(file);
    expect(config.self_peer).toBe("work");
    expect(config.responder.workspace_dir).toBe(path.join(homedir(), ".doucopy/workspace"));
    expect(config.memory_sources.agents_md_roots[0]).toBe(path.join(homedir(), "dev"));
  });

  it("rejects a config without a token", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...VALID, token: "" }));
    expect(() => loadConfig(file)).toThrow(/token/);
  });

  it("rejects a config without relay_url", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...VALID, relay_url: "" }));
    expect(() => loadConfig(file)).toThrow(/relay_url/);
  });

  it("rejects a config without self_peer", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...VALID, self_peer: "" }));
    expect(() => loadConfig(file)).toThrow(/self_peer/);
  });

  it("rejects a config without memory_sources", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    const { memory_sources: _memorySources, ...rest } = VALID;
    writeFileSync(file, JSON.stringify(rest));
    expect(() => loadConfig(file)).toThrow(/memory_sources/);
  });

  it("accepts a valid redact section", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({ ...VALID, redact: { literals: ["Acme"], patterns: ["project-\\w+"] } }),
    );
    expect(loadConfig(file).redact?.literals).toEqual(["Acme"]);
  });

  it("rejects redact rules that are not string arrays", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...VALID, redact: { literals: [42] } }));
    expect(() => loadConfig(file)).toThrow(/redact\.literals/);
  });

  it("strips trailing slashes from relay_url so poll URLs are never doubled", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...VALID, relay_url: "https://example.com//" }));
    expect(loadConfig(file).relay_url).toBe("https://example.com");
  });

  it("rejects an invalid redact regex at load time", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...VALID, redact: { patterns: ["[unclosed"] } }));
    expect(() => loadConfig(file)).toThrow(/invalid redact pattern/);
  });

  it("accepts a restrictions section and expands allow/deny paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        ...VALID,
        restrictions: {
          fs_write: { mode: "custom", allow: ["~/Desktop"] },
          fs_read: { deny: ["~/Documents/finance"] },
          shell: { mode: "deny_patterns", deny: ["rm"] },
        },
        responder: { ...VALID.responder, persona: "brief" },
      }),
    );
    const config = loadConfig(file);
    expect(config.restrictions?.fs_write?.mode).toBe("custom");
    expect(config.restrictions?.fs_write?.allow).toEqual([path.join(homedir(), "Desktop")]);
    expect(config.restrictions?.fs_read?.deny).toEqual([path.join(homedir(), "Documents/finance")]);
    expect(config.restrictions?.shell?.mode).toBe("deny_patterns");
    expect(config.responder.persona).toBe("brief");
  });

  it("allows missing restrictions (safe default applied at runtime)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(VALID));
    expect(loadConfig(file).restrictions).toBeUndefined();
  });

  it("rejects invalid restrictions.fs_write.mode", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({ ...VALID, restrictions: { fs_write: { mode: "anywhere" } } }),
    );
    expect(() => loadConfig(file)).toThrow(/fs_write\.mode/);
  });

  it("rejects non-string responder.persona", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...VALID, responder: { ...VALID.responder, persona: 1 } }));
    expect(() => loadConfig(file)).toThrow(/persona/);
  });
});
