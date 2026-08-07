import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { checkForUpdate, type UpdateCheckResult } from "../update-check.js";
import { FooterHints } from "./components/FooterHints.js";
import { Panel } from "./components/Panel.js";
import { TabBar } from "./components/TabBar.js";
import { Header } from "./header.js";
import { KeyCaptureProvider, useKeyCapture } from "./key-capture.js";
import { ChatScreen } from "./screens/chat.js";
import { InviteScreen } from "./screens/invite.js";
import { OpsScreen } from "./screens/ops.js";
import { PeersScreen } from "./screens/peers.js";
import { SettingsScreen } from "./screens/settings.js";
import { SetupScreen } from "./screens/setup.js";
import { StatusScreen } from "./screens/status.js";
import { UpdatesScreen } from "./screens/updates.js";
import { APP_VERSION, theme } from "./theme.js";
import { SCREENS, type LaunchOptions, type ScreenId } from "./types.js";
import { useStatusSnapshot } from "./useStatusSnapshot.js";

/** Second Ctrl+C / q within this window exits. */
export const QUIT_CONFIRM_MS = 2000;

function AppShell({
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
  const { captured } = useKeyCapture();
  const win = useWindowSize();
  const columns = Math.max(win.columns || 0, 60);
  const rows = Math.max(win.rows || 0, 20);
  const [screen, setScreen] = useState<ScreenId>(initialScreen);
  const [chatBusy, setChatBusy] = useState(false);
  const [quitHint, setQuitHint] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const lastQuitAt = useRef(0);
  const snap = useStatusSnapshot(home);

  const screenIndex = SCREENS.indexOf(screen);
  const wrapScreens = screen !== "status";

  useEffect(() => {
    setUpdateInfo(checkForUpdate(home, APP_VERSION, { force: false }));
  }, [home]);

  useEffect(() => {
    if (!quitHint) return;
    const t = setTimeout(() => setQuitHint(false), QUIT_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [quitHint]);

  const requestQuit = () => {
    const now = Date.now();
    if (now - lastQuitAt.current <= QUIT_CONFIRM_MS) {
      exit();
      return;
    }
    lastQuitAt.current = now;
    setQuitHint(true);
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      requestQuit();
      return;
    }
    // While a text field / wizard holds capture, only Ctrl+C and Tab remain.
    if (captured) {
      if (key.tab) {
        const delta = key.shift ? -1 : 1;
        const next = SCREENS[(screenIndex + delta + SCREENS.length) % SCREENS.length]!;
        setScreen(next);
      }
      return;
    }
    if (input === "q" && screen !== "chat") {
      requestQuit();
      return;
    }
    // Quick jump to Chat from browse screens (not while typing).
    if (
      input === "c"
      && (screen === "status" || screen === "peers" || screen === "invite" || screen === "ops" || screen === "updates")
    ) {
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
          onOpenUpdates={() => setScreen("updates")}
          updateAvailable={updateInfo?.updateAvailable ? updateInfo.latest : null}
          inputActive
        />
      ) : null}
      {screen === "settings" ? <SettingsScreen home={home} inputActive onSaved={snap.refresh} /> : null}
      {screen === "peers" ? <PeersScreen snap={snap} onRefresh={snap.refresh} inputActive /> : null}
      {screen === "chat" ? (
        <ChatScreen snap={snap} home={home} inputActive onBusyChange={setChatBusy} />
      ) : null}
      {screen === "setup" ? (
        <SetupScreen home={home} setupMode={setupMode} argv={argv} inputActive />
      ) : null}
      {screen === "invite" ? <InviteScreen home={home} inputActive /> : null}
      {screen === "ops" ? <OpsScreen home={home} inputActive /> : null}
      {screen === "updates" ? (
        <UpdatesScreen home={home} inputActive onResult={setUpdateInfo} />
      ) : null}
    </>
  );

  const baseHints = chatBusy
    ? "replies pending — keep typing in Chat · Tab switch · Ctrl+C twice to quit"
    : "Tab / Shift+Tab switch · Ctrl+C twice to quit";

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1} paddingY={0}>
      <Box flexShrink={0}>
        <Header
          snap={snap}
          updateAvailable={updateInfo?.updateAvailable ? updateInfo.latest : null}
        />
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
      <Box flexShrink={0} flexDirection="column">
        {quitHint ? (
          <Text color={theme.warn} bold>
            Press Ctrl+C again to quit
          </Text>
        ) : null}
        <FooterHints hints={baseHints} />
      </Box>
    </Box>
  );
}

export function App(props: {
  home: string;
  initialScreen?: ScreenId;
  argv?: string[];
  setupMode?: boolean;
}) {
  return (
    <KeyCaptureProvider>
      <AppShell {...props} />
    </KeyCaptureProvider>
  );
}

export type { LaunchOptions };
