import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import {
  FOREIGN_HOME_INSTALL,
  RESPONDER_DAEMON_UNSUPPORTED,
  assertInstallableHome,
  installDaemon,
  isDaemonRunning,
  programArgumentsXml,
  readKeepAwakeEnabled,
  renderPlist,
  responderDaemonSupported,
  stopDaemon,
} from "../src/launchd.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("responderDaemonSupported", () => {
  it("is true on darwin and win32", () => {
    expect(responderDaemonSupported("darwin")).toBe(true);
    expect(responderDaemonSupported("win32")).toBe(true);
    expect(responderDaemonSupported("linux")).toBe(false);
  });
});

describe("unsupported platform daemon guards", () => {
  it("installDaemon refuses on linux with a clear unsupported error", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-daemon-"));
    expect(() => installDaemon(home, "linux")).toThrow(RESPONDER_DAEMON_UNSUPPORTED);
  });

  it("isDaemonRunning is false on linux", () => {
    expect(isDaemonRunning("linux")).toBe(false);
  });

  it("stopDaemon is a no-op on linux", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-daemon-"));
    expect(() => stopDaemon(home, "linux")).not.toThrow();
  });
});

describe("launchd keep_awake plist", () => {
  it("wraps node with caffeinate when keep_awake is on", () => {
    const xml = programArgumentsXml("/usr/bin/node", "/repo", true);
    expect(xml).toContain("<string>/usr/bin/caffeinate</string>");
    expect(xml).toContain("<string>-dims</string>");
    expect(xml).toContain("<string>/usr/bin/node</string>");
    expect(xml).toContain("<string>/repo/daemon/dist/index.js</string>");
  });

  it("runs node directly when keep_awake is off", () => {
    const xml = programArgumentsXml("/usr/bin/node", "/repo", false);
    expect(xml).not.toContain("caffeinate");
    expect(xml).toContain("<string>/usr/bin/node</string>");
    expect(xml).toContain("<string>/repo/daemon/dist/index.js</string>");
  });

  it("renders a full plist with caffeinate args", () => {
    const plist = renderPlist(
      "/Users/real/.nvm/versions/node/v22.11.0/bin/node",
      ROOT,
      "/Users/me",
      true,
      "/Users/real",
    );
    expect(plist).toContain("<string>/usr/bin/caffeinate</string>");
    expect(plist).toContain("/Users/me/.doucopy/responder.log");
    expect(plist).toContain("/Users/real/.nvm/versions/node/v22.11.0/bin");
    expect(plist).toContain("/Users/real/.local/bin");
    expect(plist).not.toContain("/Users/me/.local/bin");
    expect(plist).toContain("com.doucopy.responder");
  });

  it("refuses to install against a foreign (temp) home", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-foreign-"));
    expect(() => assertInstallableHome(home)).toThrow(/non-user home/);
    expect(() => installDaemon(home, "darwin")).toThrow(FOREIGN_HOME_INSTALL);
  });

  it("allows the real user home", () => {
    expect(() => assertInstallableHome(homedir())).not.toThrow();
  });

  it("reads keep_awake.enabled from config (default true)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-ka-"));
    expect(readKeepAwakeEnabled(home)).toBe(true);
    mkdirSync(path.join(home, ".doucopy"), { recursive: true });
    writeFileSync(
      path.join(home, ".doucopy/config.json"),
      JSON.stringify({ keep_awake: { enabled: false } }),
    );
    expect(readKeepAwakeEnabled(home)).toBe(false);
  });
});
