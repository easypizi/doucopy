import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface PausedEntry {
  peer: string;
  until_ms: number | null;
}

export function pausedPath(home: string = homedir()): string {
  return process.env.DOUCOPY_PAUSED_FILE ?? path.join(home, ".doucopy", "paused.json");
}

function readMap(file: string): Record<string, number | null> {
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null) out[key] = null;
      else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(file: string, map: Record<string, number | null>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
}

// Reads never mutate the file. The daemon's poller calls isPaused on every
// incoming question, potentially concurrently with a `doucopy pause`
// command, and a read-modify-write from the reader side is a classic race that
// can lose a freshly-written pause entry. Expiry cleanup is the writers' job.
export function isPaused(peer: string, file: string = pausedPath(), now: number = Date.now()): boolean {
  const map = readMap(file);
  if (!(peer in map)) return false;
  const until = map[peer];
  if (until === null) return true;
  return until > now;
}

export function pausedUntil(peer: string, file: string = pausedPath(), now: number = Date.now()): number | null | undefined {
  const map = readMap(file);
  if (!(peer in map)) return undefined;
  const until = map[peer];
  if (until !== null && until <= now) return undefined;
  return until;
}

function pruneExpired(map: Record<string, number | null>, now: number): boolean {
  let changed = false;
  for (const [peer, until] of Object.entries(map)) {
    if (until !== null && until <= now) {
      delete map[peer];
      changed = true;
    }
  }
  return changed;
}

export function pausePeer(peer: string, untilMs: number | null, file: string = pausedPath(), now: number = Date.now()): void {
  const map = readMap(file);
  pruneExpired(map, now);
  map[peer] = untilMs;
  writeMap(file, map);
}

export function resumePeer(peer: string, file: string = pausedPath(), now: number = Date.now()): boolean {
  const map = readMap(file);
  const hadExpired = pruneExpired(map, now);
  const had = peer in map;
  if (had) delete map[peer];
  if (had || hadExpired) writeMap(file, map);
  return had;
}

export function listPaused(file: string = pausedPath(), now: number = Date.now()): PausedEntry[] {
  const map = readMap(file);
  const out: PausedEntry[] = [];
  for (const [peer, until] of Object.entries(map)) {
    if (until !== null && until <= now) continue;
    out.push({ peer, until_ms: until });
  }
  return out.sort((a, b) => a.peer.localeCompare(b.peer));
}
