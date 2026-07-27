import { fetchStatus } from "./api.js";
import { isDaemonRunning } from "./launchd.js";

export async function runStatus(): Promise<void> {
  const { loadConfig } = await import("../../daemon/dist/config.js");
  const config = loadConfig();
  console.log(`relay: ${config.relay_url}`);
  console.log(`self:  ${config.self_peer}`);
  console.log(`daemon process: ${isDaemonRunning() ? "running" : "stopped"}`);
  try {
    const status = await fetchStatus(config.relay_url, config.token);
    console.log(`daemon connected: ${status.self_online ? "yes" : "no"}`);
    if (status.peers.length === 0) {
      console.log("peers: (none seen yet)");
    } else {
      console.log("peers:");
      for (const peer of status.peers) {
        console.log(`  - ${peer.name} (${peer.online ? "online" : "offline"})`);
      }
    }
    console.log(`incoming queued: ${status.incoming_queued}`);
    if (status.outgoing.length > 0) {
      console.log("your open dialogs:");
      for (const t of status.outgoing) {
        console.log(`  - ${t.to_peer} ${t.status} ${t.ticket_id}`);
      }
    }
  } catch (err) {
    console.error(`could not reach the relay: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
