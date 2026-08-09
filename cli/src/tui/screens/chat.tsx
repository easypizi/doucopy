import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  answerIncomingTicket,
  askPeer,
  cancelIncomingTicket,
  fetchReply,
  type AskMode,
  type IncomingTicket,
} from "../../api.js";
import {
  clampFeedText,
  loadChatHistory,
  saveChatHistory,
  withDialogPreview,
  type AskDelivery,
  type ChatDialog,
  type ChatFeedItem,
} from "../../chat-history.js";
import { localAsk, resolveLocalHarness } from "../../local-ask.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { SelectModal } from "../components/SelectModal.js";
import { TextPrompt } from "../components/TextPrompt.js";
import { DELIVERY_CHIP, deliveryFromPhase, formatDeliveryChip } from "../delivery-chip.js";
import { useHoldKeyCapture } from "../key-capture.js";
import { theme } from "../theme.js";
import type { StatusSnapshot } from "../useStatusSnapshot.js";

const REPLY_WAIT = 20;
const REPLY_MAX = 30;
export const LOCAL_PEER = "(local)";

type FeedItem = ChatFeedItem;
type Dialog = ChatDialog;
type ScreenMode =
  | "feed"
  | "pick_ask"
  | "pick_dialog"
  | "pick_incoming"
  | "incoming_action"
  | "incoming_reply"
  | "incoming_cancel"
  | "quit";

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export type ChatScreenDeps = {
  askPeer?: typeof askPeer;
  fetchReply?: typeof fetchReply;
  localAsk?: typeof localAsk;
  cancelIncomingTicket?: typeof cancelIncomingTicket;
  answerIncomingTicket?: typeof answerIncomingTicket;
  home?: string;
};

export function ChatScreen({
  snap,
  inputActive,
  onBusyChange,
  deps,
  initialAsk,
  home,
}: {
  snap: StatusSnapshot;
  inputActive: boolean;
  onBusyChange?: (busy: boolean) => void;
  deps?: ChatScreenDeps;
  /** Test helper: fire one ask on mount. */
  initialAsk?: { peer: string; question: string };
  home?: string;
}) {
  const askPeerFn = deps?.askPeer ?? askPeer;
  const fetchReplyFn = deps?.fetchReply ?? fetchReply;
  const localAskFn = deps?.localAsk ?? localAsk;
  const cancelIncomingFn = deps?.cancelIncomingTicket ?? cancelIncomingTicket;
  const answerIncomingFn = deps?.answerIncomingTicket ?? answerIncomingTicket;
  const localHome = deps?.home ?? home;
  const initialAskRef = useRef(initialAsk);
  const { exit } = useApp();
  const others = useMemo(() => {
    const list = snap.peers.filter((p) => !p.self);
    return [...list].sort((a, b) => Number(b.online) - Number(a.online));
  }, [snap.peers]);
  const incoming = snap.status?.incoming ?? [];

  const localLabel = useMemo(() => {
    const harness = snap.config?.responder?.harness ?? "cursor-agent";
    return `${LOCAL_PEER} ${harness}`;
  }, [snap.config?.responder?.harness]);

  const welcomeItem: FeedItem = {
    id: "welcome",
    kind: "system",
    text: "Type a question and Enter — pick a peer or local. /ask · /discuss · /incoming · /local · /wipe · /dialogs · PgUp/PgDn to scroll (saved across tabs/restarts).",
  };

  const [feed, setFeed] = useState<FeedItem[]>([welcomeItem]);
  const [dialogs, setDialogs] = useState<Dialog[]>([]);
  const [activeDialogId, setActiveDialogId] = useState<string | null>(null);
  const [filterDialogId, setFilterDialogId] = useState<string | null>(null);
  const [askPeerName, setAskPeerName] = useState<string | null>(null);
  const [askMode, setAskMode] = useState<AskMode>("ask");
  const [mode, setMode] = useState<ScreenMode>("feed");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(0);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [incomingFocus, setIncomingFocus] = useState<IncomingTicket | null>(null);
  const [hydrated, setHydrated] = useState(false);
  /** Items hidden below the viewport (0 = pinned to newest). */
  const [scrollFromBottom, setScrollFromBottom] = useState(0);
  const dialogsRef = useRef(dialogs);
  const activeRef = useRef(activeDialogId);
  const primedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staleClearedRef = useRef<string | null>(null);
  const { rows: termRows } = useWindowSize();
  useHoldKeyCapture(inputActive && mode === "feed");

  useEffect(() => {
    if (!localHome) {
      setHydrated(true);
      return;
    }
    const hist = loadChatHistory(localHome);
    if (hist.feed.length > 0) {
      // Drop in-flight chips from a previous session (poll is gone).
      setFeed(
        hist.feed.map((item) => {
          if (item.kind !== "ask") return item;
          const live =
            item.delivery === "sending" ||
            item.delivery === "queued" ||
            item.delivery === "answering" ||
            item.delivery === "offline";
          if (!live && !item.pending) return item;
          return { ...item, pending: false, delivery: live ? undefined : item.delivery };
        }),
      );
    }
    if (hist.dialogs.length > 0) setDialogs(withDialogPreview(hist.dialogs, hist.feed));
    setActiveDialogId(hist.activeDialogId);
    setFilterDialogId(hist.filterDialogId);
    setAskPeerName(hist.askPeerName);
    if (hist.askPeerName || hist.activeDialogId) primedRef.current = true;
    setHydrated(true);
  }, [localHome]);

  // Drop restored ask targets that are no longer on the relay peer list (rename ghosts).
  useEffect(() => {
    if (!hydrated || !askPeerName) return;
    if (askPeerName === LOCAL_PEER) return;
    // Wait for a live /status snapshot so an empty peers list is authoritative.
    if (!snap.joined || !snap.relayOk) return;
    const known = new Set(others.map((p) => p.name));
    if (known.has(askPeerName)) {
      staleClearedRef.current = null;
      return;
    }
    if (staleClearedRef.current === askPeerName) return;
    staleClearedRef.current = askPeerName;
    const gone = askPeerName;
    setAskPeerName(null);
    setFeed((prev) => [
      ...prev,
      {
        id: newId(),
        kind: "system",
        text: `Previous target ${gone} is not on the network. /ask to pick a peer.`,
      },
    ]);
  }, [hydrated, askPeerName, others, snap.joined, snap.relayOk]);

  useEffect(() => {
    dialogsRef.current = dialogs;
  }, [dialogs]);
  useEffect(() => {
    activeRef.current = activeDialogId;
  }, [activeDialogId]);
  useEffect(() => {
    onBusyChange?.(pending > 0);
  }, [pending, onBusyChange]);

  useEffect(() => {
    if (!localHome || !hydrated) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const withPreview = withDialogPreview(dialogs, feed);
      saveChatHistory(localHome, {
        schema_version: 1,
        dialogs: withPreview,
        feed,
        activeDialogId,
        filterDialogId,
        askPeerName,
        updatedAt: Date.now(),
      });
    }, 300);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [localHome, hydrated, feed, dialogs, activeDialogId, filterDialogId, askPeerName]);

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

  const push = (item: Omit<FeedItem, "id"> & { id?: string }): string => {
    const id = item.id ?? newId();
    const text = clampFeedText(item.text, item.kind);
    setFeed((prev) => [...prev.slice(-80), { ...item, id, text }]);
    return id;
  };

  const patchFeed = (id: string, patch: Partial<FeedItem>) => {
    setFeed((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
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

  const pollTicket = async (
    peer: string,
    dialogId: string,
    ticketId: string,
    askId: string,
    modeForTicket: AskMode = "ask",
  ) => {
    if (!snap.config?.relay_url || !snap.config.token) return;
    setPending((n) => n + 1);
    let lastDelivery: AskDelivery | undefined;
    try {
      for (let i = 0; i < REPLY_MAX; i += 1) {
        const reply = await fetchReplyFn(snap.config.relay_url, snap.config.token, ticketId, REPLY_WAIT);
        if (reply.status === "answered") {
          patchFeed(askId, { delivery: "done", pending: false });
          const prefix = modeForTicket === "discuss" ? "FINAL · " : "";
          push({
            kind: "reply",
            peer,
            dialogId,
            text: `${prefix}${reply.answer ?? ""}`,
          });
          setDialogs((prev) => prev.map((d) => (d.id === dialogId ? { ...d, updatedAt: Date.now() } : d)));
          return;
        }
        if (reply.status === "error") {
          patchFeed(askId, { delivery: "error", pending: false });
          push({ kind: "status", peer, dialogId, text: `error: ${reply.error ?? "?"}` });
          return;
        }
        if (reply.status === "unknown_ticket") {
          patchFeed(askId, { delivery: "error", pending: false });
          push({ kind: "status", peer, dialogId, text: "unknown_ticket (expired or relay restart)" });
          return;
        }
        if (reply.status === "pending") {
          const next = deliveryFromPhase(reply.phase);
          if (next !== lastDelivery) {
            lastDelivery = next;
            patchFeed(askId, { delivery: next, pending: true });
          }
        }
      }
      patchFeed(askId, { delivery: "error", pending: false });
      push({ kind: "status", peer, dialogId, text: `timeout waiting for ${peer} (${ticketId.slice(0, 8)})` });
    } catch (err) {
      patchFeed(askId, { delivery: "error", pending: false });
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

  const sendLocalAsk = async (question: string) => {
    if (!snap.config) {
      push({ kind: "system", text: "No config. Join first (Setup)." });
      return;
    }
    if (!localHome) {
      push({ kind: "system", text: "Local ask unavailable (missing home path)." });
      return;
    }
    const resolved = resolveLocalHarness(snap.config);
    if ("error" in resolved) {
      push({ kind: "system", text: resolved.error });
      return;
    }
    const peer = LOCAL_PEER;
    const current =
      dialogsRef.current.find((d) => d.id === activeRef.current && d.peer === peer) ??
      dialogsRef.current.find((d) => d.peer === peer);
    const { id: dialogId, conversationId: conv } = upsertDialog(peer, current?.conversationId ?? null);
    const askId = push({
      kind: "ask",
      peer,
      dialogId,
      text: question,
      pending: true,
      delivery: "answering",
      mode: "ask",
    });
    setPending((n) => n + 1);
    try {
      const r = await localAskFn({
        home: localHome,
        question,
        conversationId: conv,
        config: snap.config,
      });
      if (r.conversationId) upsertDialog(peer, r.conversationId);
      if (r.error) {
        patchFeed(askId, { delivery: "error", pending: false });
        push({ kind: "status", peer, dialogId, text: `error: ${r.error}` });
        return;
      }
      patchFeed(askId, { delivery: "done", pending: false });
      push({ kind: "reply", peer, dialogId, text: r.answer ?? "" });
    } catch (err) {
      patchFeed(askId, { delivery: "error", pending: false });
      push({
        kind: "status",
        peer,
        dialogId,
        text: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setPending((n) => Math.max(0, n - 1));
    }
  };

  const sendAsk = async (peer: string, question: string, modeOverride?: AskMode) => {
    const modeForTicket = modeOverride ?? askMode;
    if (peer === LOCAL_PEER) {
      await sendLocalAsk(question);
      return;
    }
    if (!snap.config?.relay_url || !snap.config.token) return;
    const current =
      dialogsRef.current.find((d) => d.id === activeRef.current && d.peer === peer) ??
      dialogsRef.current.find((d) => d.peer === peer);
    const { id: dialogId, conversationId: conv } = upsertDialog(peer, current?.conversationId ?? null);

    const askId = push({
      kind: "ask",
      peer,
      dialogId,
      text: question,
      pending: true,
      delivery: "sending",
      mode: modeForTicket,
    });

    try {
      const r = await askPeerFn(snap.config.relay_url, snap.config.token, {
        peer,
        question,
        conversation_id: conv ?? undefined,
        wait_seconds: 0,
        mode: modeForTicket,
      });
      if (r.conversation_id) upsertDialog(peer, r.conversation_id);
      if (r.status === "answered") {
        patchFeed(askId, { delivery: "done", pending: false });
        const prefix = modeForTicket === "discuss" ? "FINAL · " : "";
        push({ kind: "reply", peer, dialogId, text: `${prefix}${r.answer ?? ""}` });
        return;
      }
      if (r.status === "error") {
        patchFeed(askId, { delivery: "error", pending: false });
        push({ kind: "status", peer, dialogId, text: `error: ${r.error ?? "?"}` });
        return;
      }
      const delivery = deliveryFromPhase(r.phase, r.status === "peer_offline");
      patchFeed(askId, { delivery, pending: true });
      void pollTicket(peer, dialogId, r.ticket_id, askId, modeForTicket);
    } catch (err) {
      patchFeed(askId, { delivery: "error", pending: false });
      push({
        kind: "status",
        peer,
        dialogId,
        text: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  useEffect(() => {
    const ask = initialAskRef.current;
    if (!ask) return;
    initialAskRef.current = undefined;
    void sendAsk(ask.peer, ask.question);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on mount for tests
  }, []);

  const openAskPicker = (question?: string, nextMode: AskMode = "ask") => {
    setAskMode(nextMode);
    setPendingQuestion(question ?? null);
    setMode("pick_ask");
  };

  const selectAskTarget = (name: string, question?: string | null, modeForTarget?: AskMode) => {
    const modeNow = modeForTarget ?? askMode;
    setAskMode(modeNow);
    setAskPeerName(name);
    upsertDialog(name, null);
    setPendingQuestion(null);
    setMode("feed");
    if (question) {
      void sendAsk(name, question, modeNow);
    } else {
      const label = modeNow === "discuss" ? "DISCUSS TARGET" : "ASK TARGET";
      push({
        kind: "system",
        peer: name,
        text: `${label} → ${name === LOCAL_PEER ? localLabel : name}. Type the question and press Enter.`,
      });
    }
  };

  const openIncoming = () => {
    if (incoming.length === 0) {
      push({ kind: "system", text: "No open incoming tickets." });
      return;
    }
    setMode("pick_incoming");
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
    if (line === "/wipe") {
      setScrollFromBottom(0);
      setFeed([
        welcomeItem,
        {
          id: newId(),
          kind: "system",
          text: "Cleared chat feed. Threads kept (/dialogs).",
        },
      ]);
      return;
    }
    if (line === "/clear" || line === "/none" || line === "/stop") {
      setAskPeerName(null);
      setFilterDialogId(null);
      setPendingQuestion(null);
      setAskMode("ask");
      primedRef.current = true; // do not auto-stick back to the only peer
      push({
        kind: "system",
        text: "Cleared ask target + feed filter. Type a question (picker) or /ask.",
      });
      return;
    }
    if (line === "/local") {
      setAskMode("ask");
      selectAskTarget(LOCAL_PEER);
      return;
    }
    if (line.startsWith("/local ")) {
      setAskMode("ask");
      const question = line.slice("/local ".length).trim();
      if (question) void sendAsk(LOCAL_PEER, question, "ask");
      else selectAskTarget(LOCAL_PEER);
      return;
    }
    if (line === "/incoming" || line === "/in") {
      openIncoming();
      return;
    }
    if (line === "/ask" || line === "/a") {
      openAskPicker(undefined, "ask");
      return;
    }
    if (line === "/discuss" || line === "/di") {
      openAskPicker(undefined, "discuss");
      return;
    }
    const peerCmd = line.match(/^\/(ask|a|discuss|di)\s+(.+)$/);
    if (peerCmd) {
      const cmd = peerCmd[1]!;
      const nextMode: AskMode = cmd === "discuss" || cmd === "di" ? "discuss" : "ask";
      setAskMode(nextMode);
      const rest = peerCmd[2]!.trim();
      const sp = rest.indexOf(" ");
      const namePart = (sp === -1 ? rest : rest.slice(0, sp)).trim();
      const question = sp === -1 ? "" : rest.slice(sp + 1).trim();
      const matches = others.filter(
        (p) => p.name === namePart || p.name.toLowerCase().startsWith(namePart.toLowerCase()),
      );
      if (matches.length === 1) {
        const name = matches[0]!.name;
        setAskPeerName(name);
        if (question) void sendAsk(name, question, nextMode);
        else {
          upsertDialog(name, null);
          push({
            kind: "system",
            peer: name,
            text: `${nextMode === "discuss" ? "DISCUSS" : "ASK"} TARGET → ${name}. Type the question.`,
          });
        }
        return;
      }
      if (matches.length === 0) {
        push({ kind: "system", text: `No peer matching "${namePart}". Opening picker…` });
        openAskPicker(question || undefined, nextMode);
        return;
      }
      push({ kind: "system", text: `Ambiguous "${namePart}". Pick from the list.` });
      openAskPicker(question || undefined, nextMode);
      return;
    }
    if (line === "/dialogs" || line === "/d" || line === "/threads") {
      if (dialogs.length === 0) {
        push({ kind: "system", text: "No threads yet. Ask someone first." });
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
        text: "Commands: /ask · /discuss · /incoming · /local · /clear · /wipe · /dialogs · /all · /new · /quit",
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

  const visibleFeed = filterDialogId
    ? feed.filter((f) => !f.dialogId || f.dialogId === filterDialogId)
    : feed;
  // Header/tabs/footer live outside Chat; reserve chrome inside the panel.
  const feedBudget = Math.max(4, Math.min(40, (termRows || 24) - 14));
  const maxScroll = Math.max(0, visibleFeed.length - feedBudget);
  const pinnedOffset = Math.min(scrollFromBottom, maxScroll);
  const windowStart = Math.max(0, visibleFeed.length - feedBudget - pinnedOffset);
  const windowEnd = visibleFeed.length - pinnedOffset;
  const windowedFeed = visibleFeed.slice(windowStart, windowEnd);
  const olderCount = windowStart;
  const newerCount = pinnedOffset;

  useInput(
    (input, key) => {
      if (mode !== "feed") return;
      if (key.escape && value === "") {
        if (askPeerName || filterDialogId || askMode === "discuss") {
          setAskPeerName(null);
          setFilterDialogId(null);
          setPendingQuestion(null);
          setAskMode("ask");
          primedRef.current = true;
          push({ kind: "system", text: "Cleared ask target (Esc). /ask to choose again." });
        }
        return;
      }
      const step = Math.max(1, Math.floor(feedBudget / 2));
      if (key.pageUp || (key.ctrl && key.upArrow)) {
        setScrollFromBottom((o) => Math.min(maxScroll, o + step));
        return;
      }
      if (key.pageDown || (key.ctrl && key.downArrow)) {
        setScrollFromBottom((o) => Math.max(0, o - step));
        return;
      }
      if (key.ctrl && input === "a") openAskPicker(undefined, "ask");
      if (key.ctrl && input === "i") openIncoming();
      if (key.ctrl && input === "d") {
        if (dialogs.length > 0) setMode("pick_dialog");
      }
    },
    { isActive: inputActive && mode === "feed" },
  );

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
        title={askMode === "discuss" ? "Discuss with whom?" : "Who should answer?"}
        description={
          pendingQuestion
            ? `Then send: “${pendingQuestion.slice(0, 60)}${pendingQuestion.length > 60 ? "…" : ""}”`
            : askMode === "discuss"
              ? "Multi-turn discuss mode. You see FINAL (+ compact discussing… lines)."
              : "↑↓ choose · Enter. Local = this machine's harness (no relay)."
        }
        options={[
          ...(askMode === "ask" ? [{ value: LOCAL_PEER, label: `◆ ${localLabel}` }] : []),
          ...others.map((p) => ({
            value: p.name,
            label: `${p.online ? "●" : "○"} ${p.name}`,
          })),
        ]}
        onCancel={() => {
          setPendingQuestion(null);
          setAskMode("ask");
          setMode("feed");
        }}
        onSelect={(name) => selectAskTarget(name, pendingQuestion, askMode)}
      />
    );
  }

  if (mode === "pick_incoming") {
    return (
      <SelectModal
        title="Incoming tickets"
        description="Open asks addressed to you. Enter for Reply as me / Cancel."
        options={incoming.map((t) => ({
          value: t.ticket_id,
          label: `${t.from_peer} · ${t.phase} · ${t.mode} · ${t.question_preview.slice(0, 48)}`,
        }))}
        onCancel={() => setMode("feed")}
        onSelect={(ticketId) => {
          const t = incoming.find((x) => x.ticket_id === ticketId) ?? null;
          setIncomingFocus(t);
          setMode("incoming_action");
        }}
      />
    );
  }

  if (mode === "incoming_action" && incomingFocus) {
    const t = incomingFocus;
    return (
      <SelectModal
        title={`${t.from_peer} · ${t.ticket_id.slice(0, 8)}`}
        description={`${t.phase} · ${t.question_preview}`}
        options={[
          { value: "reply", label: "Reply as me" },
          { value: "cancel", label: "Cancel ticket" },
          { value: "back", label: "Back" },
        ]}
        onCancel={() => {
          setIncomingFocus(null);
          setMode("feed");
        }}
        onSelect={(action) => {
          if (action === "reply") setMode("incoming_reply");
          else if (action === "cancel") setMode("incoming_cancel");
          else {
            setIncomingFocus(null);
            setMode("pick_incoming");
          }
        }}
      />
    );
  }

  if (mode === "incoming_reply" && incomingFocus) {
    const t = incomingFocus;
    return (
      <TextPrompt
        label={`Reply as you (to ${t.from_peer}, ticket ${t.ticket_id.slice(0, 8)})`}
        placeholder="Your answer…"
        validate={(v) => (v.trim() ? true : "Answer required")}
        onCancel={() => setMode("incoming_action")}
        onSubmit={(answer) => {
          void (async () => {
            if (!snap.config?.relay_url || !snap.config.token) return;
            try {
              await answerIncomingFn(snap.config.relay_url, snap.config.token, t.ticket_id, answer);
              push({
                kind: "system",
                text: `Answered ${t.from_peer} as you · ${t.ticket_id.slice(0, 8)}`,
              });
            } catch (err) {
              push({
                kind: "system",
                text: `Reply failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            setIncomingFocus(null);
            setMode("feed");
          })();
        }}
      />
    );
  }

  if (mode === "incoming_cancel" && incomingFocus) {
    const t = incomingFocus;
    return (
      <ConfirmModal
        title={`Cancel ticket from ${t.from_peer}? (${t.ticket_id.slice(0, 8)})`}
        onCancel={() => setMode("incoming_action")}
        onConfirm={() => {
          void (async () => {
            if (!snap.config?.relay_url || !snap.config.token) return;
            try {
              await cancelIncomingFn(snap.config.relay_url, snap.config.token, t.ticket_id);
              push({
                kind: "system",
                text: `Cancelled incoming from ${t.from_peer} · ${t.ticket_id.slice(0, 8)}`,
              });
            } catch (err) {
              push({
                kind: "system",
                text: `Cancel failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            setIncomingFocus(null);
            setMode("feed");
          })();
        }}
      />
    );
  }

  if (mode === "pick_dialog") {
    const sorted = withDialogPreview(dialogs, feed).sort((a, b) => b.updatedAt - a.updatedAt);
    return (
      <SelectModal
        title="Threads"
        description="Jump to a saved thread (history persists across tabs and restarts)."
        options={[
          { value: "__all__", label: "● All peers (full feed)" },
          ...sorted.map((d) => {
            const idSlice = d.conversationId ? d.conversationId.slice(0, 8) : "new";
            const preview = d.lastPreview ? ` · ${d.lastPreview}` : "";
            return {
              value: d.id,
              label: `${d.peer}  ${idSlice}${preview}`,
            };
          }),
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
              text: `Focused thread: ${d?.label ?? id}`,
            });
          }
          setMode("feed");
        }}
      />
    );
  }

  const target = askPeerName ?? dialogs.find((d) => d.id === (filterDialogId ?? activeDialogId))?.peer;
  const targetLabel = target === LOCAL_PEER ? localLabel : target;

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
              <Text color={theme.dim}> · next {askMode === "discuss" ? "discuss" : "ask"} → </Text>
              <Text color={theme.highlight} bold>
                {targetLabel}
              </Text>
              <Text color={theme.dim}> (Esc or /clear to leave)</Text>
            </>
          ) : (
            <Text color={theme.dim}> · no ask target</Text>
          )}
          {incoming.length > 0 ? (
            <>
              <Text color={theme.dim}> · </Text>
              <Text color={theme.warn}>{incoming.length} incoming</Text>
            </>
          ) : null}
        </Text>
        <Text color={theme.dim}>
          {dialogs.length} threads · Ctrl+D · Ctrl+I
          {pending > 0 ? ` · ${pending} pending` : ""}
          {olderCount > 0 || newerCount > 0
            ? ` · PgUp/PgDn${olderCount > 0 ? ` · ↑${olderCount}` : ""}${newerCount > 0 ? ` · ↓${newerCount}` : ""}`
            : ""}
        </Text>
      </Box>

      <Box
        flexDirection="column"
        height={feedBudget}
        overflowY="hidden"
        marginBottom={1}
      >
        {windowedFeed.map((item) => (
          <FeedLine key={item.id} item={item} />
        ))}
      </Box>

      <Box flexShrink={0}>
        <Text color={theme.accent} bold>
          {target ? `/${askMode === "discuss" ? "discuss" : "ask"} ${target}> ` : "> "}
        </Text>
        {inputActive ? (
          <TextInput
            value={value}
            placeholder={
              target
                ? askMode === "discuss"
                  ? `Discuss with ${targetLabel}… (Enter sends)`
                  : `Question for ${targetLabel}… (Enter sends)`
                : "Type a question · Enter · pick peer from list"
            }
            onChange={setValue}
            onSubmit={handleLine}
          />
        ) : (
          <Text color={theme.dim}>{value}</Text>
        )}
      </Box>
      <Box marginTop={1} flexShrink={0}>
        <Text color={theme.dim}>
          Enter send · /ask · /discuss · /incoming · /local · /wipe · /dialogs · PgUp/PgDn
          {pending > 0 ? ` · ${pending} in flight` : ""}
        </Text>
      </Box>
    </Box>
  );
}

function FeedLine({ item }: { item: FeedItem }) {
  if (item.kind === "ask") {
    const delivery = item.delivery;
    const chip = delivery ? DELIVERY_CHIP[delivery] : null;
    const badge = item.mode === "discuss" ? "DISCUSS" : "ASK";
    return (
      <Box>
        <Text backgroundColor="cyan" color="black" bold>
          {" "}
          {badge}{" "}
        </Text>
        <Text color={theme.accent} bold>
          {" "}
          → {item.peer}{" "}
        </Text>
        {chip ? (
          <Text color={chip.color} bold={delivery === "answering" || delivery === "offline"}>
            {formatDeliveryChip(delivery!)}{" "}
          </Text>
        ) : null}
        <Text color={theme.highlight}>{item.text}</Text>
      </Box>
    );
  }
  if (item.kind === "reply") {
    const isFinal = item.text.startsWith("FINAL · ");
    return (
      <Box>
        <Text backgroundColor="green" color="black" bold>
          {" "}
          {isFinal ? "FINAL" : "REPLY"}{" "}
        </Text>
        <Text color={theme.ok} bold>
          {" "}
          ← {item.peer}{" "}
        </Text>
        <Text>{isFinal ? item.text.slice("FINAL · ".length) : item.text}</Text>
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
      <Text color={theme.dim}>
        · {item.peer ? `${item.peer}: ` : ""}
        {item.text}
      </Text>
    );
  }
  return <Text color={theme.dim}>{item.text}</Text>;
}
