import { describe, expect, it } from "vitest";
import {
  DELIVERY_CHIP,
  LIVE_SPIN,
  deliveryFromPhase,
  formatDeliveryChip,
  formatLiveDeliveryChip,
} from "../src/tui/delivery-chip.js";

describe("delivery chip", () => {
  it("maps relay phase to delivery without special fonts", () => {
    expect(deliveryFromPhase("queued")).toBe("queued");
    expect(deliveryFromPhase("working")).toBe("answering");
    expect(deliveryFromPhase(undefined, true)).toBe("offline");
    expect(formatDeliveryChip("queued")).toBe("○ queued");
    expect(formatDeliveryChip("answering")).toBe("● answering");
    expect(formatDeliveryChip("done")).toBe("✓ done");
    expect(formatDeliveryChip("error")).toBe("× error");
  });

  it("uses BMP glyphs only (no private-use / nerd-font range)", () => {
    for (const chip of Object.values(DELIVERY_CHIP)) {
      const code = chip.glyph.codePointAt(0)!;
      expect(code).toBeLessThan(0xe000);
    }
    for (const glyph of LIVE_SPIN) {
      expect(glyph.codePointAt(0)!).toBeLessThan(0xe000);
    }
  });

  it("formats live chip with spinner frame and elapsed seconds", () => {
    const startedAt = 1_000_000;
    expect(
      formatLiveDeliveryChip("answering", { tick: 0, startedAt, now: startedAt + 12_400 }),
    ).toBe("● answering 12s");
    expect(
      formatLiveDeliveryChip("answering", { tick: 1, startedAt, now: startedAt + 12_400 }),
    ).toBe("◐ answering 12s");
    expect(formatLiveDeliveryChip("done")).toBe("✓ done");
    expect(formatLiveDeliveryChip("sending", { tick: 2, startedAt, now: startedAt })).toBe(
      "○ sending",
    );
  });
});
