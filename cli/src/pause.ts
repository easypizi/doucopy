function parseForSpec(spec: string, now: number = Date.now()): number {
  const match = spec.match(/^(\d+)(s|m|h|d)$/);
  if (!match) throw new Error(`--for must look like 90s, 15m, 2h, or 1d, got: ${spec}`);
  const n = Number(match[1]);
  const unit = match[2];
  const seconds = unit === "s" ? n : unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400;
  return now + seconds * 1000;
}

export interface PauseFlags {
  forSpec?: string;
  until?: string;
}

export async function runPause(peer: string, flags: PauseFlags): Promise<void> {
  if (flags.forSpec && flags.until) throw new Error("use either --for or --until, not both");
  let untilMs: number | null = null;
  if (flags.forSpec) untilMs = parseForSpec(flags.forSpec);
  else if (flags.until) {
    const parsed = Date.parse(flags.until);
    if (Number.isNaN(parsed)) throw new Error(`--until must be an ISO timestamp, got: ${flags.until}`);
    untilMs = parsed;
  }
  const { pausePeer } = await import("../../daemon/dist/paused.js");
  pausePeer(peer, untilMs);
  if (untilMs === null) console.log(`paused ${peer} indefinitely`);
  else console.log(`paused ${peer} until ${new Date(untilMs).toISOString()}`);
}

export async function runResume(peer: string): Promise<void> {
  const { resumePeer } = await import("../../daemon/dist/paused.js");
  const changed = resumePeer(peer);
  console.log(changed ? `resumed ${peer}` : `${peer} was not paused`);
}
