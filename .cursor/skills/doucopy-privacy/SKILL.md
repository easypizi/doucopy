---
name: doucopy-privacy
description: "Use when tightening what the responder is allowed to reveal or do, adjusting restrictions / redact / policy.md, narrowing memory_sources, or red-teaming your own setup with ask_peer. Explains the three-layer model and which rule belongs in which layer."
---

# doucopy: privacy tuning

## Three layers, different strength

**Hard tool lockdown (deterministic).** Before each run the daemon writes harness-native permissions (`daemon/src/permissions.ts`). Cursor gets `<workspace>/.cursor/cli.json`, Claude gets `--permission-mode dontAsk` plus `--settings`, Codex gets the nearest `--sandbox`. Deny wins. Configure via `doucopy settings` or the `restrictions` object in `~/.doucopy/config.json`.

- `restrictions.fs_write`: `workspace_only` (default) or `custom` with extra `allow` folders.
- `restrictions.fs_read.deny`: extra read-blocked paths. `~/.ssh`, `~/.aws`, and `~/.doucopy` secrets/sibling workspaces are always denied (not a blanket `~/.doucopy/**`).
- `restrictions.shell`: `off` (default), `deny_patterns`, or `open`.
- Missing `restrictions` means the safe default (workspace writes only, shell off).

**Hard answer filter (deterministic).** Redaction runs in the daemon after the LLM finishes (`daemon/src/redact.ts`). Nothing the model says can bypass it.

- Prefer the `## Never reveal` section in `~/.doucopy/policy.md` (literals and `/regex/` bullets).
- Legacy `redact.literals` / `redact.patterns` in `config.json` still work and merge with policy.
- Built-in patterns always on: OpenAI-style `sk-*`, GitHub PATs, AWS access key IDs, Slack tokens, JWTs, PEM private key blocks.
- Every match becomes `[redacted]`.

**Soft topic rules (probabilistic).** The rest of `~/.doucopy/policy.md` is injected into the responder prompt. Good models follow it well, but it is an instruction to an LLM, not a mechanism.

## Which rule belongs where

- "Do not write outside workspace / do not run shell" → `restrictions` (or `doucopy settings` → Restrictions).
- "Never read my finance folder" → `restrictions.fs_read.deny`.
- Exact strings you cannot leak → `## Never reveal` literals (or `redact.literals`).
- Formats you cannot leak → slash-wrapped regex in `## Never reveal` (or `redact.patterns`).
- Shape-of-answer rules ("generalise instead of naming") → top of `policy.md`.
- What the responder should prefer to read first → narrow `memory_sources`.

## Codex limitation

Codex only has coarse `--sandbox` modes. Per-path write allows and shell deny patterns are approximate there. Prefer cursor-agent or claude when you need fine-grained lockdown.

## After changes

```bash
doucopy settings   # guided edit
doucopy restart    # daemon re-reads config.json (policy.md Never reveal applies on the next question without restart)
```

## Verify

- Unit coverage: `daemon/test/permissions.test.ts`, `daemon/test/redact.test.ts`.
- Live Cursor smoke: `make live-smoke-cursor` (default deny Desktop write, then custom allow).
- Red-team battery (side-effect + exfil + prompt-injection): [references/red-team.md](references/red-team.md). Mark pass/fail in [docs/PUBLISH_CHECKLIST.md](../../../docs/PUBLISH_CHECKLIST.md) before publish.
- Threat model: trusted circle, untrusted question. See root `CONTEXT.md` and `docs/adr/0001-trusted-circle-untrusted-question.md`.

## Common mistakes

- Trusting `policy.md` alone for hard secrets or tool bans.
- Expecting Codex to honour a Desktop write allow the same way Cursor does.
- Forgetting `doucopy restart` after editing `restrictions` or `responder.model` / `persona`.
- Publishing without a green PUBLISH_CHECKLIST (bar C).
