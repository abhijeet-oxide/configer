// Platform detection for keyboard-hint labels. Most of our users are on
// Windows, so shortcut hints must read "Ctrl", not the Mac command glyph;
// on a Mac we show the familiar symbols. The actual key handlers accept both
// metaKey and ctrlKey regardless - this only affects what the UI displays.

const nav = typeof navigator !== "undefined" ? navigator : undefined;
const ua = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;

export const isMac = /Mac|iPhone|iPad|iPod/i.test(ua);

/** The label for the primary modifier: "⌘" on macOS, "Ctrl" elsewhere. */
export const modLabel = isMac ? "⌘" : "Ctrl";

/** A full shortcut hint, e.g. "Ctrl K" on Windows or "⌘K" on macOS. */
export function shortcut(key: string): string {
  return isMac ? `${modLabel}${key}` : `${modLabel} ${key}`;
}
