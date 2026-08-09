import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Last N lines of a text file (UTF-8). Empty string if missing/unreadable. */
export function tailFileLines(file: string, maxLines: number): string {
  if (!existsSync(file)) return "";
  try {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-Math.max(1, maxLines)).join("\n");
  } catch {
    return "";
  }
}

/** Compact diagnostic snippet from responder stdout/stderr for setup errors. */
export function responderLogSnippet(home: string, maxLines = 12): string {
  const out = path.join(home, ".doucopy", "responder.log");
  const err = path.join(home, ".doucopy", "responder.err.log");
  const parts: string[] = [];
  const errTail = tailFileLines(err, maxLines);
  const outTail = tailFileLines(out, maxLines);
  if (errTail) parts.push(`--- responder.err.log ---\n${errTail}`);
  if (outTail) parts.push(`--- responder.log ---\n${outTail}`);
  return parts.join("\n");
}
