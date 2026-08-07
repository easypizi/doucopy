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
