import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function safeDirName(id: string): string {
  return SAFE_ID_PATTERN.test(id) ? id : createHash("sha256").update(id).digest("hex");
}

export function pruneWorkspaces(workspaceRoot: string, maxAgeMs = DEFAULT_MAX_AGE_MS): number {
  if (!existsSync(workspaceRoot)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of readdirSync(workspaceRoot)) {
    const full = path.join(workspaceRoot, entry);
    try {
      const info = statSync(full);
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // a conversation may be running and touching files, skip it
    }
  }
  return removed;
}
