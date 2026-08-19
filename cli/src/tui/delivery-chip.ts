import type { AskDelivery } from "../chat-history.js";
import { theme } from "./theme.js";

/**
 * Status chip for Chat ASK rows.
 * Glyphs are basic Unicode Geometric Shapes / math signs available in
 * Menlo, SF Mono, Cascadia Mono, Consolas — no Nerd Font / Powerline needed.
 * Live waiting uses spinner + optional elapsed seconds only (no word labels).
 */
export const DELIVERY_CHIP: Record<
  AskDelivery,
  { glyph: string; color: (typeof theme)[keyof typeof theme] }
> = {
  sending: { glyph: "·", color: theme.dim },
  queued: { glyph: "○", color: theme.dim },
  offline: { glyph: "◌", color: theme.warn },
  answering: { glyph: "●", color: theme.warn },
  done: { glyph: "✓", color: theme.ok },
  error: { glyph: "×", color: theme.err },
};

/** Footer legend: glyph-only chips need a key somewhere on screen. */
export const CHIP_LEGEND = "● answering · ○ queued · ◌ offline · ✓ done · × error";

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
  return DELIVERY_CHIP[delivery].glyph;
}

export function isLiveDelivery(delivery: AskDelivery): boolean {
  return delivery === "sending" || delivery === "queued" || delivery === "answering";
}

/**
 * Live waiting chip: rotating glyph + elapsed seconds (no word labels).
 * tick advances every ~500ms while Chat has in-flight asks.
 */
export function formatLiveDeliveryChip(
  delivery: AskDelivery,
  opts: { tick?: number; startedAt?: number; now?: number } = {},
): string {
  if (!isLiveDelivery(delivery)) return formatDeliveryChip(delivery);
  const tick = opts.tick ?? 0;
  const glyph = LIVE_SPIN[Math.abs(tick) % LIVE_SPIN.length]!;
  const now = opts.now ?? Date.now();
  const startedAt = opts.startedAt;
  const elapsed =
    typeof startedAt === "number" && startedAt > 0
      ? Math.max(0, Math.floor((now - startedAt) / 1000))
      : 0;
  return elapsed > 0 ? `${glyph} ${elapsed}s` : glyph;
}
