// Minimal ANSI helpers. No new dependencies. Respects NO_COLOR and
// automatically becomes a no-op when stdout is not a TTY (piped or CI logs).
const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code: string, s: string): string {
  return enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  green: (s: string) => wrap("32", s),
  red: (s: string) => wrap("31", s),
  yellow: (s: string) => wrap("33", s),
  cyan: (s: string) => wrap("36", s),
  dim: (s: string) => wrap("2", s),
  bold: (s: string) => wrap("1", s),
};

export interface PeerRow {
  name: string;
  online: boolean;
  self?: boolean;
  paused?: boolean;
}

export function formatPeersTable(rows: PeerRow[]): string {
  if (rows.length === 0) return c.dim("  (no peers seen yet)");
  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
  const lines: string[] = [];
  lines.push(`  ${c.bold("peer".padEnd(nameWidth))}  ${c.bold("status")}`);
  for (const r of rows) {
    const dot = r.online ? c.green("●") : c.dim("○");
    const label = r.paused
      ? c.yellow("paused")
      : r.online
        ? c.green("online")
        : c.dim("offline");
    const selfTag = r.self ? c.cyan(" (this machine)") : "";
    lines.push(`  ${dot} ${r.name.padEnd(nameWidth)}  ${label}${selfTag}`);
  }
  return lines.join("\n");
}
