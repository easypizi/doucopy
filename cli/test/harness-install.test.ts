import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HARNESS_IDS,
  installCommand,
  installMissingHarnesses,
  listInstallCandidates,
  loginCommand,
  loginWithInherit,
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

describe("installMissingHarnesses / loginWithInherit", () => {
  it("installs missing and returns ids that still need login", async () => {
    const installed: Record<HarnessId, boolean> = { cursor: false, claude: true, codex: false };
    const needLogin = await installMissingHarnesses(["cursor", "claude"], {
      ...deps({
        installed,
        authed: { claude: false },
        binaryPresent: (id) => installed[id],
      }),
      runInstall: async (id) => {
        installed[id] = true;
        return { ok: true, stdout: "", stderr: "" };
      },
      log: () => undefined,
    });
    expect(installed.cursor).toBe(true);
    expect(needLogin.sort()).toEqual(["claude", "cursor"]);
  });

  it("loginWithInherit uses stdio inherit and fallback", () => {
    const calls: Array<{ command: string; stdio: unknown }> = [];
    const spawnSyncFn = ((command: string, _args?: string[], opts?: { stdio?: unknown }) => {
      calls.push({ command, stdio: opts?.stdio });
      if (command === "agent") {
        return { status: 127, error: new Error("missing"), stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }) as typeof import("node:child_process").spawnSync;

    const result = loginWithInherit("cursor", { spawnSyncFn });
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual({ command: "agent", stdio: "inherit" });
    expect(calls[1]?.command).toBe("cursor-agent");
    expect(calls[1]?.stdio).toBe("inherit");
  });
});

describe("setup-resume file", () => {
  it("round-trips pending logins", async () => {
    const { writeSetupResume, readSetupResume, clearSetupResume } = await import("../src/setup-resume.js");
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-resume-"));
    writeSetupResume(home, {
      draft: { relayUrl: "https://r.example.com", peer: "p", token: "t" },
      pendingLogins: ["claude"],
      resumePhase: "askers",
      setupMode: false,
      argv: [],
    });
    expect(readSetupResume(home)?.pendingLogins).toEqual(["claude"]);
    clearSetupResume(home);
    expect(readSetupResume(home)).toBeNull();
  });
});

