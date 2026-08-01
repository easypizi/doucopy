# Trusted circle, untrusted question

doucopy is for a small invited circle of machines, not multi-tenant SaaS. We treat every peer token holder as socially trusted, but every inbound question as untrusted input that may try side effects or exfiltration.

**Decision:** defend with local responder controls (restrictions, redact, policy, invite/revoke). Do not promise protection against a malicious peer that already holds a valid token.

**Rejected:** hostile-peer threat model (would require hard isolation and ACL on the relay) and full SaaS controls (persistence, per-tenant auth, audit). Those are a different product.

**Consequences:** README and privacy docs must say this explicitly. Red-team focuses on compromised-asker probes, not peer impersonation beyond revoke/rotate.
