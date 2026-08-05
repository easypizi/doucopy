import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runUninstall } from "../src/uninstall.js";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "doucopy-un-"));
}

describe("runUninstall", () => {
  it("stops daemon and leaves config without purge", async () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".doucopy"), { recursive: true });
    writeFileSync(path.join(home, ".doucopy/config.json"), "{}");
    writeFileSync(path.join(home, ".doucopy/responder.cmd"), "@echo off\n");
    const stop = vi.fn();
    const messages: string[] = [];
    await runUninstall({
      home,
      purge: false,
      yes: true,
      stopDaemon: stop,
      log: (m) => messages.push(m),
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(existsSync(path.join(home, ".doucopy/config.json"))).toBe(true);
    expect(existsSync(path.join(home, ".doucopy/responder.cmd"))).toBe(false);
    expect(messages.some((m) => m.includes("npm uninstall -g doucopy"))).toBe(true);
  });

  it("purge removes home, skills, and MCP entries", async () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".doucopy"), { recursive: true });
    writeFileSync(path.join(home, ".doucopy/config.json"), "{}");
    mkdirSync(path.join(home, ".cursor/skills/doucopy-ask"), { recursive: true });
    writeFileSync(path.join(home, ".cursor/skills/doucopy-ask/SKILL.md"), "x");
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(home, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          doucopy: { url: "https://x/mcp" },
          other: { url: "https://y" },
        },
      }),
    );
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(
      path.join(home, ".codex/config.toml"),
      ["[mcp_servers.doucopy]", 'url = "https://x/mcp"', "", "[mcp_servers.other]", 'command = "z"', ""].join("\n"),
    );

    await runUninstall({
      home,
      purge: true,
      yes: true,
      stopDaemon: () => {},
      log: () => {},
    });

    expect(existsSync(path.join(home, ".doucopy"))).toBe(false);
    expect(existsSync(path.join(home, ".cursor/skills/doucopy-ask"))).toBe(false);
    const mcp = JSON.parse(readFileSync(path.join(home, ".cursor/mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers.doucopy).toBeUndefined();
    expect(mcp.mcpServers.other).toBeDefined();
    const toml = readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    expect(toml).not.toContain("[mcp_servers.doucopy]");
    expect(toml).toContain("[mcp_servers.other]");
  });

  it("refuses purge without yes on non-interactive confirm", async () => {
    const home = makeHome();
    await expect(
      runUninstall({
        home,
        purge: true,
        yes: false,
        confirm: async () => false,
        stopDaemon: () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/cancelled/i);
  });
});
