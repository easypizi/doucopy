import { Box, Text } from "ink";
import { APP_VERSION, theme } from "./theme.js";
import type { StatusSnapshot } from "./useStatusSnapshot.js";

function Chip({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <Box marginRight={2}>
      <Text color={theme.dim}>{label} </Text>
      <Text color={ok === undefined ? theme.highlight : ok ? theme.ok : theme.dim} bold={ok === true}>
        {value}
      </Text>
    </Box>
  );
}

function DotLabel({ label, on }: { label: string; on: boolean }) {
  return (
    <Box marginRight={2}>
      <Text color={theme.dim}>{label} </Text>
      <Text color={on ? theme.ok : theme.dim}>{on ? "● on" : "○ off"}</Text>
    </Box>
  );
}

export function Header({ snap }: { snap: StatusSnapshot }) {
  const model = snap.config?.responder?.model ?? "(default)";
  const harness = snap.config?.responder?.harness ?? "cursor-agent";
  const peer = snap.config?.self_peer ?? "(not joined)";
  const incoming = snap.status?.incoming_queued ?? 0;
  const dialogs = snap.status?.outgoing.length ?? 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text color={theme.brand} bold>
          doucopy v{APP_VERSION}
        </Text>
        <Text color={theme.dim}>{snap.joined ? snap.relayHost : "not connected"}</Text>
      </Box>

      {!snap.joined ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>not joined · open Setup tab to connect this machine</Text>
        </Box>
      ) : (
        <>
          <Box marginTop={1}>
            <Text color={theme.highlight} bold>
              {peer}
            </Text>
            <Text color={theme.dim}>  ·  </Text>
            <Text>{model}</Text>
            <Text color={theme.dim}>  ·  </Text>
            <Text>{harness}</Text>
          </Box>
          <Box marginTop={1} flexWrap="wrap">
            <DotLabel label="daemon" on={snap.daemonRunning} />
            <DotLabel label="keep-awake" on={snap.keepAwake.enabled} />
            <Chip
              label="peers"
              value={`${snap.onlineCount}/${snap.peerCount} online`}
              ok={snap.onlineCount > 0}
            />
            <Chip label="incoming" value={String(incoming)} ok={incoming === 0 ? undefined : false} />
            <Chip label="dialogs" value={String(dialogs)} ok={dialogs > 0 ? true : undefined} />
          </Box>
          {!snap.relayOk && snap.relayError ? (
            <Box marginTop={1}>
              <Text color={theme.err}>relay offline: {snap.relayError.slice(0, 60)}</Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}
