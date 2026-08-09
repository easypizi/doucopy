import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ResolveSpawnOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  pathSep?: string;
  exists?: (candidate: string) => boolean;
}

export interface ResolvedSpawn {
  command: string;
  args: string[];
  shell: boolean;
  detached: boolean;
  windowsHide: boolean;
}

/** Quote a single argv token for cmd.exe when spawn uses shell:true. */
export function quoteWinArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/gu, '""')}"`;
}

function isBatchFile(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

function findOnPath(
  binary: string,
  opts: ResolveSpawnOptions,
): string | undefined {
  const platform = opts.platform ?? process.platform;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const pathSep = opts.pathSep ?? (platform === "win32" ? ";" : ":");
  const exists = opts.exists ?? existsSync;
  const p = platform === "win32" ? path.win32 : path.posix;

  // Absolute / relative path with a directory component: check as-is (+ win extensions).
  if (binary.includes("/") || binary.includes("\\")) {
    if (platform === "win32") {
      for (const name of [binary, `${binary}.exe`, `${binary}.cmd`, `${binary}.bat`]) {
        if (exists(name)) return name;
      }
      return undefined;
    }
    return exists(binary) ? binary : undefined;
  }

  const names =
    platform === "win32"
      ? [binary, `${binary}.exe`, `${binary}.cmd`, `${binary}.bat`]
      : [binary];
  for (const dir of pathEnv.split(pathSep)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve how to spawn a harness binary.
 * On Windows, npm shims are often `.cmd` and require shell:true (Node EINVAL otherwise).
 * Parent flags that contain spaces (prompt, --settings JSON) are quoted when shell is used.
 */
export function resolveSpawn(
  binary: string,
  args: string[],
  opts: ResolveSpawnOptions = {},
): ResolvedSpawn {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      command: binary,
      args,
      shell: false,
      detached: true,
      windowsHide: true,
    };
  }

  const resolved = findOnPath(binary, { ...opts, platform });
  const command = resolved ?? binary;
  // Unresolved bare names still use shell so cmd.exe can apply PATHEXT.
  const shell = resolved ? isBatchFile(resolved) : true;
  return {
    command,
    args: shell ? args.map(quoteWinArg) : args,
    shell,
    detached: false,
    windowsHide: true,
  };
}

export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  taskkill?: (pid: number) => void;
}

/**
 * Kill a spawned harness and its descendants.
 * POSIX uses process-group SIGKILL (spawn was detached).
 * Windows uses `taskkill /T /F` because process.kill(-pid) is not supported.
 */
export function killProcessTree(proc: ChildProcess, opts: KillTreeOptions = {}): void {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    if (proc.pid !== undefined) {
      const kill =
        opts.taskkill
        ?? ((pid: number) => {
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        });
      try {
        kill(proc.pid);
      } catch {
        // already gone
      }
    }
  } else if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // process group already gone
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // already dead
  }
  proc.stdout?.destroy();
  proc.stderr?.destroy();
}
