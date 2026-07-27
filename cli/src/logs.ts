import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function runLogs(follow: boolean): void {
  const home = homedir();
  const candidates = [
    path.join(home, ".agent-link/responder.log"),
    path.join(home, ".agent-link/responder.err.log"),
  ].filter((file) => existsSync(file));
  if (candidates.length === 0) {
    console.error("no log files found in ~/.agent-link/");
    process.exitCode = 1;
    return;
  }
  const args = follow ? ["-f", ...candidates] : ["-n", "200", ...candidates];
  const child = spawn("tail", args, { stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}
