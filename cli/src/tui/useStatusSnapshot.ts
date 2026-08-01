import { useCallback, useEffect, useState } from "react";
import { fetchStatus, type RelayStatus } from "../api.js";
import { isDaemonRunning } from "../launchd.js";
import {
  keepAwakeFromConfig,
  readConfigFile,
  type DoucopyConfigFile,
  type KeepAwakeSettings,
} from "../settings.js";
import { buildPeerRows, type PausedEntry } from "../status.js";
import type { PeerRow } from "../color.js";

export interface StatusSnapshot {
  loading: boolean;
  config: DoucopyConfigFile | null;
  joined: boolean;
  daemonRunning: boolean;
  keepAwake: KeepAwakeSettings;
  relayHost: string;
  relayOk: boolean;
  relayError: string | null;
  status: RelayStatus | null;
  peers: PeerRow[];
  paused: PausedEntry[];
  onlineCount: number;
  peerCount: number;
}

function shortHost(url: string | undefined): string {
  if (!url) return "(none)";
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").slice(0, 40);
  }
}

export async function loadStatusSnapshot(home: string): Promise<StatusSnapshot> {
  const config = readConfigFile(home);
  const keepAwake = keepAwakeFromConfig(config ?? {});
  const daemonRunning = isDaemonRunning();
  const base: StatusSnapshot = {
    loading: false,
    config,
    joined: Boolean(config?.relay_url && config?.token && config?.self_peer),
    daemonRunning,
    keepAwake,
    relayHost: shortHost(config?.relay_url),
    relayOk: false,
    relayError: null,
    status: null,
    peers: [],
    paused: [],
    onlineCount: 0,
    peerCount: 0,
  };
  if (!base.joined || !config?.relay_url || !config.token || !config.self_peer) {
    return base;
  }
  let paused: PausedEntry[] = [];
  try {
    const { listPaused } = await import("../../../daemon/dist/paused.js");
    paused = listPaused();
  } catch {
    paused = [];
  }
  try {
    const status = await fetchStatus(config.relay_url, config.token);
    const peers = buildPeerRows(status, config.self_peer, paused);
    const onlineCount = peers.filter((p) => p.online).length;
    return {
      ...base,
      relayOk: true,
      status,
      peers,
      paused,
      onlineCount,
      peerCount: peers.length,
    };
  } catch (err) {
    return {
      ...base,
      relayError: err instanceof Error ? err.message : String(err),
      paused,
    };
  }
}

export function useStatusSnapshot(home: string, intervalMs = 4000): StatusSnapshot & { refresh: () => void } {
  const [snap, setSnap] = useState<StatusSnapshot>({
    loading: true,
    config: null,
    joined: false,
    daemonRunning: false,
    keepAwake: keepAwakeFromConfig({}),
    relayHost: "(none)",
    relayOk: false,
    relayError: null,
    status: null,
    peers: [],
    paused: [],
    onlineCount: 0,
    peerCount: 0,
  });

  const refresh = useCallback(() => {
    void loadStatusSnapshot(home).then(setSnap);
  }, [home]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { ...snap, refresh };
}
