import type { AskDelivery } from "../chat-history.js";
import { theme } from "./theme.js";

/**
 * Status chip for Chat ASK rows.
 * Glyphs are basic Unicode Geometric Shapes / math signs available in
 * Menlo, SF Mono, Cascadia Mono, Consolas — no Nerd Font / Powerline needed.
 */
export const DELIVERY_CHIP: Record<
  AskDelivery,
  { glyph: string; label: string; color: (typeof theme)[keyof typeof theme] }
> = {
  sending: { glyph: "·", label: "sending", color: theme.dim },
  queued: { glyph: "○", label: "queued", color: theme.dim },
  offline: { glyph: "◌", label: "offline", color: theme.warn },
  answering: { glyph: "●", label: "answering", color: theme.warn },
  done: { glyph: "✓", label: "done", color: theme.ok },
  error: { glyph: "×", label: "error", color: theme.err },
};

/** Geometric spinner frames (no Nerd Font required). */
export const LIVE_SPIN = ["●", "◐", "○", "◑"] as const;

export function deliveryFromPhase(
  phase: string | undefined,
  offline = false,
): AskDelivery {
  if (offline) return "offline";
  if (phase === "working") return "answering";
  return "queued";
}

export function formatDeliveryChip(delivery: AskDelivery): string {
  const { glyph, label } = DELIVERY_CHIP[delivery];
  return label ? `${glyph} ${label}` : glyph;
}

export function isLiveDelivery(delivery: AskDelivery): boolean {
  return delivery === "sending" || delivery === "queued" || delivery === "answering";
}

/**
 * Live waiting chip: rotating glyph + label + elapsed seconds.
 * tick advances every ~500ms while Chat has in-flight asks.
 */
export function formatLiveDeliveryChip(
  delivery: AskDelivery,
  opts: { tick?: number; startedAt?: number; now?: number } = {},
): string {
  if (!isLiveDelivery(delivery)) return formatDeliveryChip(delivery);
  const { label } = DELIVERY_CHIP[delivery];
  const tick = opts.tick ?? 0;
  const glyph = LIVE_SPIN[Math.abs(tick) % LIVE_SPIN.length]!;
  const now = opts.now ?? Date.now();
  const startedAt = opts.startedAt;
  const elapsed =
    typeof startedAt === "number" && startedAt > 0
      ? Math.max(0, Math.floor((now - startedAt) / 1000))
      : 0;
  return elapsed > 0 ? `${glyph} ${label} ${elapsed}s` : `${glyph} ${label}`;
}
