import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";
import { listInstallCandidates } from "../../harness-install.js";
import { Panel } from "../components/Panel.js";
import { theme } from "../theme.js";
import type { StatusSnapshot } from "../useStatusSnapshot.js";

function statusColor(status: string): string {
  if (status === "answered") return theme.ok;
  if (status === "error" || status === "expired" || status === "overflow") return theme.err;
  if (status === "pending") return theme.warn;
  return theme.dim;
}

export function StatusScreen({
  snap,
  onRefresh,
  onOpenPeers,
  onOpenUpdates,
  updateAvailable,
  inputActive,
}: {
  snap: StatusSnapshot;
  onRefresh: () => void;
  onOpenPeers: () => void;
  onOpenUpdates?: () => void;
  updateAvailable?: string | null;
  inputActive: boolean;
}) {
  const { columns } = useWindowSize();
  const wide = columns >= 88;
  const [needHarnessInstall, setNeedHarnessInstall] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listInstallCandidates().then((list) => {
      if (!cancelled) setNeedHarnessInstall(list.length > 0);
    });
    return () => {
      cancelled = true;
    };
  }, [snap.joined, snap.daemonRunning]);

  useInput(
    (input, key) => {
      if (input === "r") onRefresh();
      if (input === "u" && onOpenUpdates) onOpenUpdates();
      if (key.return) onOpenPeers();
    },
    { isActive: inputActive },
  );

  if (!snap.joined) {
    return (
      <Panel title="Status" flexGrow={1}>
        <Box marginY={1} flexDirection="column">
          <Text color={theme.warn}>No config yet.</Text>
          <Text>Tab to Setup (or run doucopy join) and finish the wizard in the TUI.</Text>
        </Box>
      </Panel>
    );
  }

  const harnessBanner = needHarnessInstall ? (
    <Box marginBottom={1} flexDirection="column">
      <Text color={theme.warn} bold>
        No coding-agent CLI ready (missing or not logged in).
      </Text>
      <Text color={theme.dim}>Tab to Setup to install/login Cursor, Claude, or Codex.</Text>
    </Box>
  ) : null;

  const peersPanel = (
    <Panel title="Network" flexGrow={1}>
      <Box marginTop={1} flexDirection="column">
        {snap.peers.length === 0 ? (
          <Text color={theme.dim}>(no peers yet)</Text>
        ) : (
          snap.peers.map((p) => (
            <Box key={p.name}>
              <Text color={p.online ? theme.ok : theme.dim}>{p.online ? "●" : "○"} </Text>
              <Text bold={Boolean(p.self)}>{p.name.padEnd(18)}</Text>
              {p.self ? <Text color={theme.accent}> you </Text> : <Text>{"     "}</Text>}
              {p.paused ? (
                <Text color={theme.warn}>paused</Text>
              ) : (
                <Text color={p.online ? theme.ok : theme.dim}>{p.online ? "online" : "offline"}</Text>
              )}
            </Box>
          ))
        )}
      </Box>
      {snap.paused.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.warn} bold>
            Paused
          </Text>
          {snap.paused.map((p) => (
            <Text key={p.peer} color={theme.dim}>
              {"  "}
              {p.peer} · {p.until_ms === null ? "indefinitely" : `until ${new Date(p.until_ms).toISOString()}`}
            </Text>
          ))}
        </Box>
      ) : null}
    </Panel>
  );

  const dialogsPanel = (
    <Panel title="Activity" flexGrow={1}>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color={theme.dim}>incoming open    </Text>
          <Text color={(snap.status?.incoming_queued ?? 0) > 0 ? theme.warn : theme.highlight} bold>
            {snap.status?.incoming_queued ?? 0}
          </Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.dim}>open dialogs</Text>
          {!snap.status || snap.status.outgoing.length === 0 ? (
            <Text color={theme.dim}>  (none)</Text>
          ) : (
            snap.status.outgoing.map((t) => (
              <Box key={t.ticket_id}>
                <Text color={theme.dim}>  → </Text>
                <Text>{t.to_peer.padEnd(16)} </Text>
                <Text color={statusColor(t.status)}>{t.status}</Text>
                <Text color={theme.dim}>  {t.ticket_id.slice(0, 8)}</Text>
              </Box>
            ))
          )}
        </Box>
      </Box>
    </Panel>
  );

  const updateBanner = updateAvailable ? (
    <Box marginBottom={1} flexDirection="column">
      <Text color={theme.warn} bold>
        New doucopy v{updateAvailable} available.
      </Text>
      <Text color={theme.dim}>Tab to Updates (or press u) · npm i -g doucopy@latest</Text>
    </Box>
  ) : null;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {harnessBanner}
      {updateBanner}
      <Box flexDirection={wide ? "row" : "column"} flexGrow={1}>
        <Box flexGrow={1} marginRight={wide ? 1 : 0} marginBottom={wide ? 0 : 1}>
          {peersPanel}
        </Box>
        <Box flexGrow={1}>{dialogsPanel}</Box>
      </Box>
      <Box marginTop={1} flexShrink={0}>
        <Text color={theme.dim}>c chat · u updates · r refresh · Enter Peers · Tab switch</Text>
      </Box>
    </Box>
  );
}
