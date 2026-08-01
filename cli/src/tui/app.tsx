import { Box, useApp, useInput, useWindowSize } from "ink";
import { useState } from "react";
import { FooterHints } from "./components/FooterHints.js";
import { Panel } from "./components/Panel.js";
import { TabBar } from "./components/TabBar.js";
import { Header } from "./header.js";
import { ChatScreen } from "./screens/chat.js";
import { InviteScreen } from "./screens/invite.js";
import { OpsScreen } from "./screens/ops.js";
import { PeersScreen } from "./screens/peers.js";
import { SettingsScreen } from "./screens/settings.js";
import { SetupScreen } from "./screens/setup.js";
import { StatusScreen } from "./screens/status.js";
import { SCREENS, type LaunchOptions, type ScreenId } from "./types.js";
import { useStatusSnapshot } from "./useStatusSnapshot.js";

export function App({
  home,
  initialScreen = "status",
  argv = [],
  setupMode = false,
}: {
  home: string;
  initialScreen?: ScreenId;
  argv?: string[];
  setupMode?: boolean;
}) {
  const { exit } = useApp();
  const win = useWindowSize();
  const columns = Math.max(win.columns || 0, 60);
  const rows = Math.max(win.rows || 0, 20);
  const [screen, setScreen] = useState<ScreenId>(initialScreen);
  const [chatBusy, setChatBusy] = useState(false);
  const snap = useStatusSnapshot(home);

  const screenIndex = SCREENS.indexOf(screen);
  const wrapScreens = screen !== "status";

  useInput((input, key) => {
    if (input === "q" && screen !== "chat") {
      exit();
      return;
    }
    // Quick jump to Chat from browse screens (not while typing in Settings/Setup).
    if (input === "c" && (screen === "status" || screen === "peers" || screen === "invite" || screen === "ops")) {
      setScreen("chat");
      return;
    }
    if (key.tab) {
      const delta = key.shift ? -1 : 1;
      const next = SCREENS[(screenIndex + delta + SCREENS.length) % SCREENS.length]!;
      setScreen(next);
    }
  });

  const body = (
    <>
      {screen === "status" ? (
        <StatusScreen
          snap={snap}
          onRefresh={snap.refresh}
          onOpenPeers={() => setScreen("peers")}
          inputActive
        />
      ) : null}
      {screen === "settings" ? <SettingsScreen home={home} inputActive onSaved={snap.refresh} /> : null}
      {screen === "peers" ? <PeersScreen snap={snap} onRefresh={snap.refresh} inputActive /> : null}
      {screen === "chat" ? <ChatScreen snap={snap} inputActive onBusyChange={setChatBusy} /> : null}
      {screen === "setup" ? (
        <SetupScreen home={home} setupMode={setupMode} argv={argv} inputActive />
      ) : null}
      {screen === "invite" ? <InviteScreen home={home} inputActive /> : null}
      {screen === "ops" ? <OpsScreen inputActive /> : null}
    </>
  );

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1} paddingY={0}>
      <Box flexShrink={0}>
        <Header snap={snap} />
      </Box>
      <Box flexShrink={0}>
        <TabBar active={screen} />
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={6}>
        {wrapScreens ? (
          <Panel flexGrow={1}>{body}</Panel>
        ) : (
          body
        )}
      </Box>
      <Box flexShrink={0}>
        <FooterHints
          hints={
            chatBusy
              ? "replies pending — keep typing in Chat · Tab switch · q quit"
              : "Tab / Shift+Tab switch · q quit"
          }
        />
      </Box>
    </Box>
  );
}

export type { LaunchOptions };
