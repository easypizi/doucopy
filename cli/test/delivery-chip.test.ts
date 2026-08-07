import { describe, expect, it } from "vitest";
import { DELIVERY_CHIP, deliveryFromPhase, formatDeliveryChip } from "../src/tui/delivery-chip.js";

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
  });
});
