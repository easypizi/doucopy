import { createHash, timingSafeEqual } from "node:crypto";

export interface PeerRegistry {
  peers(): string[];
  peerForToken(token: string): string | null;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function loadPeersFromEnv(env: NodeJS.ProcessEnv = process.env): PeerRegistry {
  const hashes = new Map<string, Buffer>();
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^PEER_TOKEN_(.+)$/);
    if (match && value) hashes.set(match[1].toLowerCase(), sha256(value));
  }
  if (hashes.size === 0) throw new Error("no PEER_TOKEN_* variables configured");
  return {
    peers: () => [...hashes.keys()],
    peerForToken(token: string): string | null {
      const candidate = sha256(token);
      for (const [peer, hash] of hashes) {
        if (timingSafeEqual(candidate, hash)) return peer;
      }
      return null;
    },
  };
}

export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}
