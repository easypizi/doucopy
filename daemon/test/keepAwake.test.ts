import { describe, expect, it, vi } from "vitest";
import {
  WINDOWS_TASK_NAME,
  applyWindowsStayAwake,
  ensureInitialConfirmation,
  graceExpired,
  keepAwakeTick,
  needsConfirmPrompt,
  parseMessageBoxChoice,
  stopWindowsScheduledTask,
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

  it("treats dialog cancel as keep and resets timer", async () => {
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

  it("leaves awaiting on unavailable then stops after grace on next tick", async () => {
    const stop = vi.fn();
    let state: KeepAwakeState = { confirmed_at: "2026-07-01T00:00:00.000Z" };
    const shown = Date.parse("2026-08-01T12:00:00.000Z");
    const first = await keepAwakeTick(
      resolveKeepAwake({ enabled: true, confirm_days: 3, confirm_grace_hours: 24 }),
      {
        now: () => shown,
        readState: () => state,
        writeState: (s) => { state = s; },
        stopDaemon: stop,
        askConfirm: async () => "unavailable",
        waitMs: async () => new Promise(() => {}),
        log: () => {},
      },
    );
    expect(first).toBe("continue");
    expect(stop).not.toHaveBeenCalled();
    expect(state.awaiting_confirm).toBe(true);

    const second = await keepAwakeTick(
      resolveKeepAwake({ enabled: true, confirm_days: 3, confirm_grace_hours: 24 }),
      {
        now: () => shown + 24 * 60 * 60 * 1000,
        readState: () => state,
        writeState: (s) => { state = s; },
        stopDaemon: stop,
        askConfirm: async () => "keep",
        log: () => {},
      },
    );
    expect(second).toBe("stop");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops when grace elapses while askConfirm is still open", async () => {
    const stop = vi.fn();
    const cancelAsk = vi.fn();
    let state: KeepAwakeState = { confirmed_at: "2026-07-01T00:00:00.000Z" };
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    const result = await keepAwakeTick(
      resolveKeepAwake({ enabled: true, confirm_days: 3, confirm_grace_hours: 24 }),
      {
        now: () => now,
        readState: () => state,
        writeState: (s) => { state = s; },
        stopDaemon: stop,
        askConfirm: () => new Promise(() => {}),
        waitMs: async () => {},
        cancelAsk,
        log: () => {},
      },
    );
    expect(result).toBe("stop");
    expect(stop).toHaveBeenCalledOnce();
    expect(cancelAsk).toHaveBeenCalledOnce();
  });

  it("invokes stayAwake each tick when provided", async () => {
    const stayAwake = vi.fn();
    let state: KeepAwakeState = { confirmed_at: "2026-08-01T00:00:00.000Z" };
    await keepAwakeTick(resolveKeepAwake({ enabled: true, confirm_days: 0 }), {
      now: () => Date.parse("2026-08-01T12:00:00.000Z"),
      readState: () => state,
      writeState: (s) => { state = s; },
      stayAwake,
      log: () => {},
    });
    expect(stayAwake).toHaveBeenCalledOnce();
  });
});

describe("Windows keep_awake helpers", () => {
  it("parseMessageBoxChoice maps Yes/No/Cancel", () => {
    expect(parseMessageBoxChoice("Yes")).toBe("keep");
    expect(parseMessageBoxChoice("keep")).toBe("keep");
    expect(parseMessageBoxChoice("No")).toBe("stop");
    expect(parseMessageBoxChoice("stop")).toBe("stop");
    expect(parseMessageBoxChoice("Cancel")).toBe("keep");
    expect(parseMessageBoxChoice("")).toBe("unavailable");
  });

  it("applyWindowsStayAwake runs the SetThreadExecutionState script", () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    expect(applyWindowsStayAwake(run)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    const script = String(run.mock.calls[0]?.[0] ?? "");
    expect(script).toContain("SetThreadExecutionState");
    expect(script).toContain("0x80000041");
  });

  it("stopWindowsScheduledTask ends and deletes the doucopy task", () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    stopWindowsScheduledTask(run);
    expect(run).toHaveBeenCalledWith(["/End", "/TN", WINDOWS_TASK_NAME]);
    expect(run).toHaveBeenCalledWith(["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
  });
});
