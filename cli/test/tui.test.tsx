import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { Header } from "../src/tui/header.js";
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
  it("lists keep awake and supports Esc discard confirm", async () => {
    const home = writeConfigHome();
    const { lastFrame, stdin, unmount } = render(<SettingsScreen home={home} inputActive />);
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
    const { lastFrame, stdin, unmount } = render(<SettingsScreen home={home} inputActive />);
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
          }),
          fetchReply: async () => {
            polls += 1;
            if (polls < 2) {
              return { status: "pending", ticket_id: "ticket-pending-1" };
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
    await new Promise((r) => setTimeout(r, 400));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("PONG-from-work");
    expect(polls).toBeGreaterThanOrEqual(2);
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
