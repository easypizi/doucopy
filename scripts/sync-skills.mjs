#!/usr/bin/env node
// Mirrors user-facing skills from .cursor/skills (dev source of truth) into
// skills/ (what actually ships in the npm tarball). Runs on prepack.
// Dev-only skills (agent-link-dev, agent-link-relay, agent-link-privacy,
// agent-link-setup) are intentionally excluded — they document maintainer
// workflows, not user ones.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, ".cursor/skills");
const DEST = path.join(ROOT, "skills");
const USER_SKILLS = ["agent-link-ask", "agent-link-answer", "agent-link-troubleshoot"];

mkdirSync(DEST, { recursive: true });
for (const name of USER_SKILLS) {
  const src = path.join(SOURCE, name);
  const dst = path.join(DEST, name);
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  console.log(`synced ${name}`);
}
