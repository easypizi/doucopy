import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  WINDOWS_TASK_NAME,
  deleteWindowsDaemon,
  installWindowsDaemon,
  isWindowsDaemonRunning,
  parseSchtasksRunning,
  renderWindowsTaskXml,
  renderWindowsWrapper,
  stopWindowsDaemon,
  windowsCmdPath,
  windowsTaskUserId,
  windowsTaskXmlPath,
} from "../src/windows-task.js";

describe("windows task paths", () => {
  it("places cmd and xml under ~/.doucopy", () => {
    const home = "C:\\Users\\me";
    expect(windowsCmdPath(home)).toBe(path.join(home, ".doucopy", "responder.cmd"));
    expect(windowsTaskXmlPath(home)).toBe(path.join(home, ".doucopy", "responder.task.xml"));
  });
});

describe("renderWindowsWrapper", () => {
  it("runs node daemon entry and appends logs under home", () => {
    const home = "C:\\Users\\me";
    const cmd = renderWindowsWrapper(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\npm\\node_modules\\doucopy\\daemon\\dist\\index.js",
      home,
    );
    expect(cmd).toContain("@echo off");
    expect(cmd).toContain("C:\\Program Files\\nodejs\\node.exe");
    expect(cmd).toContain("C:\\npm\\node_modules\\doucopy\\daemon\\dist\\index.js");
    expect(cmd).toContain(path.join(home, ".doucopy", "responder.log"));
    expect(cmd).toContain(path.join(home, ".doucopy", "responder.err.log"));
    expect(cmd).toMatch(/PATH=/i);
    // node dir first so npm -g claude/codex resolve under the same Node install
    expect(cmd).toMatch(/set "PATH=C:\\Program Files\\nodejs;/i);
    expect(cmd).toContain('set "USERPROFILE=C:\\Users\\me"');
    expect(cmd).toContain('set "HOMEDRIVE=C:"');
    expect(cmd).toContain('set "HOMEPATH=\\Users\\me"');
    expect(cmd).toContain('set "APPDATA=C:\\Users\\me\\AppData\\Roaming"');
    expect(cmd).toContain('set "LOCALAPPDATA=C:\\Users\\me\\AppData\\Local"');
    expect(cmd).toContain("C:\\Users\\me\\AppData\\Local\\cursor-agent");
  });
});

describe("stopWindowsDaemon", () => {
  it("disables before ending, and never deletes the task", () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    stopWindowsDaemon(run);
    expect(run.mock.calls.map((c) => c[0])).toEqual([
      ["/Change", "/TN", WINDOWS_TASK_NAME, "/DISABLE"],
      ["/End", "/TN", WINDOWS_TASK_NAME],
    ]);
  });
});

describe("deleteWindowsDaemon", () => {
  it("ends and deletes the task (uninstall)", () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    deleteWindowsDaemon(run);
    expect(run).toHaveBeenCalledWith(["/End", "/TN", WINDOWS_TASK_NAME]);
    expect(run).toHaveBeenCalledWith(["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
  });
});

describe("windowsTaskUserId", () => {
  it("builds DOMAIN\\user from env", () => {
    expect(windowsTaskUserId({ USERDOMAIN: "DESKTOP-X", USERNAME: "ivan" }, { username: "fallback" })).toBe(
      "DESKTOP-X\\ivan",
    );
  });
});

describe("renderWindowsTaskXml", () => {
  it("registers logon trigger, restart-on-failure, and the wrapper cmd", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-win-"));
    const cmdPath = windowsCmdPath(home);
    const xml = renderWindowsTaskXml(cmdPath, home, "DESKTOP\\ivan");
    expect(xml).toContain("LogonTrigger");
    expect(xml).toContain("InteractiveToken");
    expect(xml).toContain("<UserId>DESKTOP\\ivan</UserId>");
    expect(xml).toContain("RestartOnFailure");
    expect(xml).toContain("<Command>cmd.exe</Command>");
    expect(xml).toContain(cmdPath.replace(/&/g, "&amp;"));
    expect(xml).toContain(path.join(home, ".doucopy").replace(/&/g, "&amp;"));
  });

  it("escapes XML special characters in paths", () => {
    const xml = renderWindowsTaskXml("C:\\a&b\\responder.cmd", "C:\\a&b", "A\\b");
    expect(xml).toContain("C:\\a&amp;b\\responder.cmd");
    expect(xml).not.toContain("C:\\a&b\\responder.cmd");
  });
});

describe("parseSchtasksRunning", () => {
  it("detects Running status from verbose query output", () => {
    expect(parseSchtasksRunning("TaskName: doucopy-responder\nStatus: Running\n")).toBe(true);
    expect(parseSchtasksRunning("Status: Ready\n")).toBe(false);
    expect(parseSchtasksRunning("")).toBe(false);
  });
});

describe("isWindowsDaemonRunning", () => {
  it("queries schtasks and parses status", () => {
    const run = vi.fn().mockReturnValue({
      status: 0,
      stdout: `TaskName:       \\${WINDOWS_TASK_NAME}\r\nStatus:         Running\r\n`,
      stderr: "",
    });
    expect(isWindowsDaemonRunning(run)).toBe(true);
    expect(run).toHaveBeenCalledWith(["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"]);
  });

  it("returns false when the task is missing", () => {
    const run = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." });
    expect(isWindowsDaemonRunning(run)).toBe(false);
  });
});

describe("installWindowsDaemon", () => {
  it("writes UTF-16 XML with UserId and creates the task without /RU", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-win-install-"));
    const daemonEntry = path.join(home, "daemon.js");
    mkdirSync(path.dirname(daemonEntry), { recursive: true });
    writeFileSync(daemonEntry, "// stub\n");
    const run = vi.fn().mockReturnValue({ status: 0, stdout: "SUCCESS", stderr: "" });
    installWindowsDaemon(home, "C:\\node.exe", daemonEntry, run, "PC\\ivan");
    const createCall = run.mock.calls.find((c) => c[0]?.[0] === "/Create");
    expect(createCall?.[0]).toEqual([
      "/Create",
      "/TN",
      WINDOWS_TASK_NAME,
      "/XML",
      windowsTaskXmlPath(home),
      "/F",
    ]);
    expect(createCall?.[0]).not.toContain("/RU");
    const xml = readFileSync(windowsTaskXmlPath(home), "utf16le");
    expect(xml).toContain("<UserId>PC\\ivan</UserId>");
  });
});
