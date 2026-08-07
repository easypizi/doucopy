import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface KeyCaptureApi {
  /** True while any text field / wizard capture is active. */
  captured: boolean;
  begin: () => void;
  end: () => void;
}

const KeyCaptureContext = createContext<KeyCaptureApi | null>(null);

export function KeyCaptureProvider({ children }: { children: ReactNode }) {
  const depth = useRef(0);
  const [captured, setCaptured] = useState(false);
  const begin = useCallback(() => {
    depth.current += 1;
    setCaptured(true);
  }, []);
  const end = useCallback(() => {
    depth.current = Math.max(0, depth.current - 1);
    setCaptured(depth.current > 0);
  }, []);
  const api = useMemo(() => ({ captured, begin, end }), [captured, begin, end]);
  return <KeyCaptureContext.Provider value={api}>{children}</KeyCaptureContext.Provider>;
}

export function useKeyCapture(): KeyCaptureApi {
  const ctx = useContext(KeyCaptureContext);
  if (!ctx) {
    return {
      captured: false,
      begin: () => undefined,
      end: () => undefined,
    };
  }
  return ctx;
}

/** Hold letter-hotkey capture for the lifetime of the calling component (or while active). */
export function useHoldKeyCapture(active = true): void {
  const { begin, end } = useKeyCapture();
  useEffect(() => {
    if (!active) return;
    begin();
    return () => end();
  }, [active, begin, end]);
}
