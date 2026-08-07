import { Box, Text } from "ink";
import { APP_VERSION, theme } from "./theme.js";
import type { StatusSnapshot } from "./useStatusSnapshot.js";

/** Color for the incoming open count: green 1–10, yellow 11–29, red 30+. */
export function incomingValueColor(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return theme.dim;
  if (n >= 30) return theme.err;
  if (n > 10) {
    // 11 → soft yellow, 29 → orange
    const t = (Math.min(n, 29) - 11) / 18;
    const r = 253;
    const g = Math.round(224 - t * (224 - 120));
    const b = Math.round(71 - t * 71);
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }
  // 1 → light green, 10 → strong green
  const t = (Math.min(n, 10) - 1) / 9;
  const r = Math.round(134 - t * (134 - 22));
  const g = Math.round(239 - t * (239 - 163));
  const b = Math.round(172 - t * (172 - 74));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function Chip({
  label,
  value,
  ok,
  valueColor,
}: {
  label: string;
  value: string;
  ok?: boolean;
  valueColor?: string;
}) {
  const color =
    valueColor
    ?? (ok === undefined ? theme.highlight : ok ? theme.ok : theme.dim);
  return (
    <Box marginRight={2}>
      <Text color={theme.dim}>{label} </Text>
      <Text color={color} bold={ok === true}>
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

export function Header({
  snap,
  updateAvailable,
}: {
  snap: StatusSnapshot;
  /** Latest version string when an update is available. */
  updateAvailable?: string | null;
}) {
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
          {updateAvailable ? (
            <Text color={theme.warn}> · update v{updateAvailable}</Text>
          ) : null}
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
            <Chip
              label="incoming"
              value={String(incoming)}
              valueColor={incomingValueColor(incoming)}
              ok={incoming > 0 ? true : undefined}
            />
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
