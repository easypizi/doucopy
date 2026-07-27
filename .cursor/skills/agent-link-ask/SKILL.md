---
name: agent-link-ask
description: "Use when asking another machine's agent something via agent-link (ask_peer, list_peers, check_reply MCP tools). Covers picking a peer, writing a self-contained question, choosing timeout_seconds, handling all four response statuses, follow-ups via conversation_id, and recovering timed-out answers with check_reply. Do NOT use when running inside ~/.agent-link/workspace — you are the responder there, use agent-link-answer."
---

# agent-link: asking side

You are on the **asking** side of an agent-link pair. Your job is to formulate a question the other machine's agent can answer from its own memory, dispatch it via the `ask_peer` MCP tool, and interpret the reply.

## Guard: are you actually the asker?

If your current working directory is `~/.agent-link/workspace`, you are the **responder** launched by the local daemon. Stop and switch to `agent-link-answer`. Never call `ask_peer` from inside that workspace — you would ask yourself.

## Workflow

1. **Pick a peer.** Call `list_peers`. Only online peers can answer immediately; offline ones will get the question when they come back but you won't get a synchronous reply.
2. **Write a self-contained question.** The responder does not share your chat context, files, or open editor. Include the timeframe, product, and any names it needs. No pronouns without antecedents.
3. **Choose `timeout_seconds`.** Default is 120s, max 240s. Set higher (180-240) if the responder must grep many months of transcripts; keep at default for simple lookups.
4. **Call `ask_peer`.** Save both `ticket_id` and `conversation_id` from the reply.
5. **Interpret the status** (table below).
6. **Follow up in the same thread** by passing the same `conversation_id` on the next `ask_peer` call. The responder resumes the same `cursor-agent` chat, so it remembers the prior turn without you restating context.

## Response statuses

| status | fields | what it means | what to do |
|---|---|---|---|
| `answered` | `answer`, `ticket_id`, `conversation_id` | responder finished, answer inside `answer` | present it; keep `conversation_id` for follow-ups |
| `error` | `error`, `ticket_id`, `conversation_id` | responder or relay produced an error (e.g. `"cursor-agent failed: ..."`, `"unknown peer: ..."`, `"expired"`, `"overflow"`) | show the error to the user, do not retry silently |
| `pending` | `ticket_id`, `conversation_id` | ask timed out but the question is still in flight | wait, then `check_reply(ticket_id)`; the ticket lives 24h |
| `peer_offline` | `ticket_id`, `conversation_id` | responder hasn't long-polled for over 60s | the question is queued (max 100 per peer); tell the user and give them the `ticket_id` so they can retrieve it later |

## `check_reply` semantics

- Reads once. After a successful `answered` or `error` read, the ticket is consumed and future calls return `unknown_ticket`.
- Save the answer before doing anything else.
- 24-hour retention. After that, `unknown_ticket`.
- Also returns `unknown_ticket` if the relay was restarted (in-memory storage).

## Do not

- Do not paste large files or transcripts into the question. The responder has its own memory sources.
- Do not chain multiple unrelated questions in one `ask_peer` call — one question per ticket. Use `conversation_id` for related follow-ups.
- Do not retry `ask_peer` on `pending`. It creates a duplicate ticket. Use `check_reply` instead.
- Do not assume the responder shares your policy view. It has its own `policy.md`; if it refuses or generalises, that is intentional.

## Costs

The responding machine pays for its own `cursor-agent` tokens on every question. Don't ask idly.

## Counter-questions from the responder

Since v2.1 the responder may fire back a clarifying question at you via `ask_peer` with `hops=1` and the same `conversation_id`. Your local daemon answers it from **your** memory sources, not from a live chat. So:

- Keep your own transcripts and AGENTS.md in `~/.agent-link/config.json`, otherwise the counter-question will get a useless answer.
- Depth is capped: `hops` can only be 0 (initial) or 1 (counter). No infinite ping-pong.
- Each conversation is capped at 4 open tickets simultaneously (relay returns `too many open tickets` if you spam it).
- The counter-question cycle eats into your `timeout_seconds` budget. If you set 120s and the counter-question itself waits 60s, you have 60s left for the final answer. Increase `timeout_seconds` to 240s if you expect a counter-question.
