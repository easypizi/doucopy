import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HarnessId } from "./harness-install.js";
import type { JoinClient, JoinResponderChoice } from "./join.js";
import type { RestrictionsSettings } from "./settings.js";

const RESUME_FILE = "setup-resume.json";

export type SetupResumePhase =
  | "askers"
  | "harness_check"
  | "harness_offer"
  | "responder"
  | "skills"
  | "never"
  | "finalize";

export interface SetupResumeDraft {
  relayUrl?: string;
  invite?: string;
  peer?: string;
  token?: string;
  askers?: JoinClient[];
  responder?: JoinResponderChoice;
  wantSkills?: boolean;
  neverReveal?: string[];
  restrictions?: RestrictionsSettings;
}

export interface SetupResume {
  draft: SetupResumeDraft;
  pendingLogins: HarnessId[];
  resumePhase: SetupResumePhase;
  setupMode: boolean;
  argv: string[];
  selectedHarnesses?: HarnessId[];
}

function resumePath(home: string): string {
  return path.join(home, ".doucopy", RESUME_FILE);
}

export function readSetupResume(home: string): SetupResume | null {
  const file = resumePath(home);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as SetupResume;
    if (!raw || typeof raw !== "object") return null;
    if (!Array.isArray(raw.pendingLogins)) return null;
    if (typeof raw.resumePhase !== "string") return null;
    return {
      draft: raw.draft ?? {},
      pendingLogins: raw.pendingLogins,
      resumePhase: raw.resumePhase,
      setupMode: Boolean(raw.setupMode),
      argv: Array.isArray(raw.argv) ? raw.argv.filter((a): a is string => typeof a === "string") : [],
      selectedHarnesses: Array.isArray(raw.selectedHarnesses)
        ? raw.selectedHarnesses.filter((id): id is HarnessId =>
            id === "cursor" || id === "claude" || id === "codex",
          )
        : undefined,
    };
  } catch {
    return null;
  }
}

export function writeSetupResume(home: string, resume: SetupResume): void {
  const dir = path.join(home, ".doucopy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resumePath(home), `${JSON.stringify(resume, null, 2)}\n`, { mode: 0o600 });
}

export function clearSetupResume(home: string): void {
  const file = resumePath(home);
  if (existsSync(file)) unlinkSync(file);
}
