// A tiny isolated store for the palette's open state, so any surface (the
// toolbar button, a keyboard shortcut, a future "search this" affordance) can
// open it without threading props or bloating the main UI store.
import { create } from "zustand";
import type { SearchScope } from "./types";

interface SearchOpenState {
  open: boolean;
  /** the surface the palette opened on; the palette may still offer a toggle */
  mode: SearchScope;
  openSearch: (mode?: SearchScope) => void;
  close: () => void;
  /** open on `mode`, or close if already open (the Cmd/Ctrl-K behavior) */
  toggle: (mode?: SearchScope) => void;
}

export const useSearchOpen = create<SearchOpenState>((set) => ({
  open: false,
  mode: "global",
  openSearch: (mode = "global") => set({ open: true, mode }),
  close: () => set({ open: false }),
  toggle: (mode = "global") => set((s) => (s.open ? { open: false } : { open: true, mode })),
}));
