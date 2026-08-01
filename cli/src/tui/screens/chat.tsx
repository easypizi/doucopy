import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useMemo, useRef, useState } from "react";
import { askPeer, fetchReply } from "../../api.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { SelectModal } from "../components/SelectModal.js";
import { theme } from "../theme.js";
import type { StatusSnapshot } from "../useStatusSnapshot.js";

const REPLY_WAIT = 20;
const REPLY_MAX = 30;

type FeedKind = "system" | "ask" | "reply" | "note" | "status";

interface FeedItem {
  id: string;
  kind: FeedKind;
  peer?: string;
  dialogId?: string;
  text: string;
  pending?: boolean;
}

interface Dialog {
  id: string;
  peer: string;
  conversationId: string | null;
  label: string;
  updatedAt: number;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function ChatScreen({
  snap,
  inputActive,
  onBusyChange,
}: {
  snap: StatusSnapshot;
  inputActive: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { exit } = useApp();
  const others = useMemo(() => {
    const list = snap.peers.filter((p) => !p.self);
    return [...list].sort((a, b) => Number(b.online) - Number(a.online));
  }, [snap.peers]);

  const [feed, setFeed] = useState<FeedItem[]>([
    {
      id: "welcome",
      kind: "system",
      text: "Type a question and press Enter — pick a peer from the list (no need to type their name). /ask opens the picker. /dialogs jumps threads.",
    },
  ]);
  const [dialogs, setDialogs] = useState<Dialog[]>([]);
  const [activeDialogId, setActiveDialogId] = useState<string | null>(null);
  const [filterDialogId, setFilterDialogId] = useState<string | null>(null);
  const [askPeerName, setAskPeerName] = useState<string | null>(null);
  const [mode, setMode] = useState<"feed" | "pick_ask" | "pick_dialog" | "quit">("feed");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(0);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const dialogsRef = useRef(dialogs);
  const activeRef = useRef(activeDialogId);
  const primedRef = useRef(false);

  useEffect(() => {
    dialogsRef.current = dialogs;
  }, [dialogs]);
  useEffect(() => {
    activeRef.current = activeDialogId;
  }, [activeDialogId]);
  useEffect(() => {
    onBusyChange?.(pending > 0);
  }, [pending, onBusyChange]);

  // One peer → auto-target them so plain questions go out without /ask.
  useEffect(() => {
    if (primedRef.current || askPeerName || others.length !== 1) return;
    primedRef.current = true;
    const name = others[0]!.name;
    setAskPeerName(name);
    upsertDialog(name, null);
    push({
      kind: "system",
      peer: name,
      text: `Auto-selected only peer: ${name}. Just type a question and Enter.`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prime once when peers appear
  }, [others, askPeerName]);

  const push = (item: Omit<FeedItem, "id"> & { id?: string }) => {
    setFeed((prev) => [...prev.slice(-80), { ...item, id: item.id ?? newId() }]);
  };

  const upsertDialog = (peer: string, conversationId: string | null): { id: string; conversationId: string | null } => {
    const existing =
      (conversationId
        ? dialogsRef.current.find((d) => d.peer === peer && d.conversationId === conversationId)
        : null) ??
      (activeRef.current
        ? dialogsRef.current.find((d) => d.id === activeRef.current && d.peer === peer)
        : null) ??
      dialogsRef.current.find((d) => d.peer === peer && d.conversationId === null);

    if (existing) {
      const id = existing.id;
      const nextConv = conversationId ?? existing.conversationId;
      const updated: Dialog = {
        ...existing,
        conversationId: nextConv,
        updatedAt: Date.now(),
        label: `${peer}${nextConv ? ` · ${nextConv.slice(0, 8)}` : " · new"}`,
      };
      setDialogs((prev) => prev.map((d) => (d.id === id ? updated : d)));
      dialogsRef.current = dialogsRef.current.map((d) => (d.id === id ? updated : d));
      setActiveDialogId(id);
      activeRef.current = id;
      return { id, conversationId: nextConv };
    }
    const id = newId();
    const dialog: Dialog = {
      id,
      peer,
      conversationId,
      label: `${peer}${conversationId ? ` · ${conversationId.slice(0, 8)}` : " · new"}`,
      updatedAt: Date.now(),
    };
    setDialogs((prev) => [dialog, ...prev].slice(0, 40));
    dialogsRef.current = [dialog, ...dialogsRef.current].slice(0, 40);
    setActiveDialogId(id);
    activeRef.current = id;
    return { id, conversationId };
  };

  const pollTicket = async (peer: string, dialogId: string, ticketId: string) => {
    if (!snap.config?.relay_url || !snap.config.token) return;
    setPending((n) => n + 1);
    try {
      for (let i = 0; i < REPLY_MAX; i += 1) {
        const reply = await fetchReply(snap.config.relay_url, snap.config.token, ticketId, REPLY_WAIT);
        if (reply.status === "answered") {
          push({
            kind: "reply",
            peer,
            dialogId,
            text: reply.answer ?? "",
          });
          setDialogs((prev) => prev.map((d) => (d.id === dialogId ? { ...d, updatedAt: Date.now() } : d)));
          return;
        }
        if (reply.status === "error") {
          push({ kind: "status", peer, dialogId, text: `error: ${reply.error ?? "?"}` });
          return;
        }
        if (reply.status === "unknown_ticket") {
          push({ kind: "status", peer, dialogId, text: "unknown_ticket (expired or relay restart)" });
          return;
        }
      }
      push({ kind: "status", peer, dialogId, text: `timeout waiting for ${peer} (${ticketId.slice(0, 8)})` });
    } catch (err) {
      push({
        kind: "status",
        peer,
        dialogId,
        text: `poll error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setPending((n) => Math.max(0, n - 1));
    }
  };

  const sendAsk = async (peer: string, question: string) => {
    if (!snap.config?.relay_url || !snap.config.token) return;
    const current =
      dialogsRef.current.find((d) => d.id === activeRef.current && d.peer === peer) ??
      dialogsRef.current.find((d) => d.peer === peer);
    const { id: dialogId, conversationId: conv } = upsertDialog(peer, current?.conversationId ?? null);

    push({
      kind: "ask",
      peer,
      dialogId,
      text: question,
      pending: true,
    });

    try {
      const r = await askPeer(snap.config.relay_url, snap.config.token, {
        peer,
        question,
        conversation_id: conv ?? undefined,
        wait_seconds: 0,
      });
      if (r.conversation_id) upsertDialog(peer, r.conversation_id);
      if (r.status === "answered") {
        push({ kind: "reply", peer, dialogId, text: r.answer ?? "" });
        return;
      }
      if (r.status === "error") {
        push({ kind: "status", peer, dialogId, text: `error: ${r.error ?? "?"}` });
        return;
      }
      push({
        kind: "status",
        peer,
        dialogId,
        text:
          r.status === "peer_offline"
            ? `queued offline · ticket ${r.ticket_id.slice(0, 8)}`
            : `sent · waiting · ticket ${r.ticket_id.slice(0, 8)}`,
      });
      void pollTicket(peer, dialogId, r.ticket_id);
    } catch (err) {
      push({
        kind: "status",
        peer,
        dialogId,
        text: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const openAskPicker = (question?: string) => {
    if (others.length === 0) {
      push({ kind: "system", text: "No peers online/known yet. Wait for status or check Setup." });
      return;
    }
    if (others.length === 1) {
      const name = others[0]!.name;
      setAskPeerName(name);
      upsertDialog(name, null);
      if (question) {
        void sendAsk(name, question);
      } else {
        push({
          kind: "system",
          peer: name,
          text: `ASK TARGET → ${name}. Type the question and press Enter.`,
        });
      }
      return;
    }
    setPendingQuestion(question ?? null);
    setMode("pick_ask");
  };

  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    setValue("");

    if (line === "/quit" || line === "/exit") {
      if (pending > 0) setMode("quit");
      else exit();
      return;
    }
    if (line === "/clear" || line === "/none" || line === "/stop") {
      setAskPeerName(null);
      setFilterDialogId(null);
      setPendingQuestion(null);
      primedRef.current = true; // do not auto-stick back to the only peer
      push({
        kind: "system",
        text: "Cleared ask target + feed filter. Type a question (picker) or /ask.",
      });
      return;
    }
    if (line === "/ask" || line === "/a") {
      openAskPicker();
      return;
    }
    if (line.startsWith("/ask ") || line.startsWith("/a ")) {
      const rest = line.replace(/^\/(ask|a)\s+/, "").trim();
      // Match peer by exact name, or unique prefix (so you don't type the full name).
      const sp = rest.indexOf(" ");
      const namePart = (sp === -1 ? rest : rest.slice(0, sp)).trim();
      const question = sp === -1 ? "" : rest.slice(sp + 1).trim();
      const matches = others.filter(
        (p) => p.name === namePart || p.name.toLowerCase().startsWith(namePart.toLowerCase()),
      );
      if (matches.length === 1) {
        const name = matches[0]!.name;
        setAskPeerName(name);
        if (question) void sendAsk(name, question);
        else {
          upsertDialog(name, null);
          push({ kind: "system", peer: name, text: `ASK TARGET → ${name}. Type the question.` });
        }
        return;
      }
      if (matches.length === 0) {
        push({ kind: "system", text: `No peer matching "${namePart}". Opening picker…` });
        openAskPicker(question || undefined);
        return;
      }
      push({ kind: "system", text: `Ambiguous "${namePart}". Pick from the list.` });
      openAskPicker(question || undefined);
      return;
    }
    if (line === "/dialogs" || line === "/d") {
      if (dialogs.length === 0) {
        push({ kind: "system", text: "No dialogs yet. Ask someone first." });
        return;
      }
      setMode("pick_dialog");
      return;
    }
    if (line === "/all") {
      setFilterDialogId(null);
      push({ kind: "system", text: "Showing full feed (all peers)." });
      return;
    }
    if (line === "/new") {
      if (!askPeerName && !activeDialogId) {
        openAskPicker();
        return;
      }
      const peer = askPeerName ?? dialogs.find((d) => d.id === activeDialogId)?.peer;
      if (!peer) return;
      const id = newId();
      const dialog = { id, peer, conversationId: null, label: `${peer} · new`, updatedAt: Date.now() };
      setDialogs((prev) => [dialog, ...prev]);
      dialogsRef.current = [dialog, ...dialogsRef.current];
      setActiveDialogId(id);
      activeRef.current = id;
      setAskPeerName(peer);
      push({ kind: "system", peer, dialogId: id, text: `New thread with ${peer}.` });
      return;
    }
    if (line.startsWith("/")) {
      push({
        kind: "system",
        text: "Commands: /ask · /clear · /dialogs · /all · /new · /quit",
      });
      return;
    }

    // Plain question → send to current target, or open peer picker (list, not typing names).
    if (askPeerName) {
      void sendAsk(askPeerName, line);
      return;
    }
    const focused = dialogs.find((d) => d.id === (filterDialogId ?? activeDialogId));
    if (focused) {
      void sendAsk(focused.peer, line);
      return;
    }
    openAskPicker(line);
  };

  useInput(
    (input, key) => {
      if (mode !== "feed") return;
      if (key.escape && value === "") {
        if (askPeerName || filterDialogId) {
          setAskPeerName(null);
          setFilterDialogId(null);
          setPendingQuestion(null);
          primedRef.current = true;
          push({ kind: "system", text: "Cleared ask target (Esc). /ask to choose again." });
        }
        return;
      }
      if (key.ctrl && input === "a") openAskPicker();
      if (key.ctrl && input === "d") {
        if (dialogs.length > 0) setMode("pick_dialog");
      }
    },
    { isActive: inputActive && mode === "feed" },
  );

  const visibleFeed = filterDialogId ? feed.filter((f) => !f.dialogId || f.dialogId === filterDialogId) : feed;

  if (!snap.joined) {
    return (
      <Box padding={1}>
        <Text color={theme.warn}>Join first to chat.</Text>
      </Box>
    );
  }

  if (mode === "quit") {
    return (
      <ConfirmModal
        title={`${pending} reply(ies) still pending. Quit anyway?`}
        onCancel={() => setMode("feed")}
        onConfirm={() => exit()}
      />
    );
  }

  if (mode === "pick_ask") {
    return (
      <SelectModal
        title="Who should answer?"
        description={
          pendingQuestion
            ? `Then send: “${pendingQuestion.slice(0, 60)}${pendingQuestion.length > 60 ? "…" : ""}”`
            : "↑↓ choose peer · Enter. You never need to type their full name."
        }
        options={others.map((p) => ({
          value: p.name,
          label: `${p.online ? "●" : "○"} ${p.name}`,
        }))}
        onCancel={() => {
          setPendingQuestion(null);
          setMode("feed");
        }}
        onSelect={(name) => {
          setAskPeerName(name);
          upsertDialog(name, null);
          const question = pendingQuestion;
          setPendingQuestion(null);
          setMode("feed");
          if (question) {
            void sendAsk(name, question);
          } else {
            push({
              kind: "system",
              peer: name,
              text: `ASK TARGET → ${name}. Type the question and press Enter.`,
            });
          }
        }}
      />
    );
  }

  if (mode === "pick_dialog") {
    const sorted = [...dialogs].sort((a, b) => b.updatedAt - a.updatedAt);
    return (
      <SelectModal
        title="Jump to dialog"
        description="Filter the feed to one thread, or pick All at the top."
        options={[
          { value: "__all__", label: "● All peers (full feed)" },
          ...sorted.map((d) => ({
            value: d.id,
            label: `${d.peer}  ${d.conversationId ? d.conversationId.slice(0, 8) : "new"}`,
          })),
        ]}
        onCancel={() => setMode("feed")}
        onSelect={(id) => {
          if (id === "__all__") {
            setFilterDialogId(null);
            push({ kind: "system", text: "Showing full feed." });
          } else {
            const d = dialogs.find((x) => x.id === id);
            setFilterDialogId(id);
            setActiveDialogId(id);
            activeRef.current = id;
            if (d) setAskPeerName(d.peer);
            push({
              kind: "system",
              dialogId: id,
              peer: d?.peer,
              text: `Focused dialog: ${d?.label ?? id}`,
            });
          }
          setMode("feed");
        }}
      />
    );
  }

  const target = askPeerName ?? dialogs.find((d) => d.id === (filterDialogId ?? activeDialogId))?.peer;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box
        borderStyle="single"
        borderColor={theme.accent}
        paddingX={1}
        marginBottom={1}
        justifyContent="space-between"
      >
        <Text>
          <Text color={theme.dim}>feed </Text>
          {filterDialogId ? (
            <Text color={theme.warn}>filtered</Text>
          ) : (
            <Text color={theme.ok}>all peers</Text>
          )}
          {target ? (
            <>
              <Text color={theme.dim}> · next ask → </Text>
              <Text color={theme.highlight} bold>
                {target}
              </Text>
              <Text color={theme.dim}> (Esc or /clear to leave)</Text>
            </>
          ) : (
            <Text color={theme.dim}> · no ask target</Text>
          )}
        </Text>
        <Text color={theme.dim}>
          {dialogs.length} dialogs
          {pending > 0 ? ` · ${pending} pending` : ""}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} marginBottom={1}>
        {visibleFeed.map((item) => (
          <FeedLine key={item.id} item={item} />
        ))}
      </Box>

      <Box>
        <Text color={theme.accent} bold>
          {target ? `/ask ${target}> ` : "> "}
        </Text>
        {inputActive ? (
          <TextInput
            value={value}
            placeholder={
              target
                ? `Question for ${target}… (Enter sends)`
                : "Type a question · Enter · pick peer from list"
            }
            onChange={setValue}
            onSubmit={handleLine}
          />
        ) : (
          <Text color={theme.dim}>{value}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          Enter send · Esc//clear leave ask · /ask · /dialogs · /quit
          {pending > 0 ? ` · ${pending} in flight` : ""}
        </Text>
      </Box>
    </Box>
  );
}

function FeedLine({ item }: { item: FeedItem }) {
  if (item.kind === "ask") {
    return (
      <Box>
        <Text backgroundColor="cyan" color="black" bold>
          {" "}
          ASK{" "}
        </Text>
        <Text color={theme.accent} bold>
          {" "}
          → {item.peer}{" "}
        </Text>
        <Text color={theme.highlight}>{item.text}</Text>
      </Box>
    );
  }
  if (item.kind === "reply") {
    return (
      <Box>
        <Text backgroundColor="green" color="black" bold>
          {" "}
          REPLY{" "}
        </Text>
        <Text color={theme.ok} bold>
          {" "}
          ← {item.peer}{" "}
        </Text>
        <Text>{item.text}</Text>
      </Box>
    );
  }
  if (item.kind === "note") {
    return (
      <Text color={theme.dim}>
        note · {item.text}
      </Text>
    );
  }
  if (item.kind === "status") {
    return (
      <Text color={theme.warn}>
        · {item.peer ? `${item.peer}: ` : ""}
        {item.text}
      </Text>
    );
  }
  return <Text color={theme.dim}>{item.text}</Text>;
}
