import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  killProcessTree,
  quoteWinArg,
  resolveSpawn,
} from "../src/win-spawn.js";

describe("quoteWinArg", () => {
  it("leaves plain tokens alone", () => {
    expect(quoteWinArg("--sandbox")).toBe("--sandbox");
    expect(quoteWinArg("workspace-write")).toBe("workspace-write");
  });

  it("wraps tokens with spaces and doubles inner quotes", () => {
    expect(quoteWinArg("Read the file")).toBe('"Read the file"');
    expect(quoteWinArg('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes the empty string", () => {
    expect(quoteWinArg("")).toBe('""');
  });
});

describe("resolveSpawn", () => {
  it("keeps POSIX spawn as detached non-shell", () => {
    const resolved = resolveSpawn("claude", ["-p", "hello world"], {
      platform: "darwin",
    });
    expect(resolved).toEqual({
      command: "claude",
      args: ["-p", "hello world"],
      shell: false,
      detached: true,
      windowsHide: true,
    });
  });

  it("resolves .cmd shims on win32 and enables shell + quoting", () => {
    const exists = (p: string) => p === "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd";
    const resolved = resolveSpawn(
      "claude",
      ["-p", "Read the file task.md", "--permission-mode", "dontAsk"],
      {
        platform: "win32",
        pathEnv: "C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Windows\\System32",
        pathSep: ";",
        exists,
      },
    );
    expect(resolved.command).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
    expect(resolved.shell).toBe(true);
    expect(resolved.detached).toBe(false);
    expect(resolved.windowsHide).toBe(true);
    expect(resolved.args).toEqual([
      "-p",
      '"Read the file task.md"',
      "--permission-mode",
      "dontAsk",
    ]);
  });

  it("spawns resolved .exe without shell", () => {
    const exists = (p: string) => p === "C:\\Program Files\\nodejs\\codex.exe";
    const resolved = resolveSpawn("codex", ["exec", "--sandbox", "workspace-write"], {
      platform: "win32",
      pathEnv: "C:\\Program Files\\nodejs",
      pathSep: ";",
      exists,
    });
    expect(resolved.command).toBe("C:\\Program Files\\nodejs\\codex.exe");
    expect(resolved.shell).toBe(false);
    expect(resolved.args).toEqual(["exec", "--sandbox", "workspace-write"]);
  });

  it("falls back to shell:true for unresolved bare names on win32", () => {
    const resolved = resolveSpawn("cursor-agent", ["create-chat"], {
      platform: "win32",
      pathEnv: "C:\\Windows\\System32",
      pathSep: ";",
      exists: () => false,
    });
    expect(resolved.command).toBe("cursor-agent");
    expect(resolved.shell).toBe(true);
    expect(resolved.detached).toBe(false);
  });
});

describe("killProcessTree", () => {
  it("uses taskkill on win32", () => {
    const taskkill = vi.fn();
    const proc = Object.assign(new EventEmitter(), {
      pid: 4242,
      kill: vi.fn(),
      stdout: { destroy: vi.fn() },
      stderr: { destroy: vi.fn() },
    });
    killProcessTree(proc as never, { platform: "win32", taskkill });
    expect(taskkill).toHaveBeenCalledWith(4242);
    expect(proc.kill).toHaveBeenCalled();
    expect(proc.stdout.destroy).toHaveBeenCalled();
    expect(proc.stderr.destroy).toHaveBeenCalled();
  });

  it("does not call taskkill on darwin", () => {
    const taskkill = vi.fn();
    const proc = Object.assign(new EventEmitter(), {
      pid: undefined,
      kill: vi.fn(),
      stdout: { destroy: vi.fn() },
      stderr: { destroy: vi.fn() },
    });
    killProcessTree(proc as never, { platform: "darwin", taskkill });
    expect(taskkill).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalled();
  });
});
