import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_STUB = `You are answering an agent from another account of the same human circle.

## Never reveal

- 
`;

// Opens ~/.agent-link/policy.md in the user's editor. This is the single
// documented editable filter for the responder: LLM instructions live at the
// top, deterministic redaction rules live under the `## Never reveal`
// heading (see daemon/src/policy.ts). Falls back to `nano` and finally to
// just printing the path if no interactive terminal is available.
export function runPolicy(home: string = homedir()): void {
  const dir = path.join(home, ".agent-link");
  const file = path.join(dir, "policy.md");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, DEFAULT_STUB);
    console.log(`created ${file}`);
  }
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (!process.stdin.isTTY) {
    console.log(`policy file: ${file}`);
    console.log("open it in an editor and edit freely. Changes apply on the next question.");
    return;
  }
  const cmd = editor ?? "nano";
  const res = spawnSync(cmd, [file], { stdio: "inherit" });
  if (res.error) {
    console.error(`could not launch ${cmd}: ${res.error.message}`);
    console.log(`edit this file manually: ${file}`);
    process.exitCode = 1;
  }
}
