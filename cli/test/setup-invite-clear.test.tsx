import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { pushHistory } from "../src/field-history.js";
import { SetupScreen } from "../src/tui/screens/setup.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("Setup invite clear + field history", () => {
  it("clears invite when submitting a new Relay URL", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-invite-clear-"));
    mkdirSync(path.join(home, ".doucopy"), { recursive: true });

    const { lastFrame, stdin, unmount } = render(
      <SetupScreen
        home={home}
        testBootstrap={{
          phase: { kind: "relay" },
          data: {
            relayUrl: "https://old.example.com",
            invite: "stale-invite-code",
          },
        }}
      />,
    );
    cleanups.push(unmount);

    await new Promise((r) => setTimeout(r, 40));
    expect(lastFrame() ?? "").toContain("Relay URL");

    // Replace text and submit (ink-text-input: type then Enter)
    stdin.write("\u0015"); // clear line (Ctrl+U) — may be a no-op depending on input
    stdin.write("https://new.example.com");
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 80));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Invite code");
    expect(frame).not.toContain("stale-invite-code");
  });

  it("offers recent relay URLs when history exists", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-relay-hist-"));
    mkdirSync(path.join(home, ".doucopy"), { recursive: true });
    pushHistory(home, { relay_url: "https://hist.example.com" });

    const { lastFrame, unmount } = render(
      <SetupScreen
        home={home}
        testBootstrap={{
          phase: { kind: "relay_pick" },
          data: {},
        }}
      />,
    );
    cleanups.push(unmount);
    await new Promise((r) => setTimeout(r, 40));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("https://hist.example.com");
    expect(frame).toContain("Custom");
  });
});
