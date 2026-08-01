import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  expandHome,
  resolveKeepAwake,
  type DaemonConfig,
  type ResolvedKeepAwake,
} from "./config.js";

export const KEEP_AWAKE_STATE_FILE = "~/.doucopy/keep_awake_state.json";
export const LAUNCHD_LABEL = "com.doucopy.responder";

export interface KeepAwakeState {
  /** ISO time of last explicit or implicit confirmation. */
  confirmed_at: string;
  /** ISO time when the confirm dialog was last shown. */
  prompt_shown_at?: string;
  awaiting_confirm?: boolean;
}

export type ConfirmChoice = "keep" | "stop" | "unavailable";

export interface KeepAwakeDeps {
  now?: () => number;
  readState?: () => KeepAwakeState | null;
  writeState?: (state: KeepAwakeState) => void;
  askConfirm?: () => Promise<ConfirmChoice>;
  /** Cancel a hung askConfirm (e.g. kill osascript). */
  cancelAsk?: () => void;
  /** Wait helper for grace race. Defaults to setTimeout. */
  waitMs?: (ms: number) => Promise<void>;
  stopDaemon?: () => void;
  log?: (msg: string) => void;
  tickMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TICK_MS = 60_000;

let activeOsascript: ChildProcess | null = null;

export function statePath(home = homedir()): string {
  return path.join(home, ".doucopy", "keep_awake_state.json");
}

export function defaultReadState(file = expandHome(KEEP_AWAKE_STATE_FILE)): KeepAwakeState | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as KeepAwakeState;
  } catch {
    return null;
  }
}

export function defaultWriteState(state: KeepAwakeState, file = expandHome(KEEP_AWAKE_STATE_FILE)): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function cancelOsascriptConfirm(): void {
  if (!activeOsascript) return;
  try {
    activeOsascript.kill("SIGTERM");
  } catch {
    // ignore
  }
  activeOsascript = null;
}

/**
 * macOS GUI dialog.
 * Esc / Cancel → keep (user dismissed; reset timer).
 * Spawn failure / missing osascript → unavailable.
 */
export function askConfirmViaOsascript(): Promise<ConfirmChoice> {
  return new Promise((resolve) => {
    const script = [
      "set r to button returned of (display dialog ",
      '"doucopy is keeping this Mac awake so your peer can reach you.\\n\\n',
      'Keep the responder running?" ',
      'buttons {"Stop responder", "Keep running"} ',
      'default button "Keep running" with title "doucopy")',
      "\nreturn r",
    ].join("");
    const proc = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    activeOsascript = proc;
    let stdout = "";
    let settled = false;
    const finish = (choice: ConfirmChoice) => {
      if (settled) return;
      settled = true;
      if (activeOsascript === proc) activeOsascript = null;
      resolve(choice);
    };
    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    proc.on("error", () => finish("unavailable"));
    proc.on("close", (code, signal) => {
      if (signal) {
        // Killed by grace cancel — ignore; race winner already decided.
        finish("unavailable");
        return;
      }
      if (code !== 0) {
        // User cancelled (Esc) or dialog dismissed → treat as Keep.
        finish("keep");
        return;
      }
      const text = stdout.trim().toLowerCase();
      if (text.includes("stop")) finish("stop");
      else if (text.includes("keep")) finish("keep");
      else finish("unavailable");
    });
  });
}

export function stopLaunchdDaemon(home = homedir()): void {
  const plist = path.join(home, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], {
    stdio: "ignore",
  });
}

export function ensureInitialConfirmation(
  state: KeepAwakeState | null,
  nowMs: number,
): KeepAwakeState {
  if (state?.confirmed_at) return state;
  return { confirmed_at: new Date(nowMs).toISOString(), awaiting_confirm: false };
}

export function needsConfirmPrompt(
  settings: ResolvedKeepAwake,
  state: KeepAwakeState,
  nowMs: number,
): boolean {
  if (!settings.enabled) return false;
  if (settings.confirm_days <= 0) return false;
  if (state.awaiting_confirm) return false;
  const confirmed = Date.parse(state.confirmed_at);
  if (!Number.isFinite(confirmed)) return true;
  return nowMs - confirmed >= settings.confirm_days * DAY_MS;
}

export function graceExpired(
  settings: ResolvedKeepAwake,
  state: KeepAwakeState,
  nowMs: number,
): boolean {
  if (!state.awaiting_confirm || !state.prompt_shown_at) return false;
  const shown = Date.parse(state.prompt_shown_at);
  if (!Number.isFinite(shown)) return true;
  return nowMs - shown >= settings.confirm_grace_hours * 60 * 60 * 1000;
}

export function remainingGraceMs(
  settings: ResolvedKeepAwake,
  state: KeepAwakeState,
  nowMs: number,
): number {
  if (!state.prompt_shown_at) return settings.confirm_grace_hours * 60 * 60 * 1000;
  const shown = Date.parse(state.prompt_shown_at);
  if (!Number.isFinite(shown)) return 0;
  return Math.max(0, settings.confirm_grace_hours * 60 * 60 * 1000 - (nowMs - shown));
}

function defaultWaitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * One supervisor tick. Pure decision helper plus side effects via deps.
 * Returns "continue" | "stop".
 */
export async function keepAwakeTick(
  settings: ResolvedKeepAwake,
  deps: KeepAwakeDeps = {},
): Promise<"continue" | "stop"> {
  if (!settings.enabled) return "continue";

  const now = deps.now ?? Date.now;
  const nowMs = now();
  const readState = deps.readState ?? defaultReadState;
  const writeState = deps.writeState ?? defaultWriteState;
  const askConfirm = deps.askConfirm ?? askConfirmViaOsascript;
  const cancelAsk = deps.cancelAsk ?? cancelOsascriptConfirm;
  const waitMs = deps.waitMs ?? defaultWaitMs;
  const stopDaemon = deps.stopDaemon ?? stopLaunchdDaemon;
  const log = deps.log ?? ((msg: string) => console.error(msg));

  let state = ensureInitialConfirmation(readState(), nowMs);
  writeState(state);

  if (graceExpired(settings, state, nowMs)) {
    log("keep_awake: confirm grace elapsed without answer, stopping responder");
    cancelAsk();
    stopDaemon();
    return "stop";
  }

  if (!needsConfirmPrompt(settings, state, nowMs)) return "continue";

  state = {
    ...state,
    awaiting_confirm: true,
    prompt_shown_at: new Date(nowMs).toISOString(),
  };
  writeState(state);
  log("keep_awake: asking whether to keep the responder running");

  const graceMs = remainingGraceMs(settings, state, nowMs);
  type Race = ConfirmChoice | "grace_elapsed";
  const choice = await Promise.race<Race>([
    askConfirm(),
    waitMs(graceMs).then(() => "grace_elapsed" as const),
  ]);

  if (choice === "grace_elapsed") {
    log("keep_awake: confirm grace elapsed while dialog open, stopping responder");
    cancelAsk();
    stopDaemon();
    return "stop";
  }

  if (choice === "keep") {
    writeState({
      confirmed_at: new Date(now()).toISOString(),
      awaiting_confirm: false,
    });
    log("keep_awake: confirmed, timer reset");
    return "continue";
  }
  if (choice === "stop") {
    log("keep_awake: user chose to stop the responder");
    stopDaemon();
    return "stop";
  }
  // Dialog unavailable (SSH / no GUI). Wait for grace, then stop on a later tick.
  log("keep_awake: confirm dialog unavailable, waiting for grace period");
  return "continue";
}

export function startKeepAwakeSupervisor(
  config: DaemonConfig,
  signal: AbortSignal,
  deps: KeepAwakeDeps = {},
): void {
  const settings = resolveKeepAwake(config.keep_awake);
  if (!settings.enabled) {
    (deps.log ?? console.error)("keep_awake: disabled (Mac may idle-sleep)");
    return;
  }
  (deps.log ?? console.error)(
    `keep_awake: enabled (confirm every ${settings.confirm_days}d, grace ${settings.confirm_grace_hours}h)`,
  );

  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  let running = false;
  const run = async () => {
    if (running || signal.aborted) return;
    running = true;
    try {
      const result = await keepAwakeTick(settings, deps);
      if (result === "stop" && !signal.aborted) {
        process.kill(process.pid, "SIGTERM");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      (deps.log ?? console.error)(`keep_awake: tick failed: ${message}`);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => {
    void run();
  }, tickMs);
  timer.unref?.();
  signal.addEventListener("abort", () => clearInterval(timer));
}
