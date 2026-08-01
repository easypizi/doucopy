# agent-link v2.1: Claude Code and Codex harnesses

Status: draft, 2026-07-27. Owner: agent-link.

## Goal

Let a machine act as an agent-link responder using something other than `cursor-agent`, and let a machine that uses Claude Code or OpenAI Codex participate as an asker without also installing Cursor. Cursor stays the default. This spec covers the runner abstraction, the per-harness invocation, and the MCP wiring for each side.

Non-goals for v2.1: Windsurf, Aider, or JetBrains AI. OAuth flows for Codex remote MCP (only bearer tokens). Nested harnesses on the same machine (one responder harness per machine).

## Terminology

- **Harness**: the local coding-agent CLI on a machine (`cursor-agent`, `claude`, `codex`).
- **Session**: the harness-native identifier of a running conversation with the model. Persisted between turns so the responder can resume.
- **Responder harness**: which harness the daemon spawns for each incoming question.
- **Asker harness**: the harness the human uses interactively; needs an MCP-server entry pointing at the relay.

## Responder side

### 2.1 Runner interface

Replace [daemon/src/runner.ts](../../../daemon/src/runner.ts) with a `Harness` interface:

```ts
export interface HarnessOptions {
  binary: string;
  workspaceDir: string;
  timeoutMs: number;
  model?: string;
  extraArgs?: string[];
}

export interface Harness {
  createSession(opts: HarnessOptions): Promise<string>;
  runTask(opts: HarnessOptions, sessionId: string, task: string): Promise<{ answer?: string; error?: string }>;
}
```

Three implementations behind `createHarness(kind, config)`:

| kind | binary default | createSession | runTask |
|---|---|---|---|
| `cursor-agent` | `cursor-agent` | `cursor-agent create-chat`, take first stdout line as chat id (current logic, keep the `killTree` hack) | `cursor-agent --resume <id> -p "<task-instruction>" --output-format text --trust --force --workspace <dir> [--model X]` |
| `claude` | `claude` | run `claude -p --output-format json "init"` in workspace, parse `session_id` from the final JSON message, or use `claude --session-id <uuid>` and generate one ourselves | `claude -p --bare --resume <id> --output-format text --input-format text --model <model> "<task>"` piping the task to stdin |
| `codex` | `codex` | on first turn, do NOT create a session up front; the first `runTask` call is a plain `codex exec` (no `resume`) that returns a session id we scrape from stdout / `~/.codex/sessions/*.jsonl` (newest by mtime, cwd=workspaceDir) | on later turns: `codex exec resume <id> --skip-git-repo-check --sandbox workspace-write "<task>"` |

Notes:

- Claude Code supports `--session-id <uuid>` for external session control; we generate a uuidv7 and pass it, so we don't need to parse a returned id. Confirm on install (`claude --help | grep session-id`), fall back to parsing if the flag is absent.
- Codex resume finds sessions in `$CODEX_HOME/sessions/`. Daemon must set `CODEX_HOME=~/.agent-link/codex-home` per machine to keep agent-link sessions isolated from the user's interactive Codex history. The per-conversation workspace becomes `cwd` so Codex writes rollout files there.
- `--output-format text` for both: no JSON parsing needed on the daemon side, and it lines up with cursor-agent behaviour.
- `--bare` on Claude Code disables hooks and skill walks, which is what we want for a headless responder. It requires `ANTHROPIC_API_KEY`. If the user has OAuth-only auth, fall back to plain `-p` and document the cost.
- Codex has no `--print` equivalent that keeps the process attached indefinitely; `codex exec` exits when the model finishes. That means we do NOT need the cursor-agent `killTree` grandchild hack for Codex.

### 2.2 Config schema

[daemon/src/config.ts](../../../daemon/src/config.ts) additions:

```ts
export interface DaemonConfig {
  // ...existing fields
  responder: {
    harness?: "cursor-agent" | "claude" | "codex"; // default "cursor-agent"
    binary?: string;                                // default: harness name
    // legacy alias, only read if `binary` is unset:
    cursor_agent_binary?: string;
    workspace_dir: string;
    response_timeout_seconds: number;
    max_concurrent?: number;
    model?: string;
    extra_args?: string[];
  };
}
```

Validation: `harness` must be one of the three literals, `binary` is optional (if unset, use the harness name and PATH lookup). Keep backward compat by reading `cursor_agent_binary` when `binary` is missing and `harness === "cursor-agent"`.

### 2.3 Session store

[daemon/src/conversations.ts](../../../daemon/src/conversations.ts) already stores arbitrary strings. Nothing to change.

### 2.4 Test fixtures

Add `daemon/test/fixtures/fake-claude.sh` and `fake-codex.sh` matching the fake-cursor-agent contract (log invoked args, emit a deterministic session id on first call, emit `STUB ANSWER` on subsequent calls). Use them in a new `harness.test.ts` that exercises `createHarness("claude")` and `createHarness("codex")` with the same expectations as the current cursor-agent tests.

## Asker side (MCP client config)

`agent-link join` currently writes only `~/.cursor/mcp.json`. Extend to write, on best-effort basis, every asker MCP config the machine has:

### 3.1 Cursor (unchanged)

`~/.cursor/mcp.json`, structure already handled by `mergeMcpJson` in [cli/src/setup.ts](../../../cli/src/setup.ts).

### 3.2 Claude Code

Two options, pick one at implementation time:

**A. CLI (preferred if available):**

```bash
claude mcp add agent-link --transport http https://<relay>/mcp --header "Authorization=Bearer <token>"
```

Detect availability: `claude mcp --help` (from v2.x, exit code 0 means supported). Non-interactive, and Claude writes to its own settings file.

**B. Direct file write:**

`~/.claude.json` (user scope) or a project `.mcp.json`. Structure:

```json
{
  "mcpServers": {
    "agent-link": {
      "type": "http",
      "url": "https://<relay>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Same merge/backup discipline as `mergeMcpJson`.

### 3.3 Codex

`~/.codex/config.toml`, streamable HTTP transport uses `url` + either `bearer_token_env_var` or `http_headers`:

```toml
[mcp_servers.agent-link]
url = "https://<relay>/mcp"
bearer_token = "<token>"
```

We prefer inline `bearer_token` (Codex reads it into memory, does not store token elsewhere) so a user can move the whole file to a new machine without extra env setup. On write, back up existing file to `config.toml.bak` and only replace the `[mcp_servers.agent-link]` block via a TOML parser (`@iarna/toml` npm dep). If TOML parse fails, error out with a clear message instead of overwriting.

## CLI wiring changes

[cli/src/setup.ts](../../../cli/src/setup.ts): add `detectHarnesses(home)` returning `{ cursor: boolean, claude: boolean, codex: boolean }` (checks via `which claude` / `which codex` + presence of `~/.cursor`). Add `mergeClaudeMcp(home, relayUrl, token)` and `mergeCodexToml(home, relayUrl, token)`. Wire into [cli/src/join.ts](../../../cli/src/join.ts):

1. Detect harnesses.
2. Ask user which harness runs as the responder (default: whatever detection finds; if multiple, prompt with `AskQuestion`-style stdin). Write to `responder.harness` in config.
3. Merge MCP config into each detected asker (Cursor + Claude + Codex, whichever are present). Print a summary line per touched file.

For `agent-link status`, add a `harness` field to the printed section so it is easy to see what the daemon will spawn.

## Migration / compatibility

- Existing configs without `harness` default to `cursor-agent`. No user action needed on upgrade.
- Existing configs with `cursor_agent_binary` are still read (validated in `config.ts`).
- Existing MCP entries in Cursor keep working since v2 already wrote them.

## Rollout order

1. Implement runner abstraction with cursor-agent and fake harnesses. All existing tests must still pass.
2. Add Claude harness + fake test.
3. Add Codex harness + fake test.
4. Extend `join` to configure Claude and Codex MCP entries when detected.
5. Write end-user docs (README + `agent-link-setup` skill) once real e2e is done on each harness.

## Open questions

- Codex `--sandbox workspace-write` vs `--sandbox danger-full-access`: pick the least permissive that still lets the responder read `~/.cursor/projects/*/agent-transcripts/*.jsonl`. Verify at implementation time.
- Claude Code `--bare` availability across installed versions. If widely absent, drop it and accept slower cold start.
- Whether to force `--model` for Claude and Codex or let them use their default. Cursor uses `composer-2.5`; Claude Sonnet Sonnet default is fine, Codex `gpt-5-codex` default is fine. Ship without `--model` and add it later if needed.
