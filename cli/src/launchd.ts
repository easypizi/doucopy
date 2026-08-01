import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.doucopy.responder";
const LEGACY_LABEL = "com.agent-link.responder";

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
): string {
  const template = readFileSync(
    path.join(repoRoot, "daemon/launchd", `${LABEL}.plist`),
    "utf8",
  );
  return template
    .replaceAll("__PROGRAM_ARGUMENTS__", programArgumentsXml(nodeBin, repoRoot, keepAwake))
    .replaceAll("__HOME__", home);
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

export function installDaemon(home: string): void {
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

export function startDaemon(home: string): void {
  // Re-render plist so keep_awake changes take effect.
  installDaemon(home);
}

export function stopDaemon(home: string): void {
  const dst = plistDestination(home);
  spawnSync("launchctl", ["unload", dst], { stdio: "ignore" });
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LABEL}`], { stdio: "ignore" });
}

export function isDaemonRunning(): boolean {
  const out = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  return out.stdout?.split("\n").some((line) => line.includes(LABEL)) ?? false;
}
