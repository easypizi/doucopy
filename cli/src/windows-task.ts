import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";

export const WINDOWS_TASK_NAME = "doucopy-responder";

export type SchtasksResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type SchtasksRunner = (args: string[]) => SchtasksResult;

function defaultSchtasks(args: string[]): SchtasksResult {
  const out = spawnSync("schtasks.exe", args, { encoding: "utf8" });
  return {
    status: out.status,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Quote a Windows path for use inside a .cmd script. */
function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, "")}"`;
}

/**
 * DOMAIN\\user for Task Scheduler InteractiveToken tasks.
 * Win11 rejects XML without UserId ("Access is denied" for non-admin create).
 */
export function windowsTaskUserId(
  env: NodeJS.ProcessEnv = process.env,
  info: { username: string } = userInfo(),
): string {
  const user = (env.USERNAME || info.username || "User").trim();
  const domain = (env.USERDOMAIN || hostname() || ".").trim();
  return `${domain}\\${user}`;
}

export function windowsCmdPath(home: string): string {
  return path.join(home, ".doucopy", "responder.cmd");
}

export function windowsTaskXmlPath(home: string): string {
  return path.join(home, ".doucopy", "responder.task.xml");
}

export function renderWindowsWrapper(nodeBin: string, daemonEntry: string, home: string): string {
  const logOut = path.join(home, ".doucopy", "responder.log");
  const logErr = path.join(home, ".doucopy", "responder.err.log");
  const lines = [
    "@echo off",
    "set \"PATH=%USERPROFILE%\\.local\\bin;%LOCALAPPDATA%\\Programs\\cursor\\resources\\app\\bin;%APPDATA%\\npm;%ProgramFiles%\\nodejs;%PATH%\"",
    `${cmdQuote(nodeBin)} ${cmdQuote(daemonEntry)} >> ${cmdQuote(logOut)} 2>> ${cmdQuote(logErr)}`,
    "",
  ];
  return lines.join("\r\n");
}

export function renderWindowsTaskXml(
  cmdPath: string,
  home: string,
  userId: string = windowsTaskUserId(),
): string {
  const workDir = path.join(home, ".doucopy");
  const args = `/c ${cmdQuote(cmdPath)}`;
  const userXml = xmlEscape(userId);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>doucopy responder daemon</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${userXml}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${userXml}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>cmd.exe</Command>",
    `      <Arguments>${xmlEscape(args)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(workDir)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

export function parseSchtasksRunning(stdout: string): boolean {
  return /^Status:\s*Running\s*$/im.test(stdout);
}

export function isWindowsDaemonRunning(run: SchtasksRunner = defaultSchtasks): boolean {
  const out = run(["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"]);
  if (out.status !== 0) return false;
  return parseSchtasksRunning(out.stdout);
}

export function writeWindowsDaemonFiles(
  home: string,
  nodeBin: string,
  daemonEntry: string,
  userId: string = windowsTaskUserId(),
): { cmdPath: string; xmlPath: string } {
  const dir = path.join(home, ".doucopy");
  mkdirSync(path.join(dir, "workspace"), { recursive: true });
  const cmdPath = windowsCmdPath(home);
  const xmlPath = windowsTaskXmlPath(home);
  writeFileSync(cmdPath, renderWindowsWrapper(nodeBin, daemonEntry, home), "utf8");
  // schtasks /Create /XML expects Unicode on Windows.
  const xml = renderWindowsTaskXml(cmdPath, home, userId);
  writeFileSync(xmlPath, `\ufeff${xml}`, { encoding: "utf16le" });
  return { cmdPath, xmlPath };
}

export function installWindowsDaemon(
  home: string,
  nodeBin: string,
  daemonEntry: string,
  run: SchtasksRunner = defaultSchtasks,
  userId: string = windowsTaskUserId(),
): void {
  if (!existsSync(daemonEntry)) {
    throw new Error(`daemon build not found at ${daemonEntry}, run: npm run build`);
  }
  const { xmlPath } = writeWindowsDaemonFiles(home, nodeBin, daemonEntry, userId);
  // Best-effort cleanup of a previous registration.
  run(["/End", "/TN", WINDOWS_TASK_NAME]);
  run(["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
  // /XML + InteractiveToken + UserId: works without admin on Win11 22H2+.
  // Do not pass /RU or /RP — those force Password logon and need elevation.
  const created = run(["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", xmlPath, "/F"]);
  if (created.status !== 0) {
    const detail = (created.stderr || created.stdout || "schtasks /Create failed").trim();
    throw new Error(
      `failed to register Windows task ${WINDOWS_TASK_NAME}: ${detail}` +
        ` (user=${userId}). Try: open PowerShell as your normal user (not Admin),` +
        ` then run "doucopy restart". If a stale elevated task exists, delete` +
        ` "${WINDOWS_TASK_NAME}" in Task Scheduler first.`,
    );
  }
  const started = run(["/Run", "/TN", WINDOWS_TASK_NAME]);
  if (started.status !== 0) {
    const detail = (started.stderr || started.stdout || "schtasks /Run failed").trim();
    throw new Error(`failed to start Windows task ${WINDOWS_TASK_NAME}: ${detail}`);
  }
}

export function stopWindowsDaemon(run: SchtasksRunner = defaultSchtasks): void {
  run(["/End", "/TN", WINDOWS_TASK_NAME]);
  run(["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
}
