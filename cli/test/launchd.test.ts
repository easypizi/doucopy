import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  programArgumentsXml,
  readKeepAwakeEnabled,
  renderPlist,
} from "../src/launchd.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
    const plist = renderPlist("/usr/bin/node", ROOT, "/Users/me", true);
    expect(plist).toContain("<string>/usr/bin/caffeinate</string>");
    expect(plist).toContain("/Users/me/.doucopy/responder.log");
    expect(plist).toContain("com.doucopy.responder");
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
