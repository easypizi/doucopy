import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { tailFileLines } from "./log-tail.js";

export function runLogs(follow: boolean): void {
  const home = homedir();
  const candidates = [
    path.join(home, ".doucopy", "responder.log"),
    path.join(home, ".doucopy", "responder.err.log"),
  ].filter((file) => existsSync(file));
  if (candidates.length === 0) {
    console.error("no log files found in ~/.doucopy/");
    process.exitCode = 1;
    return;
  }

  // `tail` is not available on stock Windows. Print a snapshot instead (and on
  // follow, fall back to PowerShell Get-Content -Wait when possible).
  if (process.platform === "win32") {
    for (const file of candidates) {
      console.log(`===== ${file} =====`);
      console.log(tailFileLines(file, 200) || "(empty)");
      console.log("");
    }
    if (follow) {
      const ps = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          candidates.map((f) => `Get-Content -LiteralPath '${f.replace(/'/g, "''")}' -Wait -Tail 50`).join("; "),
        ],
        { stdio: "inherit" },
      );
      ps.on("exit", (code) => {
        process.exitCode = code ?? 0;
      });
    }
    return;
  }

  const args = follow ? ["-f", ...candidates] : ["-n", "200", ...candidates];
  const child = spawn("tail", args, { stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}
