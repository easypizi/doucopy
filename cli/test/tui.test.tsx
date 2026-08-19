import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { asciiFold } from "../src/ascii-output.js";
import { CHIP_LEGEND } from "../src/tui/delivery-chip.js";
import { Header, incomingValueColor } from "../src/tui/header.js";
import { theme } from "../src/tui/theme.js";
import { App } from "../src/tui/app.js";
import { SettingsScreen } from "../src/tui/screens/settings.js";
import { StatusScreen } from "../src/tui/screens/status.js";
import { TabBar } from "../src/tui/components/TabBar.js";
import { WizardFrame } from "../src/tui/components/WizardFrame.js";
import { keepAwakeFromConfig, type DoucopyConfigFile } from "../src/settings.js";
import type { StatusSnapshot } from "../src/tui/useStatusSnapshot.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function emptySnap(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    loading: false,
    config: null,
    joined: false,
    daemonRunning: false,
    keepAwake: keepAwakeFromConfig({}),
    relayHost: "(none)",
    relayOk: false,
    relayError: null,
    status: null,
    peers: [],
    paused: [],
    onlineCount: 0,
    peerCount: 0,
    ...over,
  };
}

/** Joined snapshot with one ticket per chip state. ASCII-only payload on purpose. */
function busySnap(): StatusSnapshot {
  return emptySnap({
    joined: true,
    relayOk: true,
    relayHost: "r.example.com",
    daemonRunning: true,
    config: {
      self_peer: "Ivan",
      relay_url: "https://r.example.com",
      token: "tok",
      responder: { model: "composer-2.5", harness: "cursor-agent" },
    },
    peers: [
      { name: "Ivan", online: true, self: true },
      { name: "work", online: true, self: false },
    ],
    onlineCount: 2,
    peerCount: 2,
    status: {
      self: "Ivan",
      self_online: true,
      peers: [{ name: "work", online: true }],
      incoming_queued: 2,
      incoming: [
        {
          ticket_id: "in-working-1",
          from_peer: "work",
          conversation_id: "conv-1",
          created_at: 1,
          phase: "working",
          mode: "ask",
          question_preview: "what shipped last week",
        },
        {
          ticket_id: "in-queued-1",
          from_peer: "work",
          conversation_id: "conv-2",
          created_at: 2,
          phase: "queued",
          mode: "discuss",
          question_preview: "lets compare two options",
        },
      ],
      outgoing: [
        { ticket_id: "out-working-1", to_peer: "work", status: "pending", phase: "working", created_at: 3 },
        { ticket_id: "out-queued-1", to_peer: "work", status: "pending", phase: "queued", created_at: 4 },
        { ticket_id: "out-done-1", to_peer: "work", status: "answered", created_at: 5 },
        { ticket_id: "out-error-1", to_peer: "work", status: "error", created_at: 6 },
        { ticket_id: "out-odd-1", to_peer: "work", status: "pending", created_at: 7 },
      ],
    },
  });
}

function writeConfigHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "doucopy-tui-"));
  mkdirSync(path.join(home, ".doucopy"), { recursive: true });
  const config: DoucopyConfigFile = {
    relay_url: "https://relay.example.com",
    self_peer: "test-peer",
    token: "tok",
    responder: { harness: "cursor-agent", model: "composer-2.5" },
    keep_awake: { enabled: true, confirm_days: 3, confirm_grace_hours: 24 },
    restrictions: {
      fs_write: { mode: "workspace_only", allow: [] },
      fs_read: { deny: [] },
      shell: { mode: "off", deny: [] },
    },
  };
  writeFileSync(path.join(home, ".doucopy", "config.json"), JSON.stringify(config, null, 2));
  return home;
}

describe("incomingValueColor", () => {
  it("scales green then yellow then red", () => {
    expect(incomingValueColor(0)).toBe(theme.dim);
    expect(incomingValueColor(1)).toMatch(/^#[0-9a-f]{6}$/);
    expect(incomingValueColor(10)).toMatch(/^#[0-9a-f]{6}$/);
    expect(incomingValueColor(1) < incomingValueColor(10) || incomingValueColor(1) !== incomingValueColor(10)).toBe(true);
    expect(incomingValueColor(15)).toMatch(/^#[0-9a-f]{6}$/);
    expect(incomingValueColor(30)).toBe(theme.err);
    expect(incomingValueColor(99)).toBe(theme.err);
  });
});

describe("TUI chrome", () => {
  it("renders tab labels", () => {
    const { lastFrame, unmount } = render(<TabBar active="settings" />);
    cleanups.push(unmount);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Status");
    expect(frame).toContain("Settings");
    expect(frame).toContain("Peers");
    expect(frame).toContain("Chat");
    expect(frame).toContain("Setup");
    expect(frame).toContain("Ops");
    expect(frame).toContain("Updates");
  });

  it("header shows not joined state", () => {
    const { lastFrame, unmount } = render(<Header snap={emptySnap()} />);
    cleanups.push(unmount);
    expect(lastFrame()).toContain("not joined");
    expect(lastFrame()).toContain("doucopy v");
  });

  it("header shows peer model and keep-awake when joined", () => {
    const snap = emptySnap({
      joined: true,
      config: {
        self_peer: "Ivan",
        relay_url: "https://r.example.com",
        responder: { model: "composer-2.5", harness: "cursor-agent" },
        keep_awake: { enabled: true },
      },
      keepAwake: { enabled: true, confirm_days: 3, confirm_grace_hours: 24 },
      daemonRunning: true,
      onlineCount: 1,
      peerCount: 2,
      relayHost: "r.example.com",
      relayOk: true,
    });
    const { lastFrame, unmount } = render(<Header snap={snap} />);
    cleanups.push(unmount);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ivan");
    expect(frame).toContain("composer-2.5");
    expect(frame).toContain("keep-awake");
  });

  it("status prompts setup when not joined", () => {
    const { lastFrame, unmount } = render(
      <StatusScreen snap={emptySnap()} onRefresh={() => undefined} onOpenPeers={() => undefined} inputActive={false} />,
    );
    cleanups.push(unmount);
    expect(lastFrame()).toContain("No config yet");
  });

  it("status renders glyph chips with a legend and folds fully to ASCII", () => {
    const { lastFrame, unmount } = render(
      <StatusScreen
        snap={busySnap()}
        onRefresh={() => undefined}
        onOpenPeers={() => undefined}
        inputActive={false}
      />,
    );
    cleanups.push(unmount);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("You can close this TUI anytime");
    expect(frame).toContain(CHIP_LEGEND);
    // Ticket rows are glyph-only: one chip per state, no status words.
    const row = (needle: string) => frame.split("\n").find((line) => line.includes(needle)) ?? "";
    expect(row("what shipped")).toMatch(/●/);
    expect(row("lets compare")).toMatch(/○/);
    expect(row("out-work")).toMatch(/●/);
    expect(row("out-queu")).toMatch(/○/);
    expect(row("out-done")).toMatch(/✓/);
    expect(row("out-erro")).toMatch(/×/);
    expect(row("out-done")).not.toMatch(/answered/);
    expect(row("out-erro")).not.toMatch(/error/);
    // Pending without a phase used to leak the raw word.
    expect(row("out-odd-")).toMatch(/○/);
    expect(row("out-odd-")).not.toMatch(/pending/);
    // Every glyph the screen emits must be covered by the ASCII fold table.
    expect(asciiFold(frame)).not.toMatch(/[^\x00-\x7F]/);
  });

  it("wizard frame shows step progress", () => {
    const { lastFrame, unmount } = render(
      <WizardFrame title="Join" step={2} total={5}>
        <></>
      </WizardFrame>,
    );
    cleanups.push(unmount);
    expect(lastFrame()).toContain("(2/5)");
  });
});

describe("Settings screen", () => {
  const noopDaemon = {
    startDaemon: () => undefined,
    stopDaemon: () => undefined,
  };

  it("lists keep awake and supports Esc discard confirm", async () => {
    const home = writeConfigHome();
    const { lastFrame, stdin, unmount } = render(
      <SettingsScreen home={home} inputActive deps={noopDaemon} />,
    );
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 50));
    let frame = lastFrame() ?? "";
    expect(frame).toContain("Keep awake");
    expect(frame).toContain("true");

    // Rows: peer_name (0) … harness (8), then keep_awake (9)
    for (let i = 0; i < 9; i += 1) {
      stdin.write("\u001B[B");
      await new Promise((r) => setTimeout(r, 20));
    }
    stdin.write(" ");
    await new Promise((r) => setTimeout(r, 80));
    frame = lastFrame() ?? "";
    expect(frame).toMatch(/unsaved|Keep awake\s+false/);

    stdin.write("\u001B"); // Esc → discard confirm
    await new Promise((r) => setTimeout(r, 80));
    frame = lastFrame() ?? "";
    expect(frame).toContain("Discard");
  });

  it("clears dirty after save so Esc does not discard", async () => {
    const home = writeConfigHome();
    const { lastFrame, stdin, unmount } = render(
      <SettingsScreen home={home} inputActive deps={noopDaemon} />,
    );
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 9; i += 1) {
      stdin.write("\u001B[B");
      await new Promise((r) => setTimeout(r, 15));
    }
    stdin.write(" ");
    await new Promise((r) => setTimeout(r, 60));
    expect(lastFrame()).toMatch(/unsaved/);

    stdin.write("\x13"); // Ctrl+S
    await new Promise((r) => setTimeout(r, 120));
    let frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/● unsaved/);

    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 80));
    frame = lastFrame() ?? "";
    expect(frame).not.toContain("Discard");
  });
});

describe("TextPrompt mask", () => {
  it("does not render secret plaintext when mask is on", async () => {
    const { TextPrompt } = await import("../src/tui/components/TextPrompt.js");
    const { lastFrame, stdin, unmount } = render(
      <TextPrompt label="RELAY_SECRET" mask onSubmit={() => undefined} onCancel={() => undefined} />,
    );
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("supersecret-value");
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("RELAY_SECRET");
    expect(frame).not.toContain("supersecret-value");
    expect(frame).toMatch(/\*+/);
  });
});

describe("Chat pending poll", () => {
  it("shows reply after pending then answered", async () => {
    const { ChatScreen } = await import("../src/tui/screens/chat.js");
    let polls = 0;
    const snap = emptySnap({
      joined: true,
      config: {
        self_peer: "Ivan",
        relay_url: "https://r.example.com",
        token: "tok",
        responder: { model: "composer-2.5", harness: "cursor-agent" },
      },
      peers: [
        { name: "Ivan", online: true, self: true },
        { name: "work", online: true, self: false },
      ],
    });
    const { lastFrame, unmount } = render(
      <ChatScreen
        snap={snap}
        inputActive
        initialAsk={{ peer: "work", question: "ping please" }}
        deps={{
          askPeer: async () => ({
            status: "pending",
            ticket_id: "ticket-pending-1",
            conversation_id: "conv-1",
            phase: "queued",
          }),
          fetchReply: async () => {
            polls += 1;
            if (polls === 1) {
              return { status: "pending", ticket_id: "ticket-pending-1", phase: "queued" };
            }
            if (polls === 2) {
              return { status: "pending", ticket_id: "ticket-pending-1", phase: "working" };
            }
            return {
              status: "answered",
              ticket_id: "ticket-pending-1",
              answer: "PONG-from-work",
            };
          },
        }}
      />,
    );
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 600));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("PONG-from-work");
    expect(frame).toMatch(/✓/);
    expect(frame).toContain(CHIP_LEGEND);
    expect(asciiFold(frame)).not.toMatch(/[^\x00-\x7F]/);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("shows answering chip while peer phase is working", async () => {
    const { ChatScreen } = await import("../src/tui/screens/chat.js");
    const snap = emptySnap({
      joined: true,
      config: {
        self_peer: "Ivan",
        relay_url: "https://r.example.com",
        token: "tok",
        responder: { model: "composer-2.5", harness: "cursor-agent" },
      },
      peers: [
        { name: "Ivan", online: true, self: true },
        { name: "work", online: true, self: false },
      ],
    });
    let resolveReply: ((v: { status: string; ticket_id: string; phase?: string; answer?: string }) => void) | null =
      null;
    const { lastFrame, unmount } = render(
      <ChatScreen
        snap={snap}
        inputActive
        initialAsk={{ peer: "work", question: "slow question" }}
        deps={{
          askPeer: async () => ({
            status: "pending",
            ticket_id: "ticket-slow-1",
            conversation_id: "conv-slow",
            phase: "working",
          }),
          fetchReply: () =>
            new Promise((resolve) => {
              resolveReply = resolve;
            }),
        }}
      />,
    );
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 200));
    // Scope the assertion to the ask row so peer-list glyphs cannot satisfy it.
    const askRow = (frame: string) => frame.split("\n").find((line) => line.includes("slow question")) ?? "";
    expect(askRow(lastFrame() ?? "")).toMatch(/[●◐○◑]/);
    await new Promise((r) => setTimeout(r, 1100));
    const liveRow = askRow(lastFrame() ?? "");
    expect(liveRow).toMatch(/[●◐○◑] \d+s/);
    // Live chip is glyph plus elapsed only, no word labels.
    expect(liveRow).not.toMatch(/answering|queued|sending/);
    resolveReply?.({ status: "answered", ticket_id: "ticket-slow-1", answer: "ok" });
    await new Promise((r) => setTimeout(r, 200));
  });
});

describe("Setup join happy path", () => {
  it("joinRelay then finalizeJoin with injected deps", async () => {
    const { SetupScreen } = await import("../src/tui/screens/setup.js");
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-setup-"));
    mkdirSync(path.join(home, ".doucopy"), { recursive: true });
    const joinCalls: string[] = [];
    const joinRelay = async (_url: string, invite: string, name: string) => {
      joinCalls.push(`${invite}:${name}`);
      return { peer: name, token: "tok-join" };
    };
    const finalizeJoin = async () => ({
      ok: true,
      messages: ["config written", "daemon skipped (asker-only)"],
      errors: [] as string[],
    });

    const { lastFrame: joinFrame, unmount: uJoin } = render(
      <SetupScreen
        home={home}
        deps={{
          joinRelay,
          finalizeJoin,
          clearDraft: () => undefined,
          areAllSkillsInstalled: () => true,
          listInstallCandidates: async () => [],
        }}
        testBootstrap={{
          phase: { kind: "joining" },
          data: {
            relayUrl: "https://relay.example.com",
            invite: "ali1.test",
            peer: "test-peer",
            askers: ["cursor"],
            responder: "asker-only",
            wantSkills: false,
            neverReveal: [],
            restrictions: {
              fs_write: { mode: "workspace_only", allow: [] },
              fs_read: { deny: [] },
              shell: { mode: "off", deny: [] },
            },
          },
        }}
      />,
    );
    cleanups.push(uJoin);
    await new Promise((r) => setTimeout(r, 120));
    expect(joinCalls).toEqual(["ali1.test:test-peer"]);
    expect(joinFrame() ?? "").toMatch(/Askers|Joining|ask|Checking coding-agent/i);

    const { lastFrame, unmount } = render(
      <SetupScreen
        home={home}
        deps={{ joinRelay, finalizeJoin, clearDraft: () => undefined, areAllSkillsInstalled: () => true }}
        testBootstrap={{
          phase: { kind: "finalize" },
          data: {
            relayUrl: "https://relay.example.com",
            invite: "ali1.test",
            peer: "test-peer",
            token: "tok-join",
            askers: ["cursor"],
            responder: "asker-only",
            wantSkills: false,
            neverReveal: [],
            restrictions: {
              fs_write: { mode: "workspace_only", allow: [] },
              fs_read: { deny: [] },
              shell: { mode: "off", deny: [] },
            },
          },
        }}
      />,
    );
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 150));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Setup complete");
    expect(frame).toContain("config written");
  });
});

describe("App shell", () => {
  it("Tab switches from status toward settings label presence", async () => {
    const home = writeConfigHome();
    const { lastFrame, stdin, unmount } = render(<App home={home} initialScreen="status" />);
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 80));
    expect(lastFrame()).toContain("Status");
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Settings");
  });

  it("requires Ctrl+C twice to quit", async () => {
    const home = writeConfigHome();
    const { lastFrame, stdin, unmount } = render(<App home={home} initialScreen="status" />);
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 60));
    stdin.write("\x03"); // first Ctrl+C
    await new Promise((r) => setTimeout(r, 80));
    expect(lastFrame()).toContain("Press Ctrl+C again to quit");
    // Still mounted: second press would exit. We only assert the confirm hint.
  });

  it("letter c jumps to Chat from Status when not typing", async () => {
    const home = writeConfigHome();
    const { lastFrame, stdin, unmount } = render(<App home={home} initialScreen="status" />);
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 80));
    stdin.write("c");
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/\/ask|Type a question|local/i);
  });

  it("letter c stays in a TextPrompt field (does not jump to Chat)", async () => {
    const home = writeConfigHome();
    const { lastFrame, stdin, unmount } = render(<App home={home} initialScreen="peers" />);
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 80));
    stdin.write("a"); // Peers: open custom peer TextPrompt
    await new Promise((r) => setTimeout(r, 80));
    expect(lastFrame()).toContain("Peer name to pause");
    stdin.write("connector");
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Peer name to pause");
    expect(frame).toContain("connector");
    expect(frame).not.toMatch(/Type a question and Enter/);
  });

  it("letter q does not arm quit while Setup TextPrompt is open", async () => {
    const home = writeConfigHome();
    const { lastFrame, stdin, unmount } = render(<App home={home} initialScreen="setup" />);
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("q");
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Press Ctrl+C again to quit");
  });
});

describe("Chat stale ask target", () => {
  it("clears askPeerName restored from history when peer is missing from status", async () => {
    const { ChatScreen } = await import("../src/tui/screens/chat.js");
    const { saveChatHistory, CHAT_HISTORY_SCHEMA } = await import("../src/chat-history.js");
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-chat-stale-"));
    mkdirSync(path.join(home, ".doucopy"), { recursive: true });
    saveChatHistory(home, {
      schema_version: CHAT_HISTORY_SCHEMA,
      dialogs: [],
      feed: [{ id: "f1", kind: "system", text: "old" }],
      activeDialogId: null,
      filterDialogId: null,
      askPeerName: "GhostPeer",
      updatedAt: 1,
    });
    const snap = emptySnap({
      joined: true,
      relayOk: true,
      config: {
        self_peer: "Ivan",
        relay_url: "https://r.example.com",
        token: "tok",
        responder: { model: "composer-2.5", harness: "cursor-agent" },
      },
      peers: [
        { name: "Ivan", online: true, self: true },
        { name: "work", online: true, self: false },
      ],
    });
    const { lastFrame, unmount } = render(<ChatScreen snap={snap} home={home} inputActive />);
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 120));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Previous target GhostPeer is not on the network");
    expect(frame).not.toMatch(/\/ask GhostPeer>/);
  });
});

describe("SelectModal back", () => {
  it("Esc cancels without selecting", async () => {
    const { SelectModal } = await import("../src/tui/components/SelectModal.js");
    let cancelled = false;
    let selected: string | null = null;
    const { stdin, unmount } = render(
      <SelectModal
        title="Pick"
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
        onCancel={() => {
          cancelled = true;
        }}
        onSelect={(v) => {
          selected = v;
        }}
      />,
    );
    cleanups.push(unmount);
    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 40));
    expect(cancelled).toBe(true);
    expect(selected).toBeNull();
  });
});
