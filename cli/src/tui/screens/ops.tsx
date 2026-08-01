import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { shellExec } from "../../exec.js";
import { runDeploy, runHealth, runRevoke, runSecretRotate, runUnrevoke } from "../../ops.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { FooterHints } from "../components/FooterHints.js";
import { SelectModal } from "../components/SelectModal.js";
import { TextPrompt } from "../components/TextPrompt.js";
import { theme } from "../theme.js";

type Op = "deploy" | "health" | "secret_rotate" | "revoke" | "unrevoke";

type Step =
  | { kind: "menu" }
  | { kind: "app"; op: Op }
  | { kind: "peer"; op: "revoke" | "unrevoke"; app: string }
  | { kind: "confirm"; op: Op; app: string; peer?: string }
  | { kind: "result"; ok: boolean; text: string };

const MENU: { value: Op; label: string; danger?: boolean }[] = [
  { value: "deploy", label: "Deploy relay" },
  { value: "health", label: "Health check" },
  { value: "secret_rotate", label: "Rotate RELAY_SECRET", danger: true },
  { value: "revoke", label: "Revoke peer", danger: true },
  { value: "unrevoke", label: "Unrevoke peer" },
];

export function OpsScreen({ inputActive }: { inputActive: boolean }) {
  const [step, setStep] = useState<Step>({ kind: "menu" });
  const [lastApp, setLastApp] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (op: Op, app: string, peer?: string) => {
    setBusy(true);
    try {
      if (op === "deploy") {
        const r = await runDeploy({ app, exec: shellExec });
        setStep({ kind: "result", ok: true, text: `deployed ${r.webUrl}` });
      } else if (op === "health") {
        await runHealth({ app, exec: shellExec });
        setStep({ kind: "result", ok: true, text: "health ok (see console if logged)" });
      } else if (op === "secret_rotate") {
        await runSecretRotate({ app, exec: shellExec });
        setStep({ kind: "result", ok: true, text: "secret rotated — all peers must rejoin" });
      } else if (op === "revoke" && peer) {
        await runRevoke(peer, app, shellExec);
        setStep({ kind: "result", ok: true, text: `revoked ${peer}` });
      } else if (op === "unrevoke" && peer) {
        await runUnrevoke(peer, app, shellExec);
        setStep({ kind: "result", ok: true, text: `unrevoked ${peer}` });
      }
    } catch (err) {
      setStep({ kind: "result", ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  useInput(
    (_i, key) => {
      if ((step.kind === "result" || step.kind === "menu") && step.kind === "result" && (key.return || key.escape)) {
        setStep({ kind: "menu" });
      }
    },
    { isActive: inputActive && step.kind === "result" },
  );

  if (step.kind === "app") {
    return (
      <TextPrompt
        label="Heroku app name"
        initial={lastApp}
        validate={(v) => (/^[a-z][a-z0-9-]{2,29}$/.test(v.trim()) ? true : "invalid app name")}
        onCancel={() => setStep({ kind: "menu" })}
        onSubmit={(app) => {
          const trimmed = app.trim();
          setLastApp(trimmed);
          if (step.op === "revoke" || step.op === "unrevoke") {
            setStep({ kind: "peer", op: step.op, app: trimmed });
          } else if (step.op === "secret_rotate") {
            setStep({ kind: "confirm", op: step.op, app: trimmed });
          } else {
            void run(step.op, trimmed);
          }
        }}
      />
    );
  }

  if (step.kind === "peer") {
    return (
      <TextPrompt
        label={`Peer to ${step.op}`}
        validate={(v) => (v.trim() ? true : "required")}
        onCancel={() => setStep({ kind: "app", op: step.op })}
        onSubmit={(peer) => setStep({ kind: "confirm", op: step.op, app: step.app, peer: peer.trim() })}
      />
    );
  }

  if (step.kind === "confirm") {
    return (
      <ConfirmModal
        danger
        title={
          step.op === "secret_rotate"
            ? `Rotate secret on ${step.app}?`
            : `${step.op} ${step.peer} on ${step.app}?`
        }
        body={step.op === "secret_rotate" ? "This breaks every peer token." : undefined}
        onCancel={() => setStep({ kind: "menu" })}
        onConfirm={() => void run(step.op, step.app, step.peer)}
      />
    );
  }

  if (step.kind === "result") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={step.ok ? theme.ok : theme.err} paddingX={1}>
        <Text color={step.ok ? theme.ok : theme.err}>{step.text}</Text>
        <FooterHints hints="Enter back" />
      </Box>
    );
  }

  if (busy) {
    return <Text color={theme.warn}>working…</Text>;
  }

  return (
    <Box flexDirection="column">
      <SelectModal
        title="Relay ops (owner)"
        options={MENU.map((m) => ({ value: m.value, label: m.danger ? `! ${m.label}` : m.label }))}
        onCancel={() => undefined}
        onSelect={(op) => setStep({ kind: "app", op })}
      />
      <FooterHints hints="Esc does nothing here · Tab to leave · Ctrl+C twice to quit" />
    </Box>
  );
}
