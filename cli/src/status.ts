import { fetchStatus, type RelayStatus } from "./api.js";
import { c, formatPeersTable, type PeerRow } from "./color.js";
import { isDaemonRunning } from "./launchd.js";

export interface PausedEntry {
  peer: string;
  until_ms: number | null;
}

export function buildPeerRows(status: RelayStatus, self: string, paused: PausedEntry[]): PeerRow[] {
  const pausedSet = new Set(paused.map((p) => p.peer));
  const rows: PeerRow[] = [];
  rows.push({ name: self, online: status.self_online, self: true });
  for (const peer of status.peers) {
    if (peer.name === self) continue;
    rows.push({ name: peer.name, online: peer.online, paused: pausedSet.has(peer.name) });
  }
  return rows;
}

export async function runStatus(): Promise<void> {
  const { loadConfig } = await import("../../daemon/dist/config.js");
  const { listPaused } = await import("../../daemon/dist/paused.js");
  const config = loadConfig();
  console.log(c.bold("agent-link status"));
  console.log(`  relay:  ${config.relay_url}`);
  console.log(`  self:   ${config.self_peer}`);
  console.log(`  daemon: ${isDaemonRunning() ? c.green("running") : c.dim("stopped")}`);
  const paused = listPaused();
  try {
    const status = await fetchStatus(config.relay_url, config.token);
    console.log("");
    console.log(c.bold("peers"));
    console.log(formatPeersTable(buildPeerRows(status, config.self_peer, paused)));
    if (paused.length > 0) {
      console.log("");
      console.log(c.bold("paused"));
      for (const p of paused) {
        const until = p.until_ms === null ? "indefinitely" : `until ${new Date(p.until_ms).toISOString()}`;
        console.log(`  ${c.yellow("⏸")} ${p.peer} ${c.dim(until)}`);
      }
    }
    if (status.outgoing.length > 0) {
      console.log("");
      console.log(c.bold("your open dialogs"));
      for (const t of status.outgoing) {
        console.log(`  → ${t.to_peer}  ${c.dim(t.status)}  ${c.dim(t.ticket_id)}`);
      }
    }
    console.log("");
    console.log(c.dim(`incoming queued: ${status.incoming_queued}`));
  } catch (err) {
    console.error(`could not reach the relay: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
