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
export const WINDOWS_TASK_NAME = "doucopy-responder";

export interface KeepAwakeState {
  /** ISO time of last explicit or implicit confirmation. */
  confirmed_at: string;
  /** ISO time when the confirm dialog was last shown. */
  prompt_shown_at?: string;
  awaiting_confirm?: boolean;
}

export type ConfirmChoice = "keep" | "stop" | "unavailable";

export type PowerShellRunner = (script: string) => { status: number | null; stdout: string; stderr: string };
export type SchtasksRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };

export interface KeepAwakeDeps {
  now?: () => number;
  readState?: () => KeepAwakeState | null;
  writeState?: (state: KeepAwakeState) => void;
  askConfirm?: () => Promise<ConfirmChoice>;
  /** Cancel a hung askConfirm (e.g. kill osascript / powershell). */
  cancelAsk?: () => void;
  /** Wait helper for grace race. Defaults to setTimeout. */
  waitMs?: (ms: number) => Promise<void>;
  stopDaemon?: () => void;
  /** Refresh OS sleep prevention (Windows SetThreadExecutionState). */
  stayAwake?: () => void;
  log?: (msg: string) => void;
  tickMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TICK_MS = 60_000;
/** ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED */
const WINDOWS_ES_FLAGS = "0x80000041";

let activeOsascript: ChildProcess | null = null;
let activePowershell: ChildProcess | null = null;

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

export function cancelMessageBoxConfirm(): void {
  if (!activePowershell) return;
  try {
    activePowershell.kill("SIGTERM");
  } catch {
    // ignore
  }
  activePowershell = null;
}

function defaultPowershell(script: string): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8" },
  );
  return { status: out.status, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
}

function defaultSchtasks(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync("schtasks.exe", args, { encoding: "utf8" });
  return { status: out.status, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
}

export function parseMessageBoxChoice(stdout: string): ConfirmChoice {
  const text = stdout.trim().toLowerCase();
  if (!text) return "unavailable";
  if (text.includes("stop") || text === "no") return "stop";
  if (text.includes("keep") || text === "yes" || text === "cancel") return "keep";
  return "unavailable";
}

/** Prevent idle sleep on Windows while the responder runs. */
export function applyWindowsStayAwake(run: PowerShellRunner = defaultPowershell): boolean {
  const script = [
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class DoucopyPower {",
    "  [DllImport(\"kernel32.dll\")]",
    "  public static extern uint SetThreadExecutionState(uint esFlags);",
    "}",
    "'@",
    `[void][DoucopyPower]::SetThreadExecutionState(${WINDOWS_ES_FLAGS})`,
  ].join("\n");
  const out = run(script);
  return out.status === 0;
}

export function stopWindowsScheduledTask(run: SchtasksRunner = defaultSchtasks): void {
  // Match CLI stop: keep the task registered so restart / logon can re-enable it.
  // Disable first: /End kills this very process tree, so a later /Change would never run
  // and RestartOnFailure would revive the responder the owner just declined.
  run(["/Change", "/TN", WINDOWS_TASK_NAME, "/DISABLE"]);
  run(["/End", "/TN", WINDOWS_TASK_NAME]);
}

/**
 * Windows GUI dialog via WinForms MessageBox.
 * Yes → keep, No → stop, Cancel/X → keep (parity with osascript Esc).
 * Spawn failure → unavailable.
 */
export function askConfirmViaMessageBox(): Promise<ConfirmChoice> {
  return new Promise((resolve) => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$r = [System.Windows.Forms.MessageBox]::Show(",
      "  'doucopy is keeping this PC awake so your peer can reach you.`n`nKeep the responder running?',",
      "  'doucopy',",
      "  [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,",
      "  [System.Windows.Forms.MessageBoxIcon]::Question,",
      "  [System.Windows.Forms.MessageBoxDefaultButton]::Button1",
      ")",
      "if ($r -eq [System.Windows.Forms.DialogResult]::Yes) { 'keep' }",
      "elseif ($r -eq [System.Windows.Forms.DialogResult]::No) { 'stop' }",
      "else { 'keep' }",
    ].join("; ");
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    activePowershell = proc;
    let stdout = "";
    let settled = false;
    const finish = (choice: ConfirmChoice) => {
      if (settled) return;
      settled = true;
      if (activePowershell === proc) activePowershell = null;
      resolve(choice);
    };
    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    proc.on("error", () => finish("unavailable"));
    proc.on("close", (code, signal) => {
      if (signal) {
        finish("unavailable");
        return;
      }
      if (code !== 0) {
        finish("keep");
        return;
      }
      finish(parseMessageBoxChoice(stdout));
    });
  });
}

function defaultAskConfirm(): Promise<ConfirmChoice> {
  if (process.platform === "win32") return askConfirmViaMessageBox();
  return askConfirmViaOsascript();
}

function defaultCancelAsk(): void {
  if (process.platform === "win32") cancelMessageBoxConfirm();
  else cancelOsascriptConfirm();
}

function defaultStopDaemon(): void {
  if (process.platform === "win32") stopWindowsScheduledTask();
  else stopLaunchdDaemon();
}

function defaultStayAwake(): void {
  if (process.platform === "win32") applyWindowsStayAwake();
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
  const askConfirm = deps.askConfirm ?? defaultAskConfirm;
  const cancelAsk = deps.cancelAsk ?? defaultCancelAsk;
  const waitMs = deps.waitMs ?? defaultWaitMs;
  const stopDaemon = deps.stopDaemon ?? defaultStopDaemon;
  const stayAwake = deps.stayAwake ?? defaultStayAwake;
  const log = deps.log ?? ((msg: string) => console.error(msg));

  stayAwake();

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
    (deps.log ?? console.error)("keep_awake: disabled (machine may idle-sleep)");
    return;
  }
  (deps.log ?? console.error)(
    `keep_awake: enabled (confirm every ${settings.confirm_days}d, grace ${settings.confirm_grace_hours}h)`,
  );

  const platformDeps: KeepAwakeDeps = {
    ...deps,
    askConfirm: deps.askConfirm ?? defaultAskConfirm,
    cancelAsk: deps.cancelAsk ?? defaultCancelAsk,
    stopDaemon: deps.stopDaemon ?? defaultStopDaemon,
    stayAwake: deps.stayAwake ?? defaultStayAwake,
  };

  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  let running = false;
  const run = async () => {
    if (running || signal.aborted) return;
    running = true;
    try {
      const result = await keepAwakeTick(settings, platformDeps);
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
