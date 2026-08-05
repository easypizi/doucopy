import { describe, expect, it, vi } from "vitest";
import {
  HARNESS_IDS,
  installCommand,
  listInstallCandidates,
  loginCommand,
  probeHarness,
  type HarnessId,
  type ProbeDeps,
} from "../src/harness-install.js";

function deps(partial: Partial<ProbeDeps> & { installed?: Partial<Record<HarnessId, boolean>>; authed?: Partial<Record<HarnessId, boolean>> }): ProbeDeps {
  const installed = { cursor: false, claude: false, codex: false, ...partial.installed };
  const authed = { cursor: false, claude: false, codex: false, ...partial.authed };
  return {
    platform: partial.platform ?? "darwin",
    binaryPresent: (id) => installed[id] ?? false,
    runAuthStatus: async (id) => ({ ok: Boolean(authed[id]), stdout: "", stderr: "" }),
    ...partial,
  };
}

describe("installCommand / loginCommand", () => {
  it("uses curl for Cursor on darwin and PowerShell on win32", () => {
    const mac = installCommand("cursor", "darwin");
    expect(mac.shell).toBe(true);
    expect(mac.command).toContain("curl https://cursor.com/install");

    const win = installCommand("cursor", "win32");
    expect(win.shell).toBe(true);
    expect(win.command).toContain("install?win32=true");
  });

  it("uses npm for Claude and Codex on both platforms", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(installCommand("claude", platform)).toEqual({
        command: "npm",
        args: ["install", "-g", "@anthropic-ai/claude-code"],
        shell: false,
      });
      expect(installCommand("codex", platform)).toEqual({
        command: "npm",
        args: ["install", "-g", "@openai/codex"],
        shell: false,
      });
    }
  });

  it("maps login commands", () => {
    expect(loginCommand("cursor")).toEqual({ command: "agent", args: ["login"], fallback: { command: "cursor-agent", args: ["login"] } });
    expect(loginCommand("claude")).toEqual({ command: "claude", args: ["auth", "login"] });
    expect(loginCommand("codex")).toEqual({ command: "codex", args: ["login"] });
  });
});

describe("probeHarness", () => {
  it("is ready only when installed and authed", async () => {
    expect(await probeHarness("claude", deps({ installed: { claude: true }, authed: { claude: true } }))).toEqual({
      id: "claude",
      installed: true,
      authenticated: true,
      ready: true,
    });
    expect(await probeHarness("claude", deps({ installed: { claude: true }, authed: { claude: false } }))).toEqual({
      id: "claude",
      installed: true,
      authenticated: false,
      ready: false,
    });
    expect(await probeHarness("claude", deps({ installed: { claude: false } }))).toEqual({
      id: "claude",
      installed: false,
      authenticated: false,
      ready: false,
    });
  });
});

describe("listInstallCandidates", () => {
  it("returns all harnesses when none are ready", async () => {
    const list = await listInstallCandidates(deps({}));
    expect(list.map((c) => c.id)).toEqual([...HARNESS_IDS]);
  });

  it("returns empty when at least one harness is ready", async () => {
    const runAuth = vi.fn(async (id: HarnessId) => ({ ok: id === "cursor", stdout: "", stderr: "" }));
    const list = await listInstallCandidates(
      deps({
        installed: { cursor: true },
        runAuthStatus: runAuth,
      }),
    );
    expect(list).toEqual([]);
  });

  it("includes installed-but-unauthed harnesses when none are ready", async () => {
    const list = await listInstallCandidates(
      deps({
        installed: { claude: true, codex: true },
        authed: { claude: false, codex: false },
      }),
    );
    expect(list.map((c) => c.id).sort()).toEqual(["claude", "codex", "cursor"]);
  });
});
