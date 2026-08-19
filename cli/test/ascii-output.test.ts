import { describe, expect, it, vi } from "vitest";
import {
  applyAsciiOutputMode,
  asciiFold,
  asciiModeEnabled,
  installAsciiFold,
} from "../src/ascii-output.js";
import { CHIP_LEGEND, DELIVERY_CHIP, LIVE_SPIN } from "../src/tui/delivery-chip.js";

const NON_ASCII = /[^\x00-\x7F]/;

describe("asciiFold", () => {
  it("folds every chip glyph and spinner frame", () => {
    for (const chip of Object.values(DELIVERY_CHIP)) {
      expect(asciiFold(chip.glyph)).not.toMatch(NON_ASCII);
    }
    for (const frame of LIVE_SPIN) {
      expect(asciiFold(frame)).not.toMatch(NON_ASCII);
    }
    expect(asciiFold(CHIP_LEGEND)).not.toMatch(NON_ASCII);
  });

  it("folds box drawing used by Ink round and single borders", () => {
    expect(asciiFold("╭──╮")).toBe("+--+");
    expect(asciiFold("│ x │")).toBe("| x |");
    expect(asciiFold("╰──╯")).toBe("+--+");
    expect(asciiFold("┌─┐└─┘")).toBe("+-++-+");
  });

  it("keeps replacements one character wide so layout does not shift", () => {
    const glyphs = "●○◌◐◑✓×·…—←→↑↓╭─│";
    expect([...asciiFold(glyphs)]).toHaveLength([...glyphs].length);
  });

  it("leaves ANSI escapes, ASCII and Cyrillic text alone", () => {
    expect(asciiFold("\u001B[36mplain text\u001B[39m")).toBe("\u001B[36mplain text\u001B[39m");
    expect(asciiFold("Вопрос от пира")).toBe("Вопрос от пира");
  });
});

describe("asciiModeEnabled", () => {
  it("accepts 1, true and yes only", () => {
    expect(asciiModeEnabled({ DOUCOPY_ASCII: "1" })).toBe(true);
    expect(asciiModeEnabled({ DOUCOPY_ASCII: "TRUE" })).toBe(true);
    expect(asciiModeEnabled({ DOUCOPY_ASCII: " yes " })).toBe(true);
    expect(asciiModeEnabled({ DOUCOPY_ASCII: "0" })).toBe(false);
    expect(asciiModeEnabled({})).toBe(false);
  });
});

describe("installAsciiFold", () => {
  it("folds string chunks, passes buffers through, and can be undone", () => {
    const written: unknown[] = [];
    const stream = {
      write: (chunk: unknown) => {
        written.push(chunk);
        return true;
      },
    };
    const undo = installAsciiFold(stream);
    stream.write("● answering");
    const buf = Buffer.from("● raw");
    stream.write(buf);
    undo();
    stream.write("● answering");
    expect(written).toEqual(["* answering", buf, "● answering"]);
  });

  it("applyAsciiOutputMode is a no-op unless the env asks for it", () => {
    const sink = vi.fn().mockReturnValue(true);
    const stream = { write: sink };
    expect(applyAsciiOutputMode({}, [stream])).toBe(false);
    stream.write("●");
    expect(sink).toHaveBeenLastCalledWith("●");

    expect(applyAsciiOutputMode({ DOUCOPY_ASCII: "1" }, [stream])).toBe(true);
    stream.write("●");
    expect(sink).toHaveBeenLastCalledWith("*");
  });
});
