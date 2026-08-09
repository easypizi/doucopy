/** Session-local readline-style input history for Chat TUI. */

export const INPUT_HISTORY_CAP = 100;

export interface InputHistoryState {
  /** Submitted lines, oldest → newest. */
  entries: string[];
  /** null = editing the live line (not browsing). */
  index: number | null;
  /** Stashed live value when leaving via ↑. */
  draft: string;
}

export function emptyInputHistory(): InputHistoryState {
  return { entries: [], index: null, draft: "" };
}

/** Survives ChatScreen unmount when switching TUI tabs. */
let sessionHist: InputHistoryState = emptyInputHistory();
let sessionLiveValue = "";

export function getSessionInputHistory(): InputHistoryState {
  return sessionHist;
}

export function setSessionInputHistory(state: InputHistoryState): void {
  sessionHist = state;
}

export function getSessionLiveValue(): string {
  return sessionLiveValue;
}

export function setSessionLiveValue(value: string): void {
  sessionLiveValue = value;
}

/** Test helper / full reset. */
export function resetSessionInputHistory(): void {
  sessionHist = emptyInputHistory();
  sessionLiveValue = "";
}

export function pushInputHistory(
  state: InputHistoryState,
  line: string,
  cap = INPUT_HISTORY_CAP,
): InputHistoryState {
  const trimmed = line.trim();
  if (!trimmed) {
    return { ...state, index: null, draft: "" };
  }
  const last = state.entries[state.entries.length - 1];
  const entries =
    last === trimmed ? state.entries : [...state.entries, trimmed].slice(-cap);
  return { entries, index: null, draft: "" };
}

/**
 * Step through history. `currentValue` is the TextInput value right now.
 * Returns next state plus the value that should be shown in the input.
 */
export function stepInputHistory(
  state: InputHistoryState,
  dir: "up" | "down",
  currentValue: string,
): { state: InputHistoryState; value: string } {
  const { entries } = state;
  if (entries.length === 0) {
    return { state, value: currentValue };
  }

  if (dir === "up") {
    if (state.index === null) {
      const index = entries.length - 1;
      return {
        state: { entries, index, draft: currentValue },
        value: entries[index]!,
      };
    }
    if (state.index <= 0) {
      return { state, value: currentValue };
    }
    const index = state.index - 1;
    return {
      state: { ...state, index },
      value: entries[index]!,
    };
  }

  // down
  if (state.index === null) {
    return { state, value: currentValue };
  }
  if (state.index >= entries.length - 1) {
    return {
      state: { entries, index: null, draft: "" },
      value: state.draft,
    };
  }
  const index = state.index + 1;
  return {
    state: { ...state, index },
    value: entries[index]!,
  };
}

/** Leave browse mode after manual edits; keep draft in sync with the live line. */
export function editInputHistory(state: InputHistoryState, nextValue: string): InputHistoryState {
  if (state.index === null) {
    return state.draft === nextValue ? state : { ...state, draft: nextValue };
  }
  return { entries: state.entries, index: null, draft: nextValue };
}
