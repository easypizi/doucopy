export type ScreenId = "status" | "settings" | "peers" | "chat" | "setup" | "invite" | "ops";

export const SCREENS: readonly ScreenId[] = [
  "status",
  "settings",
  "peers",
  "chat",
  "setup",
  "invite",
  "ops",
] as const;

export const SCREEN_LABELS: Record<ScreenId, string> = {
  status: "Status",
  settings: "Settings",
  peers: "Peers",
  chat: "Chat",
  setup: "Setup",
  invite: "Invite",
  ops: "Ops",
};

export interface LaunchOptions {
  screen?: ScreenId;
  /** Extra argv for join/setup (URL, invite, flags). */
  argv?: string[];
  /** When true, Setup opens in owner-deploy mode. */
  setupMode?: boolean;
  home?: string;
}
