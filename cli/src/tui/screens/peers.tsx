import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { FooterHints } from "../components/FooterHints.js";
import { SelectModal } from "../components/SelectModal.js";
import { TextPrompt } from "../components/TextPrompt.js";
import { theme } from "../theme.js";
import type { StatusSnapshot } from "../useStatusSnapshot.js";

type Mode =
  | { kind: "list" }
  | { kind: "duration"; peer: string }
  | { kind: "custom_peer" }
  | { kind: "message"; text: string };

function parseFor(spec: string): number | null {
  if (spec === "indefinite") return null;
  const match = spec.match(/^(\d+)(h|d)$/);
  if (!match) return null;
  const n = Number(match[1]);
  const ms = match[2] === "h" ? n * 3600_000 : n * 86400_000;
  return Date.now() + ms;
}

export function PeersScreen({
  snap,
  onRefresh,
  inputActive,
}: {
  snap: StatusSnapshot;
  onRefresh: () => void;
  inputActive: boolean;
}) {
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const peers = snap.peers.filter((p) => !p.self);

  useInput(
    (input, key) => {
      if (mode.kind !== "list") return;
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCursor((c) => Math.min(Math.max(peers.length - 1, 0), c + 1));
      if (input === "a") setMode({ kind: "custom_peer" });
      if (input === "r") onRefresh();
      if (key.return && peers[cursor]) {
        const peer = peers[cursor]!;
        if (peer.paused) {
          void (async () => {
            const { resumePeer } = await import("../../../../daemon/dist/paused.js");
            resumePeer(peer.name);
            setMode({ kind: "message", text: `resumed ${peer.name}` });
            onRefresh();
          })();
        } else {
          setMode({ kind: "duration", peer: peer.name });
        }
      }
    },
    { isActive: inputActive && mode.kind === "list" },
  );

  if (mode.kind === "duration") {
    return (
      <SelectModal
        title={`Pause ${mode.peer}`}
        description="Local mute only: your machine will refuse questions from this peer. Their daemon stays running. This does not stop them remotely."
        options={[
          { value: "2h", label: "2 hours" },
          { value: "1d", label: "1 day" },
          { value: "indefinite", label: "Indefinitely" },
        ]}
        onCancel={() => setMode({ kind: "list" })}
        onSelect={(spec) => {
          const until = parseFor(spec);
          void (async () => {
            const { pausePeer } = await import("../../../../daemon/dist/paused.js");
            pausePeer(mode.peer, until);
            setMode({
              kind: "message",
              text:
                until === null
                  ? `paused ${mode.peer} indefinitely (local mute)`
                  : `paused ${mode.peer} until ${new Date(until).toISOString()} (local mute)`,
            });
            onRefresh();
          })();
        }}
      />
    );
  }

  if (mode.kind === "custom_peer") {
    return (
      <TextPrompt
        label="Peer name to pause"
        validate={(v) => (v.trim() ? true : "required")}
        onCancel={() => setMode({ kind: "list" })}
        onSubmit={(name) => setMode({ kind: "duration", peer: name.trim() })}
      />
    );
  }

  if (mode.kind === "message") {
    return (
      <Box flexDirection="column">
        <Text color={theme.ok}>{mode.text}</Text>
        <FooterHints hints="Enter back" />
        <ListenOnce
          active={inputActive}
          onDone={() => setMode({ kind: "list" })}
        />
      </Box>
    );
  }

  if (!snap.joined) {
    return (
      <Box flexDirection="column">
        <Text color={theme.warn}>Join first to manage peers.</Text>
        <FooterHints hints="Tab switch · Ctrl+C twice to quit" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>
        Peers
      </Text>
      <Text color={theme.dim}>
        Pause = local mute (refuse their questions). Does not stop their daemon.
      </Text>
      <Box marginTop={1} flexDirection="column">
        {peers.length === 0 ? (
          <Text color={theme.dim}>No other peers yet. Press a to pause by name.</Text>
        ) : (
          peers.map((p, i) => (
            <Text key={p.name} inverse={i === cursor} color={i === cursor ? theme.highlight : undefined}>
              {i === cursor ? "> " : "  "}
              <Text color={p.online ? theme.ok : theme.dim}>{p.online ? "●" : "○"}</Text> {p.name}
              {p.paused ? <Text color={theme.warn}> paused</Text> : null}
              <Text color={theme.dim}>{p.paused ? " · Enter resume" : " · Enter pause"}</Text>
            </Text>
          ))
        )}
      </Box>
      <FooterHints hints="↑↓ · Enter pause/resume · a pause by name · r refresh · Tab switch" />
    </Box>
  );
}

function ListenOnce({ active, onDone }: { active: boolean; onDone: () => void }) {
  useInput(
    (_i, key) => {
      if (key.return || key.escape) onDone();
    },
    { isActive: active },
  );
  return null;
}
