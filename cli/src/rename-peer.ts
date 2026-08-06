import { joinRelay, requestInvite } from "./api.js";
import { pushHistory } from "./field-history.js";
import {
  detectAskers,
  mergeClaudeMcp,
  mergeCodexToml,
  mergeMcpJson,
  writeConfig,
} from "./setup.js";
import type { DoucopyConfigFile } from "./settings.js";

export interface RenamePeerDeps {
  requestInvite?: typeof requestInvite;
  joinRelay?: typeof joinRelay;
  writeConfig?: typeof writeConfig;
  detectAskers?: typeof detectAskers;
  mergeMcpJson?: typeof mergeMcpJson;
  mergeClaudeMcp?: typeof mergeClaudeMcp;
  mergeCodexToml?: typeof mergeCodexToml;
  pushHistory?: typeof pushHistory;
}

export interface RenamePeerResult {
  peer: string;
  token: string;
  config: DoucopyConfigFile;
}

/**
 * Rename this machine's peer. Mints a short-lived invite with the current
 * token (any joined peer can POST /invite), then rejoins under the new name.
 * Optional `invite` skips minting (manual fallback).
 */
export async function renamePeer(
  home: string,
  config: DoucopyConfigFile,
  newName: string,
  opts: { invite?: string } & RenamePeerDeps = {},
): Promise<RenamePeerResult> {
  const name = newName.trim();
  const relayUrl = config.relay_url;
  const token = config.token;
  if (!relayUrl) throw new Error("missing relay_url");
  if (!token && !opts.invite) throw new Error("missing token (cannot mint invite)");

  const requestInviteFn = opts.requestInvite ?? requestInvite;
  const joinRelayFn = opts.joinRelay ?? joinRelay;
  const writeConfigFn = opts.writeConfig ?? writeConfig;
  const detectAskersFn = opts.detectAskers ?? detectAskers;
  const mergeMcpJsonFn = opts.mergeMcpJson ?? mergeMcpJson;
  const mergeClaudeMcpFn = opts.mergeClaudeMcp ?? mergeClaudeMcp;
  const mergeCodexTomlFn = opts.mergeCodexToml ?? mergeCodexToml;
  const pushHistoryFn = opts.pushHistory ?? pushHistory;

  let invite = opts.invite?.trim();
  if (!invite) {
    const minted = await requestInviteFn(relayUrl, token!, 1);
    invite = minted.invite;
  }

  const joined = await joinRelayFn(relayUrl, invite, name);
  const next: DoucopyConfigFile = {
    ...config,
    self_peer: joined.peer,
    token: joined.token,
  };
  writeConfigFn(home, next);

  const askers = detectAskersFn(home);
  if (askers.cursor) mergeMcpJsonFn(home, relayUrl, joined.token);
  if (askers.claude) mergeClaudeMcpFn(home, relayUrl, joined.token);
  if (askers.codex) mergeCodexTomlFn(home, relayUrl, joined.token);
  pushHistoryFn(home, { peer_name: joined.peer, relay_url: relayUrl });

  return { peer: joined.peer, token: joined.token, config: next };
}
