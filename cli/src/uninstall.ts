import { confirm } from "@inquirer/prompts";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stopDaemon, plistDestination } from "./launchd.js";
import { removeDoucopyMcpEntries } from "./setup.js";
import { removeGlobalDoucopySkills } from "./skills.js";
import { deleteWindowsDaemon, windowsCmdPath, windowsTaskXmlPath } from "./windows-task.js";

export interface UninstallOptions {
  home?: string;
  purge?: boolean;
  yes?: boolean;
  stopDaemon?: (home: string) => void;
  deleteWindowsTask?: () => void;
  confirm?: () => Promise<boolean>;
  log?: (line: string) => void;
}

function removeSupervisorArtifacts(home: string, log: (line: string) => void): void {
  const plist = plistDestination(home);
  if (existsSync(plist)) {
    rmSync(plist, { force: true });
    log(`removed ${plist}`);
  }
  const legacyPlist = path.join(home, "Library/LaunchAgents", "com.agent-link.responder.plist");
  if (existsSync(legacyPlist)) {
    rmSync(legacyPlist, { force: true });
    log(`removed ${legacyPlist}`);
  }
  for (const file of [windowsCmdPath(home), windowsTaskXmlPath(home)]) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      log(`removed ${file}`);
    }
  }
}

export async function runUninstall(opts: UninstallOptions = {}): Promise<void> {
  const home = opts.home ?? homedir();
  const purge = Boolean(opts.purge);
  const yes = Boolean(opts.yes);
  const log = opts.log ?? ((line: string) => console.log(line));
  const stop = opts.stopDaemon ?? ((h: string) => stopDaemon(h));
  const deleteTask = opts.deleteWindowsTask ?? (() => deleteWindowsDaemon());

  if (purge && !yes) {
    const ok = opts.confirm
      ? await opts.confirm()
      : await confirm({
          message:
            "Purge will delete ~/.doucopy, global doucopy-* skills, and MCP entries. Continue?",
          default: false,
        });
    if (!ok) throw new Error("uninstall cancelled");
  }

  try {
    stop(home);
    log("stopped responder daemon (if it was running)");
  } catch (err) {
    log(`stop daemon: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (process.platform === "win32" || opts.deleteWindowsTask) {
    try {
      deleteTask();
      log("removed Windows Task Scheduler registration (if present)");
    } catch (err) {
      log(`delete Windows task: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  removeSupervisorArtifacts(home, log);

  if (purge) {
    const doucopyHome = path.join(home, ".doucopy");
    if (existsSync(doucopyHome)) {
      rmSync(doucopyHome, { recursive: true, force: true });
      log(`removed ${doucopyHome}`);
    }
    const skillsRemoved = removeGlobalDoucopySkills(home);
    for (const p of skillsRemoved) log(`removed skill ${p}`);
    const mcpRemoved = removeDoucopyMcpEntries(home);
    for (const p of mcpRemoved) log(`removed MCP entry from ${p}`);
    log("restart Cursor / Claude Code / Codex so they drop the doucopy MCP server");
  }

  log("To remove the npm package itself, run: npm uninstall -g doucopy");
}
