import { Box, Text, useInput } from "ink";
import { homedir } from "node:os";
import { useMemo, useRef, useState } from "react";
import { useHoldKeyCapture } from "../key-capture.js";
import { NAME_PATTERN } from "../../join.js";
import { RESPONDER_DAEMON_UNSUPPORTED, responderDaemonSupported, startDaemon, stopDaemon } from "../../launchd.js";
import { clearLocalAskSessions } from "../../local-ask.js";
import { renamePeer } from "../../rename-peer.js";
import {
  READ_DENY_PRESETS,
  REDACT_LITERAL_PRESETS,
  SHELL_DENY_PRESETS,
  WRITE_ALLOW_PRESETS,
  applyHarness,
  applyKeepAwake,
  applyRedactLiterals,
  applyResponderField,
  applyRestrictions,
  isModelValidForHarness,
  keepAwakeFromConfig,
  modelPresetsFor,
  readConfigFile,
  restrictionsFromConfig,
  summarizeKeepAwake,
  summarizeRestrictions,
  type DoucopyConfigFile,
  type FsWriteMode,
  type KeepAwakeSettings,
  type RestrictionsSettings,
  type ShellMode,
} from "../../settings.js";
import { runPolicy } from "../../policy.js";
import { detectResponders, responderHarnessDisabledReason, writeConfig, type HarnessKind } from "../../setup.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { FooterHints } from "../components/FooterHints.js";
import { ListEditor } from "../components/ListEditor.js";
import { SelectModal } from "../components/SelectModal.js";
import { TextPrompt } from "../components/TextPrompt.js";
import { theme } from "../theme.js";

type Editor =
  | { kind: "none" }
  | { kind: "select"; field: string }
  | { kind: "list"; field: string }
  | { kind: "text"; field: string }
  | { kind: "discard" }
  | { kind: "restart" }
  | { kind: "peer_confirm"; newName: string }
  | { kind: "peer_busy"; newName: string };

interface Row {
  id: string;
  label: string;
  value: string;
  filter: string;
  kind: "bool" | "enum" | "list" | "action" | "text";
}

const PERSONA_PRESETS = ["Concise", "Detailed", "Friendly", "Professional"] as const;

function buildRows(draft: DoucopyConfigFile, restartOnSave: boolean): Row[] {
  const r = restrictionsFromConfig(draft);
  const ka = keepAwakeFromConfig(draft);
  const harness = (draft.responder?.harness ?? "cursor-agent") as HarnessKind;
  return [
    {
      id: "peer_name",
      label: "Peer name",
      value: draft.self_peer ?? "(none)",
      filter: "peer name rename network",
      kind: "text",
    },
    { id: "write_mode", label: "Write mode", value: r.fs_write.mode, filter: "write restrictions", kind: "enum" },
    {
      id: "write_allow",
      label: "Write allow",
      value: r.fs_write.mode === "workspace_only" ? "(n/a)" : `(${r.fs_write.allow.length})`,
      filter: "write allow folders",
      kind: "list",
    },
    { id: "shell_mode", label: "Shell mode", value: r.shell.mode, filter: "shell", kind: "enum" },
    {
      id: "shell_deny",
      label: "Shell deny",
      value: r.shell.mode === "deny_patterns" ? `(${r.shell.deny.length})` : "(n/a)",
      filter: "shell deny",
      kind: "list",
    },
    {
      id: "read_deny",
      label: "Read deny",
      value: r.fs_read.deny.length ? `(${r.fs_read.deny.length})` : "(none)",
      filter: "read deny blocklist",
      kind: "list",
    },
    { id: "model", label: "Model", value: draft.responder?.model ?? "(harness default)", filter: "model", kind: "enum" },
    {
      id: "persona",
      label: "Persona",
      value: draft.responder?.persona?.trim() || "(none)",
      filter: "persona style",
      kind: "enum",
    },
    { id: "harness", label: "Harness", value: harness, filter: "harness responder", kind: "enum" },
    {
      id: "keep_awake",
      label: "Keep awake",
      value: ka.enabled ? "true" : "false",
      filter: "keep awake sleep caffeinate",
      kind: "bool",
    },
    {
      id: "confirm_days",
      label: "Confirm every N days",
      value: String(ka.confirm_days),
      filter: "confirm days keep awake",
      kind: "text",
    },
    {
      id: "confirm_grace",
      label: "Confirm grace hours",
      value: String(ka.confirm_grace_hours),
      filter: "grace keep awake",
      kind: "text",
    },
    {
      id: "redact",
      label: "Redact literals",
      value: (draft.redact?.literals ?? []).length ? `(${(draft.redact?.literals ?? []).length})` : "(none)",
      filter: "redact never reveal",
      kind: "list",
    },
    { id: "policy", label: "Open policy.md", value: "→", filter: "policy editor", kind: "action" },
    {
      id: "restart_on_save",
      label: "Restart daemon on save",
      value: restartOnSave ? "true" : "false",
      filter: "restart daemon",
      kind: "bool",
    },
    { id: "save", label: "★ Save changes", value: "Ctrl+S · Enter", filter: "save", kind: "action" },
  ];
}

function patchRestrictions(draft: DoucopyConfigFile, next: RestrictionsSettings): DoucopyConfigFile {
  return applyRestrictions(draft, next);
}

function patchKeepAwake(draft: DoucopyConfigFile, patch: Partial<KeepAwakeSettings>): DoucopyConfigFile {
  const cur = keepAwakeFromConfig(draft);
  return applyKeepAwake(draft, { ...cur, ...patch });
}

export type SettingsScreenDeps = {
  startDaemon?: typeof startDaemon;
  stopDaemon?: typeof stopDaemon;
};

export function SettingsScreen({
  home = homedir(),
  inputActive,
  onSaved,
  deps,
}: {
  home?: string;
  inputActive: boolean;
  onSaved?: () => void;
  deps?: SettingsScreenDeps;
}) {
  const startDaemonFn = deps?.startDaemon ?? startDaemon;
  const stopDaemonFn = deps?.stopDaemon ?? stopDaemon;
  const initial = readConfigFile(home);
  const [draft, setDraft] = useState<DoucopyConfigFile | null>(initial ? structuredClone(initial) : null);
  const [baseline, setBaseline] = useState(() => (initial ? JSON.stringify(initial) : ""));
  const [restartOnSave, setRestartOnSave] = useState(true);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [editor, setEditor] = useState<Editor>({ kind: "none" });
  const [message, setMessage] = useState<string | null>(null);
  useHoldKeyCapture(filtering || editor.kind !== "none");

  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  const rows = useMemo(() => (draft ? buildRows(draft, restartOnSave) : []), [draft, restartOnSave]);
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => `${r.label} ${r.filter} ${r.value}`.toLowerCase().includes(q));
  }, [rows, filter]);
  const active = visible[cursor] ?? visible[0];

  const latest = useRef({
    draft,
    editor,
    filtering,
    dirty,
    restartOnSave,
    visible,
    active,
    cursor,
  });
  latest.current = { draft, editor, filtering, dirty, restartOnSave, visible, active, cursor };

  const saveDraft = (current: DoucopyConfigFile, doRestart: boolean) => {
    let prevHarness: string | undefined;
    try {
      prevHarness = (JSON.parse(baseline) as DoucopyConfigFile).responder?.harness;
    } catch {
      prevHarness = undefined;
    }
    const nextHarness = current.responder?.harness;
    if (prevHarness !== nextHarness) clearLocalAskSessions();
    writeConfig(home, current);
    setBaseline(JSON.stringify(current));
    setMessage(`wrote ${home}/.doucopy/config.json`);
    if (doRestart) {
      if (!responderDaemonSupported()) {
        setMessage(`saved (${RESPONDER_DAEMON_UNSUPPORTED})`);
      } else {
        try {
          stopDaemonFn(home);
          startDaemonFn(home);
          setMessage("saved and daemon restarted");
        } catch (err) {
          setMessage(`saved, but restart failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    onSaved?.();
    setEditor({ kind: "none" });
  };

  useInput(
    (input, key) => {
      const s = latest.current;
      if (!s.draft) return;
      if (s.editor.kind !== "none") return;
      if (s.filtering) {
        if (key.escape) {
          setFiltering(false);
          setFilter("");
          return;
        }
        if (key.backspace || key.delete) {
          setFilter((f) => f.slice(0, -1));
          return;
        }
        if (key.return) {
          setFiltering(false);
          return;
        }
        if (input && !key.ctrl && !key.meta) setFilter((f) => f + input);
        return;
      }
      if (input === "/") {
        setFiltering(true);
        return;
      }
      if (key.escape) {
        if (s.dirty) setEditor({ kind: "discard" });
        return;
      }
      if (key.ctrl && input === "s") {
        if (s.dirty) saveDraft(s.draft, s.restartOnSave);
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(s.visible.length - 1, c + 1));
        return;
      }
      const row = s.visible[s.cursor] ?? s.visible[0];
      if (!row) return;
      if (input === " " && row.kind === "bool") {
        if (row.id === "keep_awake") {
          const ka = keepAwakeFromConfig(s.draft);
          setDraft(patchKeepAwake(s.draft, { enabled: !ka.enabled }));
        } else if (row.id === "restart_on_save") {
          setRestartOnSave((v) => !v);
        }
        return;
      }
      if (key.return) {
        if (row.id === "save") {
          if (s.dirty) saveDraft(s.draft, s.restartOnSave);
          else setMessage("no changes");
          return;
        }
        if (row.id === "policy") {
          runPolicy(home);
          setMessage("opened policy.md");
          return;
        }
        if (row.id === "write_allow") {
          const r = restrictionsFromConfig(s.draft);
          if (r.fs_write.mode !== "custom") {
            setDraft(
              patchRestrictions(s.draft, {
                ...r,
                fs_write: { mode: "custom", allow: r.fs_write.allow },
              }),
            );
          }
          setEditor({ kind: "list", field: "write_allow" });
          return;
        }
        if (row.id === "shell_deny") {
          const r = restrictionsFromConfig(s.draft);
          if (r.shell.mode !== "deny_patterns") {
            setDraft(
              patchRestrictions(s.draft, {
                ...r,
                shell: { mode: "deny_patterns", deny: r.shell.deny },
              }),
            );
          }
          setEditor({ kind: "list", field: "shell_deny" });
          return;
        }
        if (row.kind === "list") setEditor({ kind: "list", field: row.id });
        else if (row.kind === "enum") setEditor({ kind: "select", field: row.id });
        else if (row.kind === "text") setEditor({ kind: "text", field: row.id });
        else if (row.kind === "bool") {
          if (row.id === "keep_awake") {
            const ka = keepAwakeFromConfig(s.draft);
            setDraft(patchKeepAwake(s.draft, { enabled: !ka.enabled }));
          } else if (row.id === "restart_on_save") setRestartOnSave((v) => !v);
        }
      }
    },
    { isActive: inputActive && editor.kind === "none" },
  );

  if (!draft) {
    return (
      <Box flexDirection="column">
        <Text color={theme.warn}>No config. Join first (Setup tab).</Text>
        <FooterHints hints="Tab switch · Ctrl+C twice to quit" />
      </Box>
    );
  }

  if (editor.kind === "discard") {
    return (
      <ConfirmModal
        title="Discard unsaved changes?"
        onCancel={() => setEditor({ kind: "none" })}
        onConfirm={() => {
          const fresh = readConfigFile(home);
          setDraft(fresh ? structuredClone(fresh) : null);
          setEditor({ kind: "none" });
          setMessage("discarded");
        }}
      />
    );
  }

  if (editor.kind === "select") {
    const field = editor.field;
    if (field === "write_mode") {
      return (
        <SelectModal
          title="Write mode"
          options={[
            { value: "workspace_only", label: "workspace_only" },
            { value: "custom", label: "custom" },
          ]}
          initial={restrictionsFromConfig(draft).fs_write.mode}
          onCancel={() => setEditor({ kind: "none" })}
          onSelect={(mode) => {
            const r = restrictionsFromConfig(draft);
            const next = patchRestrictions(draft, {
              ...r,
              fs_write: { mode: mode as FsWriteMode, allow: r.fs_write.allow },
            });
            setDraft(next);
            setEditor(mode === "custom" ? { kind: "list", field: "write_allow" } : { kind: "none" });
          }}
        />
      );
    }
    if (field === "shell_mode") {
      return (
        <SelectModal
          title="Shell mode"
          options={[
            { value: "off", label: "off" },
            { value: "deny_patterns", label: "deny_patterns" },
            { value: "open", label: "open" },
          ]}
          initial={restrictionsFromConfig(draft).shell.mode}
          onCancel={() => setEditor({ kind: "none" })}
          onSelect={(mode) => {
            const r = restrictionsFromConfig(draft);
            const next = patchRestrictions(draft, {
              ...r,
              shell: { mode: mode as ShellMode, deny: r.shell.deny },
            });
            setDraft(next);
            setEditor(mode === "deny_patterns" ? { kind: "list", field: "shell_deny" } : { kind: "none" });
          }}
        />
      );
    }
    if (field === "harness") {
      const detected = detectResponders();
      const option = (value: HarnessKind, present: boolean) => {
        const reason = responderHarnessDisabledReason(present);
        return {
          value,
          label: reason ? `${value} ${reason}` : value,
          disabled: Boolean(reason),
        };
      };
      return (
        <SelectModal
          title="Harness"
          options={[
            option("cursor-agent", detected.cursor),
            option("claude", detected.claude),
            option("codex", detected.codex),
          ]}
          initial={(draft.responder?.harness ?? "cursor-agent") as HarnessKind}
          onCancel={() => setEditor({ kind: "none" })}
          onSelect={(harness) => {
            let next = applyHarness(draft, harness as HarnessKind);
            if (!isModelValidForHarness(next.responder?.model, harness as HarnessKind)) {
              next = applyResponderField(next, "model", undefined);
              setDraft(next);
              setEditor({ kind: "select", field: "model" });
              return;
            }
            setDraft(next);
            setEditor({ kind: "none" });
          }}
        />
      );
    }
    if (field === "model") {
      const harness = (draft.responder?.harness ?? "cursor-agent") as HarnessKind;
      const presets = modelPresetsFor(harness);
      return (
        <SelectModal
          title={`Model (${harness})`}
          options={[
            ...presets.map((m) => ({ value: m, label: m })),
            { value: "__default__", label: "(harness default)" },
            { value: "__custom__", label: "Custom…" },
          ]}
          initial={draft.responder?.model}
          onCancel={() => setEditor({ kind: "none" })}
          onSelect={(v) => {
            if (v === "__custom__") {
              setEditor({ kind: "text", field: "model_custom" });
              return;
            }
            setDraft(applyResponderField(draft, "model", v === "__default__" ? undefined : v));
            setEditor({ kind: "none" });
          }}
        />
      );
    }
    if (field === "persona") {
      return (
        <SelectModal
          title="Persona"
          options={[
            { value: "__none__", label: "(none)" },
            ...PERSONA_PRESETS.map((p) => ({ value: p, label: p })),
            { value: "__custom__", label: "Custom…" },
          ]}
          initial={draft.responder?.persona}
          onCancel={() => setEditor({ kind: "none" })}
          onSelect={(v) => {
            if (v === "__custom__") {
              setEditor({ kind: "text", field: "persona_custom" });
              return;
            }
            setDraft(applyResponderField(draft, "persona", v === "__none__" ? undefined : v));
            setEditor({ kind: "none" });
          }}
        />
      );
    }
  }

  if (editor.kind === "list") {
    const r = restrictionsFromConfig(draft);
    if (editor.field === "write_allow") {
      return (
        <ListEditor
          title="Write allow paths"
          presets={WRITE_ALLOW_PRESETS}
          current={r.fs_write.allow}
          onCancel={() => setEditor({ kind: "none" })}
          onSave={(allow) => {
            setDraft(patchRestrictions(draft, { ...r, fs_write: { mode: "custom", allow } }));
            setEditor({ kind: "none" });
          }}
        />
      );
    }
    if (editor.field === "shell_deny") {
      return (
        <ListEditor
          title="Shell deny patterns"
          presets={SHELL_DENY_PRESETS}
          current={r.shell.deny}
          onCancel={() => setEditor({ kind: "none" })}
          onSave={(deny) => {
            setDraft(patchRestrictions(draft, { ...r, shell: { mode: "deny_patterns", deny } }));
            setEditor({ kind: "none" });
          }}
        />
      );
    }
    if (editor.field === "read_deny") {
      return (
        <ListEditor
          title="Read deny paths"
          presets={READ_DENY_PRESETS}
          current={r.fs_read.deny}
          onCancel={() => setEditor({ kind: "none" })}
          onSave={(deny) => {
            setDraft(patchRestrictions(draft, { ...r, fs_read: { deny } }));
            setEditor({ kind: "none" });
          }}
        />
      );
    }
    if (editor.field === "redact") {
      return (
        <ListEditor
          title="Redact literals"
          presets={REDACT_LITERAL_PRESETS}
          current={draft.redact?.literals ?? []}
          onCancel={() => setEditor({ kind: "none" })}
          onSave={(literals) => {
            setDraft(applyRedactLiterals(draft, literals));
            setEditor({ kind: "none" });
          }}
        />
      );
    }
  }

  if (editor.kind === "peer_busy") {
    return <Text color={theme.warn}>Renaming to {editor.newName}…</Text>;
  }

  if (editor.kind === "peer_confirm") {
    return (
      <ConfirmModal
        title={`Rename peer to "${editor.newName}"?`}
        body="Mints a one-time invite with your current token, rejoins, updates MCP, restarts daemon if enabled."
        onCancel={() => setEditor({ kind: "text", field: "peer_name" })}
        onConfirm={() => {
          setEditor({ kind: "peer_busy", newName: editor.newName });
          void (async () => {
            try {
              const result = await renamePeer(home, draft, editor.newName);
              setDraft(result.config);
              setBaseline(JSON.stringify(result.config));
              if (restartOnSave && responderDaemonSupported()) {
                try {
                  stopDaemonFn(home);
                  startDaemonFn(home);
                  setMessage(`renamed to ${result.peer}; daemon restarted`);
                } catch (err) {
                  setMessage(
                    `renamed to ${result.peer}; restart failed: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              } else {
                setMessage(`renamed to ${result.peer} (saved)`);
              }
              onSaved?.();
            } catch (err) {
              setMessage(`rename failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            setEditor({ kind: "none" });
          })();
        }}
      />
    );
  }

  if (editor.kind === "text") {
    if (editor.field === "peer_name") {
      return (
        <TextPrompt
          key="peer_name"
          label="New peer name"
          initial={draft.self_peer ?? ""}
          validate={(v) => (NAME_PATTERN.test(v.trim()) ? true : "must match [A-Za-z0-9._-]{1,64}")}
          onCancel={() => setEditor({ kind: "none" })}
          onSubmit={(v) => {
            const name = v.trim();
            if (name === draft.self_peer) {
              setMessage("same name");
              setEditor({ kind: "none" });
              return;
            }
            setEditor({ kind: "peer_confirm", newName: name });
          }}
        />
      );
    }
    if (editor.field === "confirm_days") {
      return (
        <TextPrompt
          label="Ask every N days (0 = never)"
          initial={String(keepAwakeFromConfig(draft).confirm_days)}
          validate={(v) => {
            const n = Number(v);
            return Number.isInteger(n) && n >= 0 ? true : "non-negative integer";
          }}
          onCancel={() => setEditor({ kind: "none" })}
          onSubmit={(v) => {
            setDraft(patchKeepAwake(draft, { confirm_days: Number(v) }));
            setEditor({ kind: "none" });
          }}
        />
      );
    }
    if (editor.field === "confirm_grace") {
      return (
        <TextPrompt
          label="Grace hours before stop"
          initial={String(keepAwakeFromConfig(draft).confirm_grace_hours)}
          validate={(v) => {
            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? true : "positive number";
          }}
          onCancel={() => setEditor({ kind: "none" })}
          onSubmit={(v) => {
            setDraft(patchKeepAwake(draft, { confirm_grace_hours: Number(v) }));
            setEditor({ kind: "none" });
          }}
        />
      );
    }
    if (editor.field === "model_custom") {
      return (
        <TextPrompt
          label="Custom model id"
          initial={draft.responder?.model ?? ""}
          onCancel={() => setEditor({ kind: "none" })}
          onSubmit={(v) => {
            setDraft(applyResponderField(draft, "model", v.trim() || undefined));
            setEditor({ kind: "none" });
          }}
        />
      );
    }
    if (editor.field === "persona_custom") {
      return (
        <TextPrompt
          label="Custom persona"
          initial={draft.responder?.persona ?? ""}
          onCancel={() => setEditor({ kind: "none" })}
          onSubmit={(v) => {
            setDraft(applyResponderField(draft, "persona", v.trim() || undefined));
            setEditor({ kind: "none" });
          }}
        />
      );
    }
  }

  const ka = keepAwakeFromConfig(draft);
  return (
    <Box flexDirection="column">
      <Text color={theme.dim}>
        / {filtering ? filter : "Search settings..."}
        {dirty ? <Text color={theme.warn}> · ● unsaved</Text> : null}
      </Text>
      <Text color={theme.dim}>
        {summarizeRestrictions(restrictionsFromConfig(draft))} · {summarizeKeepAwake(ka)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {visible.map((row, i) => {
          const selected = i === cursor;
          const isSave = row.id === "save";
          if (isSave) {
            return (
              <Box
                key={row.id}
                marginTop={1}
                borderStyle="round"
                borderColor={dirty ? theme.warn : theme.dim}
                paddingX={1}
                justifyContent="space-between"
              >
                <Text
                  bold
                  inverse={selected}
                  color={dirty ? theme.warn : theme.dim}
                  backgroundColor={selected && dirty ? theme.warn : undefined}
                >
                  {selected ? "> " : "  "}
                  {dirty ? "★ SAVE CHANGES" : "★ Save changes (no edits)"}
                </Text>
                <Text color={dirty ? theme.warn : theme.dim} bold={dirty}>
                  Ctrl+S · Enter
                </Text>
              </Box>
            );
          }
          return (
            <Box key={row.id} justifyContent="space-between">
              <Text inverse={selected} color={selected ? theme.highlight : undefined}>
                {selected ? "> " : "  "}
                {row.label}
              </Text>
              <Text
                color={
                  row.value === "true"
                    ? theme.ok
                    : row.value === "false"
                      ? theme.dim
                      : selected
                        ? theme.highlight
                        : undefined
                }
              >
                {row.value}
              </Text>
            </Box>
          );
        })}
      </Box>
      {message ? <Text color={theme.accent}>{message}</Text> : null}
      <FooterHints hints="Type / filter · ↑↓ · Space toggle · Enter edit · Ctrl+S save · Esc discard · Tab switch" />
    </Box>
  );
}
