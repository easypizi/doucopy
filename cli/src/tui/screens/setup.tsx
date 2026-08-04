import { Box, Text } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchStatus, joinRelay, normalizeRelayUrl } from "../../api.js";
import { shellExec } from "../../exec.js";
import {
  NAME_PATTERN,
  NEVER_REVEAL_PRESETS,
  clearDraft,
  defaultName,
  finalizeJoin,
  peerNameChoices,
  readDraft,
  readExistingConnection,
  writeDraft,
  type JoinClient,
  type JoinResponderChoice,
} from "../../join.js";
import { loadRelaySecretFromHeroku, runDeploy } from "../../ops.js";
import {
  READ_DENY_PRESETS,
  SAFE_RESTRICTIONS,
  SHELL_DENY_PRESETS,
  WRITE_ALLOW_PRESETS,
  type RestrictionsSettings,
} from "../../settings.js";
import { detectAskers, detectResponders, responderHarnessDisabledReason } from "../../setup.js";
import { areAllSkillsInstalled } from "../../skills.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { FooterHints } from "../components/FooterHints.js";
import { ListEditor } from "../components/ListEditor.js";
import { SelectModal } from "../components/SelectModal.js";
import { TextPrompt } from "../components/TextPrompt.js";
import { WizardFrame } from "../components/WizardFrame.js";
import { theme } from "../theme.js";

type Phase =
  | { kind: "owner_app" }
  | { kind: "owner_confirm"; app: string }
  | { kind: "owner_deploying"; app: string }
  | { kind: "reuse" }
  | { kind: "relay" }
  | { kind: "invite" }
  | { kind: "name" }
  | { kind: "name_custom" }
  | { kind: "joining" }
  | { kind: "askers" }
  | { kind: "responder" }
  | { kind: "skills" }
  | { kind: "never" }
  | { kind: "never_list" }
  | { kind: "restrictions_ask" }
  | { kind: "write_mode" }
  | { kind: "write_allow" }
  | { kind: "shell_mode" }
  | { kind: "shell_deny" }
  | { kind: "read_deny" }
  | { kind: "finalize" }
  | { kind: "done"; messages: string[]; ok: boolean };

interface Draft {
  relayUrl: string;
  invite: string;
  peer: string;
  token: string;
  askers: JoinClient[];
  responder: JoinResponderChoice;
  wantSkills: boolean;
  neverReveal: string[];
  restrictions: RestrictionsSettings;
}

const EMPTY_RESTRICTIONS: RestrictionsSettings = {
  fs_write: { mode: "workspace_only", allow: [] },
  fs_read: { deny: [] },
  shell: { mode: "off", deny: [] },
};

function safeRestrictions(): RestrictionsSettings {
  return {
    fs_write: { ...SAFE_RESTRICTIONS.fs_write, allow: [] },
    fs_read: { deny: [] },
    shell: { ...SAFE_RESTRICTIONS.shell, deny: [] },
  };
}

export type SetupScreenDeps = {
  joinRelay?: typeof joinRelay;
  finalizeJoin?: typeof finalizeJoin;
  clearDraft?: typeof clearDraft;
  areAllSkillsInstalled?: typeof areAllSkillsInstalled;
};

/** Test-only bootstrap to skip the interactive prefix of the wizard. */
export type SetupTestBootstrap = {
  phase: Phase;
  data: Partial<Draft>;
};

export function SetupScreen({
  home,
  setupMode,
  argv = [],
  deps,
  testBootstrap,
}: {
  home: string;
  setupMode?: boolean;
  argv?: string[];
  inputActive?: boolean;
  deps?: SetupScreenDeps;
  testBootstrap?: SetupTestBootstrap;
}) {
  const joinRelayFn = deps?.joinRelay ?? joinRelay;
  const finalizeJoinFn = deps?.finalizeJoin ?? finalizeJoin;
  const clearDraftFn = deps?.clearDraft ?? clearDraft;
  const skillsInstalledFn = deps?.areAllSkillsInstalled ?? areAllSkillsInstalled;

  const existing = useMemo(() => readExistingConnection(home), [home]);
  const draftPrefill = useMemo(() => readDraft(home), [home]);
  const flagUrl = argv[0];
  const flagInvite = argv[1];

  const [phase, setPhase] = useState<Phase>(() => {
    if (testBootstrap) return testBootstrap.phase;
    if (setupMode) return { kind: "owner_app" };
    if (existing && !flagUrl && !flagInvite) return { kind: "reuse" };
    return { kind: "relay" };
  });
  const [data, setData] = useState<Partial<Draft>>(() => {
    if (testBootstrap) return { ...testBootstrap.data };
    return {
      relayUrl: flagUrl ? normalizeRelayUrl(flagUrl) : draftPrefill?.relayUrl,
      invite: flagInvite ?? draftPrefill?.invite,
      restrictions: safeRestrictions(),
      neverReveal: [],
      askers: [],
      wantSkills: true,
    };
  });
  const [log, setLog] = useState<string[]>([]);
  const ran = useRef<string>("");

  const pushLog = (line: string) => setLog((prev) => [...prev, line]);

  useEffect(() => {
    const key = phase.kind === "owner_deploying" ? `deploy:${phase.app}` : phase.kind;
    if (ran.current === key) return;

    if (phase.kind === "owner_deploying") {
      ran.current = key;
      void (async () => {
        try {
          const deployed = await runDeploy({ app: phase.app, exec: shellExec });
          const secret = await loadRelaySecretFromHeroku(phase.app, shellExec);
          const { createTokenService } = await import("../../../../relay/dist/auth.js");
          const { invite } = createTokenService(secret).issueInvite(24);
          const relayUrl = normalizeRelayUrl(deployed.webUrl);
          setData((d) => ({ ...d, relayUrl, invite }));
          writeDraft(home, relayUrl, invite);
          pushLog(`relay up at ${deployed.webUrl}`);
          setPhase({ kind: "name" });
        } catch (err) {
          setPhase({
            kind: "done",
            ok: false,
            messages: [err instanceof Error ? err.message : String(err)],
          });
        }
      })();
      return;
    }

    if (phase.kind === "joining") {
      ran.current = key;
      if (data.token) {
        setPhase({ kind: "askers" });
        return;
      }
      void (async () => {
        try {
          const joined = await joinRelayFn(data.relayUrl!, data.invite!, data.peer!);
          setData((d) => ({ ...d, token: joined.token, peer: joined.peer }));
          pushLog(`joined as "${joined.peer}"`);
          setPhase({ kind: "askers" });
        } catch (err) {
          setPhase({
            kind: "done",
            ok: false,
            messages: [err instanceof Error ? err.message : String(err)],
          });
        }
      })();
      return;
    }

    if (phase.kind === "skills") {
      ran.current = key;
      const skillClients = (data.askers ?? []).filter((c): c is "cursor" | "claude" => c === "cursor" || c === "claude");
      if (skillClients.length === 0 || skillsInstalledFn(home, skillClients)) {
        setData((d) => ({ ...d, wantSkills: false }));
        setPhase({ kind: "never" });
      }
      return;
    }

    if (phase.kind === "never" && data.responder === "asker-only") {
      ran.current = key;
      setPhase({ kind: "finalize" });
      return;
    }

    if (phase.kind === "finalize") {
      ran.current = key;
      void (async () => {
        const result = await finalizeJoinFn(home, {
          relayUrl: data.relayUrl!,
          peer: data.peer!,
          token: data.token!,
          askers: data.askers ?? [],
          responder: data.responder ?? "asker-only",
          wantSkills: data.wantSkills ?? false,
          neverReveal: data.neverReveal ?? [],
          restrictions: data.restrictions ?? safeRestrictions(),
        });
        if (result.ok) clearDraftFn(home);
        setPhase({ kind: "done", ok: result.ok, messages: [...result.messages, ...result.errors] });
      })();
    }
  }, [phase, data, home, joinRelayFn, finalizeJoinFn, clearDraftFn, skillsInstalledFn]);

  if (phase.kind === "owner_app") {
    return (
      <WizardFrame title="Owner setup" step={1} total={8}>
        <TextPrompt
          label="Heroku app name"
          validate={(v) => (/^[a-z][a-z0-9-]{2,29}$/.test(v.trim()) ? true : "3-30 chars, lowercase")}
          onCancel={() => undefined}
          onSubmit={(app) => setPhase({ kind: "owner_confirm", app: app.trim() })}
        />
      </WizardFrame>
    );
  }

  if (phase.kind === "owner_confirm") {
    return (
      <ConfirmModal
        title={`Deploy relay to ${phase.app}?`}
        onCancel={() => setPhase({ kind: "owner_app" })}
        onConfirm={() => {
          ran.current = "";
          setPhase({ kind: "owner_deploying", app: phase.app });
        }}
      />
    );
  }

  if (phase.kind === "owner_deploying") {
    return <Text color={theme.warn}>Deploying…</Text>;
  }

  if (phase.kind === "reuse" && existing) {
    return (
      <ConfirmModal
        title={`Reuse ${existing.peer} @ ${existing.relayUrl}?`}
        body="Yes = tweak settings with existing token. No = fresh join."
        onCancel={() => setPhase({ kind: "relay" })}
        onConfirm={() => {
          void (async () => {
            try {
              await fetchStatus(existing.relayUrl, existing.token);
              setData((d) => ({
                ...d,
                relayUrl: existing.relayUrl,
                peer: existing.peer,
                token: existing.token,
              }));
              setPhase({ kind: "askers" });
            } catch {
              pushLog("existing token invalid, fresh join");
              setPhase({ kind: "relay" });
            }
          })();
        }}
      />
    );
  }

  if (phase.kind === "relay") {
    return (
      <WizardFrame title="Join" step={2} total={10}>
        <TextPrompt
          label="Relay URL"
          initial={data.relayUrl ?? ""}
          validate={(v) => (v.trim() ? true : "required")}
          onCancel={() => setPhase(existing ? { kind: "reuse" } : { kind: "relay" })}
          onSubmit={(v) => {
            setData((d) => ({ ...d, relayUrl: normalizeRelayUrl(v.trim()) }));
            setPhase({ kind: "invite" });
          }}
        />
      </WizardFrame>
    );
  }

  if (phase.kind === "invite") {
    return (
      <WizardFrame title="Join" step={3} total={10}>
        <TextPrompt
          label="Invite code"
          initial={data.invite ?? ""}
          validate={(v) => (v.trim() ? true : "required")}
          onCancel={() => setPhase({ kind: "relay" })}
          onSubmit={(v) => {
            const invite = v.trim();
            writeDraft(home, data.relayUrl!, invite);
            setData((d) => ({ ...d, invite }));
            setPhase({ kind: "name" });
          }}
        />
      </WizardFrame>
    );
  }

  if (phase.kind === "name") {
    const choices = peerNameChoices();
    return (
      <SelectModal
        title="Peer name"
        options={choices.map((c) => ({ value: c.value, label: c.name }))}
        initial={defaultName() || choices[0]?.value}
        onCancel={() => setPhase(data.token ? { kind: "askers" } : { kind: "invite" })}
        onSelect={(v) => {
          if (v === "__custom__") setPhase({ kind: "name_custom" });
          else {
            ran.current = "";
            setData((d) => ({ ...d, peer: v }));
            setPhase({ kind: "joining" });
          }
        }}
      />
    );
  }

  if (phase.kind === "name_custom") {
    return (
      <TextPrompt
        label="Custom peer name"
        initial={defaultName()}
        validate={(v) => (NAME_PATTERN.test(v.trim()) ? true : "must match [A-Za-z0-9._-]{1,64}")}
        onCancel={() => setPhase({ kind: "name" })}
        onSubmit={(v) => {
          ran.current = "";
          setData((d) => ({ ...d, peer: v.trim() }));
          setPhase({ kind: "joining" });
        }}
      />
    );
  }

  if (phase.kind === "joining") {
    return <Text color={theme.warn}>Joining relay…</Text>;
  }

  if (phase.kind === "askers") {
    const detected = detectAskers(home);
    const clients: JoinClient[] = ["cursor", "claude", "codex"];
    return (
      <SelectModal
        title="Asker clients"
        options={[
          {
            value: "all_detected",
            label: `All detected (${clients.filter((c) => detected[c]).join(", ") || "none"})`,
          },
          { value: "cursor", label: "Cursor only" },
          { value: "claude", label: "Claude only" },
          { value: "codex", label: "Codex only" },
          { value: "none", label: "None" },
        ]}
        onCancel={() => setPhase({ kind: "name" })}
        onSelect={(v) => {
          let askers: JoinClient[] = [];
          if (v === "all_detected") askers = clients.filter((c) => detected[c]);
          else if (v === "none") askers = [];
          else askers = [v as JoinClient];
          ran.current = "";
          setData((d) => ({ ...d, askers }));
          setPhase({ kind: "responder" });
        }}
      />
    );
  }

  if (phase.kind === "responder") {
    const detected = detectResponders();
    const option = (value: Exclude<JoinResponderChoice, "asker-only">, present: boolean) => {
      const reason = responderHarnessDisabledReason(present);
      return {
        value,
        label: reason ? `${value} ${reason}` : value,
        disabled: Boolean(reason),
      };
    };
    return (
      <SelectModal
        title="Responder harness"
        options={[
          option("cursor-agent", detected.cursor),
          option("claude", detected.claude),
          option("codex", detected.codex),
          { value: "asker-only", label: "asker-only" },
        ]}
        onCancel={() => setPhase({ kind: "askers" })}
        onSelect={(v) => {
          ran.current = "";
          setData((d) => ({ ...d, responder: v as JoinResponderChoice }));
          setPhase({ kind: "skills" });
        }}
      />
    );
  }

  if (phase.kind === "skills") {
    const skillClients = (data.askers ?? []).filter((c): c is "cursor" | "claude" => c === "cursor" || c === "claude");
    if (skillClients.length === 0 || areAllSkillsInstalled(home, skillClients)) {
      return <Text color={theme.dim}>Skipping skills…</Text>;
    }
    return (
      <ConfirmModal
        title={`Install skills into ${skillClients.map((c) => `~/.${c}/skills`).join(" and ")}?`}
        onCancel={() => {
          ran.current = "";
          setData((d) => ({ ...d, wantSkills: false }));
          setPhase({ kind: "never" });
        }}
        onConfirm={() => {
          ran.current = "";
          setData((d) => ({ ...d, wantSkills: true }));
          setPhase({ kind: "never" });
        }}
      />
    );
  }

  if (phase.kind === "never") {
    if (data.responder === "asker-only") {
      return <Text color={theme.dim}>Skipping never-reveal…</Text>;
    }
    return (
      <SelectModal
        title="Never-reveal literals"
        options={[
          { value: "skip", label: "Skip" },
          { value: "pick", label: "Pick presets" },
        ]}
        onCancel={() => setPhase({ kind: "skills" })}
        onSelect={(v) => {
          if (v === "skip") {
            setData((d) => ({ ...d, neverReveal: [] }));
            setPhase({ kind: "restrictions_ask" });
          } else setPhase({ kind: "never_list" });
        }}
      />
    );
  }

  if (phase.kind === "never_list") {
    return (
      <ListEditor
        title="Never reveal"
        presets={NEVER_REVEAL_PRESETS.map((p) => p.value)}
        current={data.neverReveal ?? []}
        onCancel={() => setPhase({ kind: "never" })}
        onSave={(neverReveal) => {
          setData((d) => ({ ...d, neverReveal }));
          setPhase({ kind: "restrictions_ask" });
        }}
      />
    );
  }

  if (phase.kind === "restrictions_ask") {
    return (
      <SelectModal
        title="Responder restrictions"
        options={[
          { value: "skip", label: "Skip (safe default: workspace writes, shell off)" },
          { value: "edit", label: "Configure now" },
        ]}
        onCancel={() => setPhase({ kind: "never" })}
        onSelect={(v) => {
          if (v === "skip") {
            setData((d) => ({ ...d, restrictions: safeRestrictions() }));
            ran.current = "";
            setPhase({ kind: "finalize" });
          } else setPhase({ kind: "write_mode" });
        }}
      />
    );
  }

  if (phase.kind === "write_mode") {
    return (
      <SelectModal
        title="Write mode"
        options={[
          { value: "workspace_only", label: "workspace_only" },
          { value: "custom", label: "custom" },
        ]}
        onCancel={() => setPhase({ kind: "restrictions_ask" })}
        onSelect={(mode) => {
          setData((d) => ({
            ...d,
            restrictions: {
              ...(d.restrictions ?? EMPTY_RESTRICTIONS),
              fs_write: {
                mode: mode as "workspace_only" | "custom",
                allow: d.restrictions?.fs_write.allow ?? [],
              },
            },
          }));
          setPhase(mode === "custom" ? { kind: "write_allow" } : { kind: "shell_mode" });
        }}
      />
    );
  }

  if (phase.kind === "write_allow") {
    return (
      <ListEditor
        title="Write allow"
        presets={WRITE_ALLOW_PRESETS}
        current={data.restrictions?.fs_write.allow ?? []}
        onCancel={() => setPhase({ kind: "write_mode" })}
        onSave={(allow) => {
          setData((d) => ({
            ...d,
            restrictions: {
              ...(d.restrictions ?? EMPTY_RESTRICTIONS),
              fs_write: { mode: "custom", allow },
            },
          }));
          setPhase({ kind: "shell_mode" });
        }}
      />
    );
  }

  if (phase.kind === "shell_mode") {
    return (
      <SelectModal
        title="Shell mode"
        options={[
          { value: "off", label: "off" },
          { value: "deny_patterns", label: "deny_patterns" },
          { value: "open", label: "open" },
        ]}
        onCancel={() => setPhase({ kind: "write_mode" })}
        onSelect={(mode) => {
          setData((d) => ({
            ...d,
            restrictions: {
              ...(d.restrictions ?? EMPTY_RESTRICTIONS),
              shell: {
                mode: mode as "off" | "deny_patterns" | "open",
                deny: d.restrictions?.shell.deny ?? [],
              },
            },
          }));
          setPhase(mode === "deny_patterns" ? { kind: "shell_deny" } : { kind: "read_deny" });
        }}
      />
    );
  }

  if (phase.kind === "shell_deny") {
    return (
      <ListEditor
        title="Shell deny"
        presets={SHELL_DENY_PRESETS}
        current={data.restrictions?.shell.deny ?? []}
        onCancel={() => setPhase({ kind: "shell_mode" })}
        onSave={(deny) => {
          setData((d) => ({
            ...d,
            restrictions: {
              ...(d.restrictions ?? EMPTY_RESTRICTIONS),
              shell: { mode: "deny_patterns", deny },
            },
          }));
          setPhase({ kind: "read_deny" });
        }}
      />
    );
  }

  if (phase.kind === "read_deny") {
    return (
      <ListEditor
        title="Read deny"
        presets={READ_DENY_PRESETS}
        current={data.restrictions?.fs_read.deny ?? []}
        onCancel={() => setPhase({ kind: "shell_mode" })}
        onSave={(deny) => {
          setData((d) => ({
            ...d,
            restrictions: {
              ...(d.restrictions ?? EMPTY_RESTRICTIONS),
              fs_read: { deny },
            },
          }));
          ran.current = "";
          setPhase({ kind: "finalize" });
        }}
      />
    );
  }

  if (phase.kind === "finalize") {
    return <Text color={theme.warn}>Writing config and starting daemon…</Text>;
  }

  if (phase.kind === "done") {
    return (
      <Box flexDirection="column">
        <Text color={phase.ok ? theme.ok : theme.err} bold>
          {phase.ok ? "Setup complete" : "Setup failed"}
        </Text>
        {[...log, ...phase.messages].map((m, i) => (
          <Text key={i}>{m}</Text>
        ))}
        <FooterHints hints="Tab to Status · Ctrl+C twice to quit" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>Setup</Text>
    </Box>
  );
}
