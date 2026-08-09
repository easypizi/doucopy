import { render } from "ink";
import { homedir } from "node:os";
import React from "react";
import { loginWithInherit, probeHarness, type HarnessId } from "../harness-install.js";
import { readSetupResume, writeSetupResume } from "../setup-resume.js";
import { App } from "./app.js";
import type { LaunchOptions, ScreenId } from "./types.js";

export function canUseTui(): boolean {
  if (process.env.DOUCOPY_NO_TUI === "1") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function runPendingLogins(home: string): Promise<boolean> {
  const resume = readSetupResume(home);
  if (!resume || resume.pendingLogins.length === 0) return false;

  console.log("\ndoucopy: Setup paused for harness login.");
  console.log("A browser or CLI prompt should appear in THIS window.");
  console.log("If nothing happens for ~30s, press Ctrl+C and run the login command manually.\n");
  for (const id of resume.pendingLogins) {
    console.log(`── Logging in to ${id} ──`);
    const result = loginWithInherit(id);
    if (!result.ok) {
      console.log(`Login for ${id} did not complete${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
      if (id === "cursor") {
        console.log("Manual fix: install Cursor Agent, then run:  agent login");
        console.log("             (or: cursor-agent login)");
      } else if (id === "claude") {
        console.log("Manual fix: npm i -g @anthropic-ai/claude-code && claude auth login");
      } else {
        console.log("Manual fix: npm i -g @openai/codex && codex login");
      }
    } else {
      const probe = await probeHarness(id as HarnessId);
      console.log(
        probe.authenticated
          ? `Authenticated ${id}`
          : `Login finished for ${id} (re-check auth if needed)`,
      );
    }
    console.log("");
  }

  writeSetupResume(home, {
    ...resume,
    pendingLogins: [],
    resumePhase: "askers",
  });
  console.log("doucopy: Resuming Setup…\n");
  return true;
}

export async function launchTui(opts: LaunchOptions = {}): Promise<void> {
  const home = opts.home ?? homedir();
  let initialScreen: ScreenId = opts.screen ?? "status";
  let setupMode = opts.setupMode ?? false;
  let argv = opts.argv ?? [];

  for (;;) {
    const instance = render(
      React.createElement(App, {
        home,
        initialScreen,
        argv,
        setupMode,
      }),
      {
        // Full-window TUI like vim/htop/Claude Code: leave scrollback alone,
        // restore the previous terminal contents on exit.
        alternateScreen: true,
        interactive: true,
        // App handles double Ctrl+C (and double q) itself.
        exitOnCtrlC: false,
      },
    );
    await instance.waitUntilExit();

    const didLogin = await runPendingLogins(home);
    if (!didLogin) break;

    const resume = readSetupResume(home);
    initialScreen = "setup";
    setupMode = resume?.setupMode ?? false;
    argv = resume?.argv ?? [];
  }
}

export type { LaunchOptions, ScreenId };
