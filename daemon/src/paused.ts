import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface PausedEntry {
  peer: string;
  until_ms: number | null;
}

export function pausedPath(home: string = homedir()): string {
  return process.env.AGENT_LINK_PAUSED_FILE ?? path.join(home, ".agent-link", "paused.json");
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

export function isPaused(peer: string, file: string = pausedPath(), now: number = Date.now()): boolean {
  const map = readMap(file);
  if (!(peer in map)) return false;
  const until = map[peer];
  if (until === null) return true;
  if (until > now) return true;
  // expired, drop it lazily so subsequent status reads stay clean
  delete map[peer];
  writeMap(file, map);
  return false;
}

export function pausedUntil(peer: string, file: string = pausedPath()): number | null | undefined {
  const map = readMap(file);
  return peer in map ? map[peer] : undefined;
}

export function pausePeer(peer: string, untilMs: number | null, file: string = pausedPath()): void {
  const map = readMap(file);
  map[peer] = untilMs;
  writeMap(file, map);
}

export function resumePeer(peer: string, file: string = pausedPath()): boolean {
  const map = readMap(file);
  if (!(peer in map)) return false;
  delete map[peer];
  writeMap(file, map);
  return true;
}

export function listPaused(file: string = pausedPath(), now: number = Date.now()): PausedEntry[] {
  const map = readMap(file);
  const out: PausedEntry[] = [];
  let changed = false;
  for (const [peer, until] of Object.entries(map)) {
    if (until !== null && until <= now) {
      delete map[peer];
      changed = true;
      continue;
    }
    out.push({ peer, until_ms: until });
  }
  if (changed) writeMap(file, map);
  return out.sort((a, b) => a.peer.localeCompare(b.peer));
}
