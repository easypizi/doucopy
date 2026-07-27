import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.agent-link.responder";

export function packageRoot(): string {
  // cli/dist/launchd.js -> package root is two levels up
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function plistDestination(home: string): string {
  return path.join(home, "Library/LaunchAgents", `${LABEL}.plist`);
}

export function renderPlist(nodeBin: string, repoRoot: string, home: string): string {
  const template = readFileSync(
    path.join(repoRoot, "daemon/launchd", `${LABEL}.plist`),
    "utf8",
  );
  return template
    .replaceAll("__NODE__", nodeBin)
    .replaceAll("__REPO__", repoRoot)
    .replaceAll("__HOME__", home);
}

export function installDaemon(home: string): void {
  const root = packageRoot();
  const daemonEntry = path.join(root, "daemon/dist/index.js");
  if (!existsSync(daemonEntry)) {
    throw new Error(`daemon build not found at ${daemonEntry}, run: npm run build`);
  }
  mkdirSync(path.join(home, ".agent-link/workspace"), { recursive: true });
  chmodSync(path.join(home, ".agent-link/config.json"), 0o600);
  const dst = plistDestination(home);
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, renderPlist(process.execPath, root, home));
  spawnSync("launchctl", ["unload", dst], { stdio: "ignore" });
  execFileSync("launchctl", ["load", dst]);
}

export function startDaemon(home: string): void {
  execFileSync("launchctl", ["load", plistDestination(home)]);
}

export function stopDaemon(home: string): void {
  spawnSync("launchctl", ["unload", plistDestination(home)], { stdio: "ignore" });
}

export function isDaemonRunning(): boolean {
  const out = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  return out.stdout?.split("\n").some((line) => line.includes(LABEL)) ?? false;
}
