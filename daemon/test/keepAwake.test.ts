import { describe, expect, it, vi } from "vitest";
import {
  ensureInitialConfirmation,
  graceExpired,
  keepAwakeTick,
  needsConfirmPrompt,
  type KeepAwakeState,
} from "../src/keepAwake.js";
import { DEFAULT_KEEP_AWAKE, resolveKeepAwake } from "../src/config.js";

const DAY = 24 * 60 * 60 * 1000;

describe("resolveKeepAwake", () => {
  it("defaults to enabled with 3-day confirm", () => {
    expect(resolveKeepAwake(undefined)).toEqual(DEFAULT_KEEP_AWAKE);
  });

  it("allows disabling confirm with confirm_days 0", () => {
    expect(resolveKeepAwake({ enabled: true, confirm_days: 0 }).confirm_days).toBe(0);
  });
});

describe("keepAwake decisions", () => {
  it("seeds confirmed_at on first run", () => {
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    const state = ensureInitialConfirmation(null, now);
    expect(state.confirmed_at).toBe("2026-08-01T12:00:00.000Z");
  });

  it("needs confirm after confirm_days", () => {
    const settings = resolveKeepAwake({ enabled: true, confirm_days: 3 });
    const confirmed = Date.parse("2026-08-01T00:00:00.000Z");
    const state: KeepAwakeState = { confirmed_at: new Date(confirmed).toISOString() };
    expect(needsConfirmPrompt(settings, state, confirmed + 3 * DAY - 1)).toBe(false);
    expect(needsConfirmPrompt(settings, state, confirmed + 3 * DAY)).toBe(true);
  });

  it("does not prompt when confirm_days is 0", () => {
    const settings = resolveKeepAwake({ enabled: true, confirm_days: 0 });
    const state: KeepAwakeState = { confirmed_at: "2020-01-01T00:00:00.000Z" };
    expect(needsConfirmPrompt(settings, state, Date.now())).toBe(false);
  });

  it("expires grace after confirm_grace_hours", () => {
    const settings = resolveKeepAwake({ confirm_grace_hours: 24 });
    const shown = Date.parse("2026-08-01T00:00:00.000Z");
    const state: KeepAwakeState = {
      confirmed_at: "2026-07-01T00:00:00.000Z",
      awaiting_confirm: true,
      prompt_shown_at: new Date(shown).toISOString(),
    };
    expect(graceExpired(settings, state, shown + 24 * 60 * 60 * 1000 - 1)).toBe(false);
    expect(graceExpired(settings, state, shown + 24 * 60 * 60 * 1000)).toBe(true);
  });
});

describe("keepAwakeTick", () => {
  it("stops after grace without an answer", async () => {
    const stop = vi.fn();
    const shown = "2026-08-01T00:00:00.000Z";
    let state: KeepAwakeState = {
      confirmed_at: "2026-07-01T00:00:00.000Z",
      awaiting_confirm: true,
      prompt_shown_at: shown,
    };
    const result = await keepAwakeTick(
      resolveKeepAwake({ enabled: true, confirm_days: 3, confirm_grace_hours: 24 }),
      {
        now: () => Date.parse(shown) + 24 * 60 * 60 * 1000,
        readState: () => state,
        writeState: (s) => { state = s; },
        stopDaemon: stop,
        askConfirm: async () => "keep",
        log: () => {},
      },
    );
    expect(result).toBe("stop");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("resets timer when user keeps running", async () => {
    const stop = vi.fn();
    let state: KeepAwakeState = { confirmed_at: "2026-07-01T00:00:00.000Z" };
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    const result = await keepAwakeTick(
      resolveKeepAwake({ enabled: true, confirm_days: 3 }),
      {
        now: () => now,
        readState: () => state,
        writeState: (s) => { state = s; },
        stopDaemon: stop,
        askConfirm: async () => "keep",
        log: () => {},
      },
    );
    expect(result).toBe("continue");
    expect(stop).not.toHaveBeenCalled();
    expect(state.awaiting_confirm).toBe(false);
    expect(Date.parse(state.confirmed_at)).toBe(now);
  });

  it("stops when user declines", async () => {
    const stop = vi.fn();
    let state: KeepAwakeState = { confirmed_at: "2026-07-01T00:00:00.000Z" };
    const result = await keepAwakeTick(
      resolveKeepAwake({ enabled: true, confirm_days: 3 }),
      {
        now: () => Date.parse("2026-08-01T12:00:00.000Z"),
        readState: () => state,
        writeState: (s) => { state = s; },
        stopDaemon: stop,
        askConfirm: async () => "stop",
        log: () => {},
      },
    );
    expect(result).toBe("stop");
    expect(stop).toHaveBeenCalledOnce();
  });
});
