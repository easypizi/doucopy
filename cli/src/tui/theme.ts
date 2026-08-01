import { createRequire } from "node:module";

/** Doucopy Ink palette. Respects NO_COLOR via Ink's color support. */
export const theme = {
  accent: "cyan",
  brand: "cyanBright",
  ok: "green",
  warn: "yellow",
  err: "red",
  dim: "gray",
  highlight: "whiteBright",
  tabActiveBg: "cyan",
  tabActiveFg: "black",
  border: "cyan",
  borderDim: "gray",
} as const;

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const APP_VERSION = readVersion();
