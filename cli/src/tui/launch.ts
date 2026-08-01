import { render } from "ink";
import { homedir } from "node:os";
import React from "react";
import { App } from "./app.js";
import type { LaunchOptions, ScreenId } from "./types.js";

export function canUseTui(): boolean {
  if (process.env.DOUCOPY_NO_TUI === "1") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function launchTui(opts: LaunchOptions = {}): Promise<void> {
  const home = opts.home ?? homedir();
  const initialScreen: ScreenId = opts.screen ?? "status";
  const instance = render(
    React.createElement(App, {
      home,
      initialScreen,
      argv: opts.argv ?? [],
      setupMode: opts.setupMode ?? false,
    }),
    {
      // Full-window TUI like vim/htop/Claude Code: leave scrollback alone,
      // restore the previous terminal contents on exit.
      alternateScreen: true,
      interactive: true,
    },
  );
  await instance.waitUntilExit();
}

export type { LaunchOptions, ScreenId };
