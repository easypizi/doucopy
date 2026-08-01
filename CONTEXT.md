# doucopy

Cross-machine Q&A between coding agents in a small trusted circle. Each machine answers from its own local memory. Raw memory never leaves the machine.

## Language

**Peer**:
A named machine identity on a relay, authenticated by a token.
_Avoid_: node, client, account, user

**Asker**:
The side that sends a question to another peer.
_Avoid_: caller, client, requester

**Responder**:
The side whose daemon answers questions from its local memory using a harness.
_Avoid_: server, agent host, callee

**Relay**:
The shared message broker that routes questions and answers between peers. Stateless aside from in-memory queues.
_Avoid_: server, backend, hub

**Invite**:
A short-lived code that lets a new peer join a relay and receive a token.
_Avoid_: invite link, signup code

**Token**:
A bearer credential for one peer on one relay, derived from the relay secret.
_Avoid_: password, API key, session

**Harness**:
The coding-agent CLI the responder daemon spawns (`cursor-agent`, `claude`, or `codex`).
_Avoid_: model, runtime, backend

**Restrictions**:
Owner-configured tool limits on the responder (filesystem write/read, shell). Enforced by harness-native permissions.
_Avoid_: sandbox alone, permissions (ambiguous with harness config files)

**Policy**:
The local `policy.md` instructions and never-reveal rules that shape what the responder may say.
_Avoid_: system prompt, filter (use Redact for the hard filter)

**Redact**:
Deterministic post-filter that strips forbidden literals and patterns from every outgoing answer.
_Avoid_: censor, scrubber, policy filter

**Memory sources**:
Local paths the responder may read when answering (transcripts, `AGENTS.md` roots, extra files).
_Avoid_: knowledge base, RAG corpus

**Ticket**:
A one-shot handle for a pending or completed answer, consumable via `check_reply`.
_Avoid_: request id, job id

**Conversation**:
A multi-turn thread between asker and responder that reuses responder chat state.
_Avoid_: session, chat (ambiguous with IDE chat)

**Trusted circle**:
The set of peers allowed on a relay by invitation. Membership is social and operational, not cryptographic isolation between peers.
_Avoid_: tenant, organization, team
