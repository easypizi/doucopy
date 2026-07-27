import { spawn } from "node:child_process";
import type { ExecFn } from "./ops.js";

export const shellExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => resolve({ stdout, stderr: `${stderr}${err.message}`, code: 127 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
