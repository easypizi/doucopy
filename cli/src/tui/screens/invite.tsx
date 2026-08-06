import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { requestInvite } from "../../api.js";
import { shellExec } from "../../exec.js";
import { pushHistory, readHistory } from "../../field-history.js";
import { loadRelaySecretFromHeroku } from "../../ops.js";
import { readConfigFile } from "../../settings.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { FooterHints } from "../components/FooterHints.js";
import { SelectModal } from "../components/SelectModal.js";
import { TextPrompt } from "../components/TextPrompt.js";
import { theme } from "../theme.js";

type Step =
  | { kind: "menu" }
  | { kind: "ttl" }
  | { kind: "mode" }
  | { kind: "secret" }
  | { kind: "app_pick" }
  | { kind: "app" }
  | { kind: "result"; invite: string; expires: number; relayUrl?: string }
  | { kind: "error"; message: string };

export function InviteScreen({ home, inputActive }: { home: string; inputActive: boolean }) {
  const [step, setStep] = useState<Step>({ kind: "menu" });
  const [ttl, setTtl] = useState(24);
  const [busy, setBusy] = useState(false);

  const mintWithSecret = async (secret: string, relayUrl?: string) => {
    setBusy(true);
    try {
      const { createTokenService } = await import("../../../../relay/dist/auth.js");
      const { invite, expires_at } = createTokenService(secret).issueInvite(ttl);
      setStep({ kind: "result", invite, expires: expires_at, relayUrl });
    } catch (err) {
      setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const mintViaRelay = async () => {
    const config = readConfigFile(home);
    if (!config?.relay_url || !config.token) {
      setStep({ kind: "error", message: "no config — join first or use secret/app mode" });
      return;
    }
    setBusy(true);
    try {
      const result = await requestInvite(config.relay_url, config.token, ttl);
      setStep({ kind: "result", invite: result.invite, expires: result.expires_at, relayUrl: config.relay_url });
    } catch (err) {
      setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  useInput(
    (_i, key) => {
      if (step.kind === "menu" && key.return) setStep({ kind: "ttl" });
      if ((step.kind === "result" || step.kind === "error") && (key.return || key.escape)) {
        setStep({ kind: "menu" });
      }
    },
    { isActive: inputActive && !busy && (step.kind === "menu" || step.kind === "result" || step.kind === "error") },
  );

  if (step.kind === "ttl") {
    return (
      <SelectModal
        title="Invite TTL"
        options={[
          { value: "24", label: "24 hours" },
          { value: "72", label: "72 hours" },
          { value: "168", label: "7 days" },
        ]}
        initial={String(ttl)}
        onCancel={() => setStep({ kind: "menu" })}
        onSelect={(v) => {
          setTtl(Number(v));
          setStep({ kind: "mode" });
        }}
      />
    );
  }

  if (step.kind === "mode") {
    return (
      <SelectModal
        title="How to mint"
        options={[
          { value: "relay", label: "Via this machine's relay token" },
          { value: "secret", label: "With RELAY_SECRET" },
          { value: "app", label: "Load secret from Heroku app" },
        ]}
        onCancel={() => setStep({ kind: "ttl" })}
        onSelect={(v) => {
          if (v === "relay") void mintViaRelay();
          else if (v === "secret") setStep({ kind: "secret" });
          else setStep(readHistory(home).heroku_apps.length > 0 ? { kind: "app_pick" } : { kind: "app" });
        }}
      />
    );
  }

  if (step.kind === "secret") {
    return (
      <TextPrompt
        label="RELAY_SECRET"
        mask
        onCancel={() => setStep({ kind: "mode" })}
        validate={(v) => (v.trim() ? true : "required")}
        onSubmit={(secret) => void mintWithSecret(secret.trim())}
      />
    );
  }

  if (step.kind === "app_pick") {
    const apps = readHistory(home).heroku_apps;
    return (
      <SelectModal
        title="Heroku app name"
        options={[
          ...apps.map((app) => ({ value: app, label: app })),
          { value: "__custom__", label: "Custom…" },
        ]}
        onCancel={() => setStep({ kind: "mode" })}
        onSelect={(v) => {
          if (v === "__custom__") setStep({ kind: "app" });
          else {
            void (async () => {
              setBusy(true);
              try {
                pushHistory(home, { heroku_app: v });
                const secret = await loadRelaySecretFromHeroku(v, shellExec);
                await mintWithSecret(secret);
              } catch (err) {
                setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) });
                setBusy(false);
              }
            })();
          }
        }}
      />
    );
  }

  if (step.kind === "app") {
    return (
      <TextPrompt
        key="invite_app"
        label="Heroku app name"
        onCancel={() =>
          setStep(readHistory(home).heroku_apps.length > 0 ? { kind: "app_pick" } : { kind: "mode" })
        }
        validate={(v) => (/^[a-z][a-z0-9-]{2,29}$/.test(v.trim()) ? true : "invalid app name")}
        onSubmit={(app) => {
          void (async () => {
            setBusy(true);
            try {
              const name = app.trim();
              pushHistory(home, { heroku_app: name });
              const secret = await loadRelaySecretFromHeroku(name, shellExec);
              await mintWithSecret(secret);
            } catch (err) {
              setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) });
              setBusy(false);
            }
          })();
        }}
      />
    );
  }

  if (step.kind === "result") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ok} paddingX={1}>
        <Text color={theme.ok} bold>
          Invite ready
        </Text>
        <Text>valid until {new Date(step.expires).toISOString()}</Text>
        <Text color={theme.highlight}>{step.invite}</Text>
        {step.relayUrl ? (
          <Text color={theme.dim}>
            npx doucopy join {step.relayUrl} {step.invite}
          </Text>
        ) : null}
        <FooterHints hints="Enter back" />
      </Box>
    );
  }

  if (step.kind === "error") {
    return (
      <ConfirmModal
        title="Invite failed"
        body={step.message}
        danger
        onCancel={() => setStep({ kind: "menu" })}
        onConfirm={() => setStep({ kind: "menu" })}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>
        Create invite
      </Text>
      <Text>Mint a join code for a new machine.</Text>
      {busy ? <Text color={theme.warn}>working…</Text> : null}
      <FooterHints hints="Enter start · Esc/Tab leave · Ctrl+C twice to quit" />
    </Box>
  );
}
