import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemonPathDirs, buildDaemonPathValue } from "../src/daemon-path.js";

describe("buildDaemonPathDirs", () => {
  it("puts node bin dir first on darwin (nvm / npm -g)", () => {
    const dirs = buildDaemonPathDirs({
      nodeBin: "/Users/me/.nvm/versions/node/v22.11.0/bin/node",
      pathHome: "/Users/me",
      platform: "darwin",
    });
    expect(dirs[0]).toBe("/Users/me/.nvm/versions/node/v22.11.0/bin");
    expect(dirs).toContain("/Users/me/.local/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
  });

  it("puts node bin dir and AppData\\npm first on win32", () => {
    const dirs = buildDaemonPathDirs({
      nodeBin: "C:\\Users\\me\\AppData\\Roaming\\nvm\\v22.17.1\\node.exe",
      pathHome: "C:\\Users\\me",
      platform: "win32",
      env: {
        APPDATA: "C:\\Users\\me\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
    });
    expect(dirs[0]?.toLowerCase()).toBe(
      path.win32.normalize("C:\\Users\\me\\AppData\\Roaming\\nvm\\v22.17.1").toLowerCase(),
    );
    expect(dirs).toContain("C:\\Users\\me\\AppData\\Roaming\\npm");
    expect(dirs).toContain("C:\\Users\\me\\AppData\\Local\\cursor-agent");
    expect(dirs.some((d) => d.toLowerCase().includes(".local"))).toBe(true);
  });
});

describe("buildDaemonPathValue", () => {
  it("joins with platform separator and optional append", () => {
    const unix = buildDaemonPathValue({
      nodeBin: "/usr/local/bin/node",
      pathHome: "/Users/me",
      platform: "darwin",
      appendPath: "/custom",
    });
    expect(unix.startsWith("/usr/local/bin:")).toBe(true);
    expect(unix.endsWith(":/custom")).toBe(true);

    const win = buildDaemonPathValue({
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      pathHome: "C:\\Users\\me",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    });
    expect(win.includes(";")).toBe(true);
    expect(win.startsWith("C:\\Program Files\\nodejs")).toBe(true);
  });
});
