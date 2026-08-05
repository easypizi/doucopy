import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { binaryOnPath } from "./setup.js";

export const HARNESS_IDS = ["cursor", "claude", "codex"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export interface HarnessProbe {
  id: HarnessId;
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
}

export interface CommandSpec {
  command: string;
  args?: string[];
  shell?: boolean;
  /** Alternate binary if the primary is missing (Cursor: agent → cursor-agent). */
  fallback?: { command: string; args?: string[] };
}

export type AuthStatusRunner = (
  id: HarnessId,
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export type CommandRunner = (
  spec: CommandSpec,
  opts?: { timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface ProbeDeps {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  binaryPresent?: (id: HarnessId) => boolean;
  runAuthStatus?: AuthStatusRunner;
}

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export function cursorBinariesPresent(opts?: {
  pathEnv?: string;
  platform?: NodeJS.Platform;
}): boolean {
  return binaryOnPath("cursor-agent", opts) || binaryOnPath("agent", opts);
}

export function harnessBinaryPresent(
  id: HarnessId,
  opts?: { pathEnv?: string; platform?: NodeJS.Platform },
): boolean {
  if (id === "cursor") return cursorBinariesPresent(opts);
  return binaryOnPath(id, opts);
}

export function installCommand(
  id: HarnessId,
  platform: NodeJS.Platform = process.platform,
): CommandSpec {
  if (id === "cursor") {
    if (platform === "win32") {
      return {
        command: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://cursor.com/install?win32=true' | iex"`,
        shell: true,
      };
    }
    return {
      command: "curl https://cursor.com/install -fsS | bash",
      shell: true,
    };
  }
  if (id === "claude") {
    return { command: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"], shell: false };
  }
  return { command: "npm", args: ["install", "-g", "@openai/codex"], shell: false };
}

export function loginCommand(id: HarnessId): CommandSpec {
  if (id === "cursor") {
    return {
      command: "agent",
      args: ["login"],
      fallback: { command: "cursor-agent", args: ["login"] },
    };
  }
  if (id === "claude") {
    return { command: "claude", args: ["auth", "login"] };
  }
  return { command: "codex", args: ["login"] };
}

export function authStatusCommand(id: HarnessId): CommandSpec {
  if (id === "cursor") {
    return {
      command: "agent",
      args: ["status"],
      fallback: { command: "cursor-agent", args: ["status"] },
    };
  }
  if (id === "claude") {
    return { command: "claude", args: ["auth", "status"] };
  }
  return { command: "codex", args: ["login", "status"] };
}

function runSyncSpec(spec: CommandSpec): { status: number | null; stdout: string; stderr: string } {
  const tryOne = (command: string, args: string[] = []) =>
    spawnSync(command, args, { encoding: "utf8", shell: Boolean(spec.shell) });
  let out = tryOne(spec.command, spec.args ?? []);
  if ((out.error || out.status === 127) && spec.fallback) {
    out = tryOne(spec.fallback.command, spec.fallback.args ?? []);
  }
  return {
    status: out.status,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
  };
}

async function defaultAuthStatus(id: HarnessId): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const out = runSyncSpec(authStatusCommand(id));
  return {
    ok: out.status === 0,
    stdout: out.stdout,
    stderr: out.stderr,
  };
}

export async function probeHarness(id: HarnessId, deps: ProbeDeps = {}): Promise<HarnessProbe> {
  const platform = deps.platform ?? process.platform;
  const pathEnv = deps.pathEnv ?? process.env.PATH;
  const installed = deps.binaryPresent
    ? deps.binaryPresent(id)
    : harnessBinaryPresent(id, { platform, pathEnv });
  if (!installed) {
    return { id, installed: false, authenticated: false, ready: false };
  }
  const auth = await (deps.runAuthStatus ?? defaultAuthStatus)(id);
  return {
    id,
    installed: true,
    authenticated: auth.ok,
    ready: auth.ok,
  };
}

export async function detectReadyHarnesses(deps: ProbeDeps = {}): Promise<Record<HarnessId, boolean>> {
  const probes = await Promise.all(HARNESS_IDS.map((id) => probeHarness(id, deps)));
  return {
    cursor: probes.find((p) => p.id === "cursor")?.ready ?? false,
    claude: probes.find((p) => p.id === "claude")?.ready ?? false,
    codex: probes.find((p) => p.id === "codex")?.ready ?? false,
  };
}

/** Candidates to offer for install/login when zero harnesses are ready. */
export async function listInstallCandidates(deps: ProbeDeps = {}): Promise<HarnessProbe[]> {
  const probes = await Promise.all(HARNESS_IDS.map((id) => probeHarness(id, deps)));
  if (probes.some((p) => p.ready)) return [];
  return probes;
}

/** Best-effort PATH refresh after Cursor install on Windows. */
export function refreshPathAfterInstall(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  const local = process.env.LOCALAPPDATA;
  if (!local) return;
  const agentDir = path.join(local, "cursor-agent");
  const current = process.env.PATH ?? "";
  if (!current.toLowerCase().includes(agentDir.toLowerCase())) {
    process.env.PATH = `${agentDir}${path.delimiter}${current}`;
  }
}

export function runCommand(
  spec: CommandSpec,
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  return new Promise((resolve) => {
    const trySpawn = (command: string, args: string[] = []) =>
      spawn(command, args, {
        shell: Boolean(spec.shell),
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

    let child = trySpawn(spec.command, spec.args ?? []);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    const attach = (proc: ReturnType<typeof spawn>) => {
      proc.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      proc.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      proc.on("error", (err) => {
        if (spec.fallback && proc === child) {
          child = trySpawn(spec.fallback.command, spec.fallback.args ?? []);
          attach(child);
          return;
        }
        stderr += err.message;
        finish(127);
      });
      proc.on("close", (code) => finish(code ?? 1));
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      finish(124);
    }, timeoutMs);
    timer.unref?.();
    attach(child);
  });
}

export async function installHarness(
  id: HarnessId,
  opts: { platform?: NodeJS.Platform; run?: CommandRunner } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCommand;
  const result = await run(installCommand(id, platform), { timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS });
  refreshPathAfterInstall(platform);
  return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
}

export async function loginHarness(
  id: HarnessId,
  opts: { run?: CommandRunner } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const run = opts.run ?? runCommand;
  const result = await run(loginCommand(id), { timeoutMs: DEFAULT_LOGIN_TIMEOUT_MS });
  return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
}

export function anyHarnessReadySync(): boolean {
  // Fast PATH-only check for Status banner; auth may be stale briefly.
  return HARNESS_IDS.some((id) => harnessBinaryPresent(id));
}

export async function ensureHarnessesInteractive(
  selected: HarnessId[],
  deps: ProbeDeps & { runInstall?: typeof installHarness; runLogin?: typeof loginHarness; log?: (line: string) => void } = {},
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const runInstall = deps.runInstall ?? installHarness;
  const runLogin = deps.runLogin ?? loginHarness;
  for (const id of selected) {
    let probe = await probeHarness(id, deps);
    if (!probe.installed) {
      log(`Installing ${id}…`);
      const installed = await runInstall(id, { platform: deps.platform });
      if (!installed.ok) {
        log(`Failed to install ${id}: ${(installed.stderr || installed.stdout).trim()}`);
        continue;
      }
      log(`Installed ${id}`);
      probe = await probeHarness(id, deps);
    }
    if (probe.installed && !probe.authenticated) {
      log(`Logging in to ${id} (browser may open)…`);
      const logged = await runLogin(id);
      if (!logged.ok) {
        log(`Login for ${id} did not complete: ${(logged.stderr || logged.stdout).trim()}`);
        continue;
      }
      log(`Authenticated ${id}`);
    }
  }
}

/** Home used only for tests that need a stable default. */
export function defaultHome(): string {
  return homedir();
}
