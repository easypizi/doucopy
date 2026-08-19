---
name: doucopy-ask
description: "Use when asking another machine's agent something via doucopy (ask_peer, list_peers, check_reply MCP tools). Covers picking a peer, writing a self-contained question, waiting out pending with check_reply (silent poll / long-poll), handling all response statuses, follow-ups via conversation_id, and Claude Code / MCP host abort quirks. When running inside ~/.doucopy/workspace you are the responder, use doucopy-answer for the general workflow — the only exception is a single counter-question (see Guard)."
---

# doucopy: asking side

You are on the **asking** side of a doucopy pair. Your job is to formulate a question the other machine's agent can answer from its own memory, dispatch it via the `ask_peer` MCP tool, and **deliver the final answer** (not stop at `pending`).

## Guard: are you actually the asker?

If your current working directory is under `~/.doucopy/workspace`, you are the **responder** launched by the local daemon. The default answer is: switch to `doucopy-answer` and do NOT call `ask_peer`.

There is exactly one exception. If, and only if, you need a clarifying fact from the asker to answer their question, you may make a **single** counter-question call:

- `ask_peer` with **`hops: 1`**, targeting the peer named in the prompt as the asker.
- **`conversation_id`** must be exactly the one supplied in your task prompt. Never invent one.
- **One counter-question per turn.** After it settles, answer the original question. Do not loop.
- Anything else from this workspace (a second counter-question, `hops: 0`, a different `conversation_id`, or asking a third party) is forbidden and will be rejected server-side.

## Workflow

1. **Pick a peer.** Call `list_peers`. Only online peers can answer immediately; offline ones will get the question when they come back but you won't get a synchronous reply.
2. **Write a self-contained question.** The responder does not share your chat context, files, or open editor. Include the timeframe, product, and any names it needs. No pronouns without antecedents.
3. **Call `ask_peer`.** Save both `ticket_id` and `conversation_id`. Optional: `mode: "discuss"` and `brief` (short instructions for the responder agent).
4. **Wait until settled** using the protocol below. Do not hand a bare `pending` back to the user as if the task were done.
5. **Follow up in the same thread** by passing the same `conversation_id` on the next `ask_peer` call. The responder resumes the same agent chat, so it remembers the prior turn without you restating context.

## Discuss mode (`mode: "discuss"`)

Use **discuss** when you need several collaborative turns with the peer agent before answering the human. Use default **ask** for a one-shot Q&A.

### When to pick discuss

- You need the peer to dig, compare, or iterate before a usable answer.
- You will reformulate based on what they return.
- A single self-contained question would waste a turn or produce a half-answer.

### When to stay on ask

- One clear question, one clear answer is enough.
- You already know exactly what to ask.
- Discuss costs more tokens on the responding machine. Prefer ask when possible.

### How to run discuss

1. Stay on **one** `conversation_id` for the whole thread. Cap: **4 open tickets** per conversation (same as ask).
2. Pass a short `brief` when the peer needs process instructions (what to check, tone, constraints, what to ignore). Do **not** dump your full chat into `brief` (relay trims to 2000 chars).
3. Keep `question` as the concrete ask for this turn. `brief` is meta-instructions for the responder agent, not the user question.
4. Reformulate and continue until you can produce a **FINAL** answer for the human.
5. Do **not** dump intermediate agent chatter as the user-visible reply. Compact status lines are fine ("discussing…"). Only the FINAL goes to the user.
6. Responder may still use one counter-question per ticket (`hops: 1`) when needed.
7. Every discuss turn still needs the waiting protocol below (`check_reply` until settled). Do not hand a mid-thread reply to the human as if the task were done.

TUI Chat also has `/discuss` / `/di` for the same mode. MCP path is `mode: "discuss"`.

## Waiting for the answer (mandatory)

Many MCP hosts (Claude Code especially) **abort long tool calls after a few seconds**. Then `ask_peer` returns `pending` even while the peer is still working. That is normal, not a failure.

**Do this every time** for an online peer (or when the user asked you to wait for the answer):

1. Prefer a **short** first wait: `ask_peer(..., timeout_seconds: 15)`.
2. If status is `answered` or `error` → show the user. Done.
3. If status is `pending` → **immediately** call `check_reply` with `wait_seconds: 180` (up to 240). Do not ask permission.
4. If still `pending` → call `check_reply` again with `wait_seconds: 180`. Repeat until `answered`, `error`, `unknown_ticket`, or ~10 minutes wall time.
5. **Stay silent toward the user while polling.** No "still pending", no "want me to check?". Only speak when you have a final result, or when the budget is exhausted.

If the user said something like "send the answer when they reply" / "check until they answer" / "don't spam me", that means: silent loop above, one message when done.

### Offline peers

On `peer_offline`: tell the user once that the question is queued, give `ticket_id`. If they asked you to wait for the answer anyway, enter the same silent `check_reply` loop (longer gaps are fine). Do not re-`ask_peer`.

## Response statuses

| status | fields | what it means | what to do |
|---|---|---|---|
| `answered` | `answer`, `ticket_id`, `conversation_id` | responder finished | present it; keep `conversation_id` for follow-ups |
| `error` | `error`, `ticket_id`, `conversation_id` | responder or relay error | show the error, do not retry silently |
| `pending` | `ticket_id`, `conversation_id` | still in flight (timeout, host abort, or peer slow) | silent `check_reply` with `wait_seconds` (see above). Ticket lives 24h |
| `peer_offline` | `ticket_id`, `conversation_id` | responder hasn't long-polled for over 60s | question is queued; tell user once, or silent-poll if they asked to wait |
| `unknown_ticket` | `ticket_id` | already consumed, expired, or relay restarted | stop. Tell the user the ticket is gone |

## `check_reply` semantics

- Optional `wait_seconds` (0–240). Default `0` = instant read. Prefer `180` when finishing a pending ask.
- Reads once on `answered` / `error`. After that, future calls return `unknown_ticket`.
- Save the answer before doing anything else.
- 24-hour retention. Also `unknown_ticket` if the relay was restarted (in-memory storage).

## Attachments (optional)

Pass small UTF-8 text files via `ask_peer(..., attachments: [{ name, content }, ...])`.

- Basename only: `[A-Za-z0-9._-]`, max 128 chars. No path separators.
- Max 5 files, 256 KiB each, 512 KiB total.
- Responder finds them under `inbox/<name>` in its conversation workspace. Do not paste large file bodies into `question`.
- Asker → responder only. There is no attachment field on answers.
- Offline peers queue in relay memory, so there is a 4 MiB cap on attachment bytes waiting for one peer. On `too many queued attachment bytes`, wait for that peer to drain its inbox or ask without files.
- The responder needs a recent doucopy. If a peer answers as if there were no files, its machine is on an older version.

## Remote actions through plain questions

There is no separate action tool. If the peer owner loosened restrictions (`doucopy settings`), a normal `ask_peer` question can ask the remote agent to edit files or run shell commands. If the owner kept the safe default (workspace-only writes, shell off), the remote harness denies those tools. The answer then typically says the action is blocked, or you see a tool/permission error string inside `error` / `answer`. Treat that as intentional owner policy, not a transport failure.

## Do not

- Do not paste large files or transcripts into the question. Prefer `attachments` for small UTF-8 text, or let the responder use its own memory sources.
- Do not chain multiple unrelated questions in one `ask_peer` call — one question per ticket. Use `conversation_id` for related follow-ups.
- Do not retry `ask_peer` on `pending`. It creates a duplicate ticket. Use `check_reply` instead.
- Do not ask the user whether to continue polling after `pending`. Just poll.
- Do not narrate every pending poll to the user.
- Do not assume the responder shares your policy view. It has its own `policy.md` and `restrictions`. If it refuses, generalises, or reports a permission deny, that is intentional.

## Costs

The responding machine pays for its own agent tokens on every question. Don't ask idly.

## Counter-questions from the responder

Since v2.1 the responder may fire back a clarifying question at you via `ask_peer` with `hops=1` and the same `conversation_id`. Your local daemon answers it from **your** memory sources, not from a live chat. So:

- Keep your own transcripts and AGENTS.md in `~/.doucopy/config.json`, otherwise the counter-question will get a useless answer.
- Depth is capped: `hops` can only be 0 (initial) or 1 (counter). No infinite ping-pong.
- Each conversation is capped at 4 open tickets simultaneously (relay returns `too many open tickets` if you spam it).
- The counter-question cycle eats into your wait budget. Prefer finishing with `check_reply` `wait_seconds: 180–240` if you expect a counter-question.
