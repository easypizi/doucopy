import { afterEach, describe, expect, it } from "vitest";
import {
  editInputHistory,
  emptyInputHistory,
  getSessionInputHistory,
  getSessionLiveValue,
  pushInputHistory,
  resetSessionInputHistory,
  setSessionInputHistory,
  setSessionLiveValue,
  stepInputHistory,
} from "../src/tui/input-history.js";

afterEach(() => {
  resetSessionInputHistory();
});

describe("input-history", () => {
  it("pushes submitted lines, skips empty and consecutive dupes, caps length", () => {
    let s = emptyInputHistory();
    s = pushInputHistory(s, "  hello  ");
    s = pushInputHistory(s, "hello");
    s = pushInputHistory(s, "");
    s = pushInputHistory(s, "/wipe");
    expect(s.entries).toEqual(["hello", "/wipe"]);
    expect(s.index).toBeNull();

    for (let i = 0; i < 105; i += 1) {
      s = pushInputHistory(s, `line-${i}`);
    }
    expect(s.entries).toHaveLength(100);
    expect(s.entries[0]).toBe("line-5");
    expect(s.entries[99]).toBe("line-104");
  });

  it("↑/↓ browse history and restore draft like readline", () => {
    let s = pushInputHistory(pushInputHistory(emptyInputHistory(), "one"), "two");
    let r = stepInputHistory(s, "up", "draft-here");
    expect(r.value).toBe("two");
    expect(r.state.draft).toBe("draft-here");
    expect(r.state.index).toBe(1);

    r = stepInputHistory(r.state, "up", r.value);
    expect(r.value).toBe("one");
    expect(r.state.index).toBe(0);

    r = stepInputHistory(r.state, "up", r.value);
    expect(r.value).toBe("one");
    expect(r.state.index).toBe(0);

    r = stepInputHistory(r.state, "down", r.value);
    expect(r.value).toBe("two");

    r = stepInputHistory(r.state, "down", r.value);
    expect(r.value).toBe("draft-here");
    expect(r.state.index).toBeNull();
  });

  it("manual edit while browsing exits browse mode", () => {
    let s = pushInputHistory(emptyInputHistory(), "sent");
    const browsed = stepInputHistory(s, "up", "wip");
    s = editInputHistory(browsed.state, "wip-edited");
    expect(s.index).toBeNull();
    expect(s.draft).toBe("wip-edited");
    expect(s.entries).toEqual(["sent"]);
  });

  it("↓ on live line is a no-op; ↑ with empty history is a no-op", () => {
    const empty = emptyInputHistory();
    expect(stepInputHistory(empty, "up", "x")).toEqual({ state: empty, value: "x" });
    const live = pushInputHistory(empty, "a");
    expect(stepInputHistory(live, "down", "x").value).toBe("x");
    expect(stepInputHistory(live, "down", "x").state.index).toBeNull();
  });

  it("module session store survives round-trip (tab remount)", () => {
    const hist = pushInputHistory(emptyInputHistory(), "/ask");
    setSessionInputHistory(hist);
    setSessionLiveValue("draft-wip");
    expect(getSessionInputHistory().entries).toEqual(["/ask"]);
    expect(getSessionLiveValue()).toBe("draft-wip");
  });
});
