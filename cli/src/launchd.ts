import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDaemonPathValue } from "./daemon-path.js";
import {
  installWindowsDaemon,
  isWindowsDaemonRunning,
  stopWindowsDaemon,
} from "./windows-task.js";

const LABEL = "com.doucopy.responder";
const LEGACY_LABEL = "com.agent-link.responder";

export const RESPONDER_DAEMON_UNSUPPORTED =
  "responder daemon is only supported on macOS (launchd) and Windows (Task Scheduler)";

/** Thrown when install would load launchd/Task Scheduler against a non-real $HOME (e.g. vitest tmp). */
export const FOREIGN_HOME_INSTALL =
  "refusing to install responder daemon for a non-user home (would break cursor-agent PATH). Set DOUCOPY_ALLOW_FOREIGN_HOME=1 only for intentional isolation tests.";

export function responderDaemonSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "darwin" || platform === "win32";
}

function assertResponderDaemonSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  if (!responderDaemonSupported(platform)) {
    throw new Error(RESPONDER_DAEMON_UNSUPPORTED);
  }
}

export function packageRoot(): string {
  // cli/dist/launchd.js -> package root is two levels up
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function plistDestination(home: string): string {
  return path.join(home, "Library/LaunchAgents", `${LABEL}.plist`);
}

function plistStringArg(value: string): string {
  return `    <string>${value.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`;
}

/** Read keep_awake.enabled from config.json. Missing/invalid → true (safe default). */
export function readKeepAwakeEnabled(home: string): boolean {
  const file = path.join(home, ".doucopy/config.json");
  if (!existsSync(file)) return true;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      keep_awake?: { enabled?: boolean };
    };
    if (raw.keep_awake?.enabled === undefined) return true;
    return Boolean(raw.keep_awake.enabled);
  } catch {
    return true;
  }
}

export function programArgumentsXml(nodeBin: string, repoRoot: string, keepAwake: boolean): string {
  const daemonEntry = path.join(repoRoot, "daemon/dist/index.js");
  const args = keepAwake
    ? ["/usr/bin/caffeinate", "-dims", nodeBin, daemonEntry]
    : [nodeBin, daemonEntry];
  return args.map(plistStringArg).join("\n");
}

export function renderPlist(
  nodeBin: string,
  repoRoot: string,
  home: string,
  keepAwake = true,
  pathHome: string = homedir(),
): string {
  const template = readFileSync(
    path.join(repoRoot, "daemon/launchd", `${LABEL}.plist`),
    "utf8",
  );
  const daemonPath = buildDaemonPathValue({
    nodeBin,
    pathHome,
    platform: "darwin",
  });
  return template
    .replaceAll("__PROGRAM_ARGUMENTS__", programArgumentsXml(nodeBin, repoRoot, keepAwake))
    .replaceAll("__HOME__", home)
    // Includes dirname(nodeBin) so nvm/npm -g claude/codex resolve, plus ~/.local/bin for cursor-agent.
    .replaceAll("__DAEMON_PATH__", daemonPath);
}

/** Block installing the real OS supervisor for vitest / foreign HOME directories. */
export function assertInstallableHome(home: string): void {
  if (process.env.DOUCOPY_ALLOW_FOREIGN_HOME === "1") return;
  const real = path.resolve(homedir());
  const target = path.resolve(home);
  if (target !== real) {
    throw new Error(`${FOREIGN_HOME_INSTALL} (home=${target}, expected=${real})`);
  }
}

// Tears down the pre-rename daemon (label + plist) if it's still installed,
// so a machine upgrading from agent-link doesn't end up running two
// responders against the same config. Best-effort: bootout failures (daemon
// already gone) are ignored.
function teardownLegacyDaemon(home: string): void {
  const legacyDst = path.join(home, "Library/LaunchAgents", `${LEGACY_LABEL}.plist`);
  if (!existsSync(legacyDst)) return;
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LEGACY_LABEL}`], { stdio: "ignore" });
  spawnSync("launchctl", ["unload", legacyDst], { stdio: "ignore" });
  rmSync(legacyDst, { force: true });
}

function installLaunchdDaemon(home: string): void {
  const root = packageRoot();
  const daemonEntry = path.join(root, "daemon/dist/index.js");
  if (!existsSync(daemonEntry)) {
    throw new Error(`daemon build not found at ${daemonEntry}, run: npm run build`);
  }
  teardownLegacyDaemon(home);
  mkdirSync(path.join(home, ".doucopy/workspace"), { recursive: true });
  const configPath = path.join(home, ".doucopy/config.json");
  if (existsSync(configPath)) chmodSync(configPath, 0o600);
  const keepAwake = readKeepAwakeEnabled(home);
  const dst = plistDestination(home);
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, renderPlist(process.execPath, root, home, keepAwake));
  spawnSync("launchctl", ["unload", dst], { stdio: "ignore" });
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LABEL}`], { stdio: "ignore" });
  execFileSync("launchctl", ["load", dst]);
}

export function installDaemon(
  home: string,
  platform: NodeJS.Platform = process.platform,
): void {
  assertResponderDaemonSupported(platform);
  assertInstallableHome(home);
  if (platform === "win32") {
    const root = packageRoot();
    const daemonEntry = path.join(root, "daemon/dist/index.js");
    const configPath = path.join(home, ".doucopy/config.json");
    if (existsSync(configPath)) {
      try {
        chmodSync(configPath, 0o600);
      } catch {
        // Windows may ignore mode bits.
      }
    }
    installWindowsDaemon(home, process.execPath, daemonEntry);
    return;
  }
  installLaunchdDaemon(home);
}

export function startDaemon(
  home: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // Re-render supervisor config so keep_awake / path changes take effect.
  installDaemon(home, platform);
}

export function stopDaemon(
  home: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!responderDaemonSupported(platform)) return;
  if (platform === "win32") {
    stopWindowsDaemon();
    return;
  }
  const dst = plistDestination(home);
  spawnSync("launchctl", ["unload", dst], { stdio: "ignore" });
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LABEL}`], { stdio: "ignore" });
}

export function isDaemonRunning(
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!responderDaemonSupported(platform)) return false;
  if (platform === "win32") return isWindowsDaemonRunning();
  const out = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  return out.stdout?.split("\n").some((line) => line.includes(LABEL)) ?? false;
}
