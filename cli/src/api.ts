export interface JoinResult {
  token: string;
  peer: string;
}

export interface InviteResult {
  invite: string;
  expires_at: number;
}

export interface RelayStatus {
  self: string;
  self_online: boolean;
  peers: Array<{ name: string; online: boolean }>;
  incoming_queued: number;
  outgoing: Array<{ ticket_id: string; to_peer: string; status: string; created_at: number }>;
}

export function normalizeRelayUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = `${detail}: ${body.error}`;
    } catch {
      // non-JSON error body, keep the status code only
    }
    throw new Error(`relay request failed (${detail})`);
  }
  return (await res.json()) as T;
}

export async function joinRelay(
  relayUrl: string,
  invite: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JoinResult> {
  return requestJson<JoinResult>(fetchImpl, `${normalizeRelayUrl(relayUrl)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite, name }),
  });
}

export async function requestInvite(
  relayUrl: string,
  token: string,
  ttlHours?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<InviteResult> {
  return requestJson<InviteResult>(fetchImpl, `${normalizeRelayUrl(relayUrl)}/invite`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(ttlHours !== undefined ? { ttl_hours: ttlHours } : {}),
  });
}

export type AskStatus = "answered" | "pending" | "peer_offline" | "error" | "unknown_ticket";

export interface AskResult {
  status: AskStatus;
  ticket_id: string;
  conversation_id: string;
  answer?: string;
  error?: string;
}

export interface ReplyResult {
  status: AskStatus;
  ticket_id: string;
  answer?: string;
  error?: string;
}

export async function askPeer(
  relayUrl: string,
  token: string,
  input: { peer: string; question: string; wait_seconds?: number; conversation_id?: string; hops?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<AskResult> {
  return requestJson<AskResult>(fetchImpl, `${normalizeRelayUrl(relayUrl)}/ask`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function fetchReply(
  relayUrl: string,
  token: string,
  ticketId: string,
  waitSeconds = 0,
  fetchImpl: typeof fetch = fetch,
): Promise<ReplyResult> {
  const url = `${normalizeRelayUrl(relayUrl)}/reply/${encodeURIComponent(ticketId)}?wait=${waitSeconds}`;
  return requestJson<ReplyResult>(fetchImpl, url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function fetchStatus(
  relayUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayStatus> {
  return requestJson<RelayStatus>(fetchImpl, `${normalizeRelayUrl(relayUrl)}/status`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}
