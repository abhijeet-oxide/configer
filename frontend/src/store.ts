import { create } from "zustand";
import { setApiRepo } from "./api";
import type { BrandKey, FontScale, Mode } from "./theme";

// The active repository survives reloads; the API client is kept in sync so
// every repo-scoped call goes to the selected configuration.
const initialRepo = localStorage.getItem("configer.repoId");
setApiRepo(initialRepo);

// View preferences persisted across sessions (the "customizable view").
export interface ViewPrefs {
  density: "compact" | "comfortable";
  showTypeCol: boolean;
  showScopeCol: boolean;
  showDescCol: boolean;
  showCompare: boolean;
}

const defaultPrefs: ViewPrefs = {
  density: "compact",
  showTypeCol: true,
  showScopeCol: true,
  showDescCol: true,
  showCompare: true,
};

function loadPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem("configer.viewPrefs");
    if (raw) return { ...defaultPrefs, ...JSON.parse(raw) };
  } catch {
    // corrupted prefs: fall back to defaults
  }
  return defaultPrefs;
}

// Row filters applied by the grid toolbar's Filter dropdown.
export interface RowFilters {
  invalidOnly: boolean;
  overriddenOnly: boolean;
  hideNA: boolean;
}

interface UIState {
  mode: Mode;
  brand: BrandKey;
  fontScale: FontScale;
  /** the active repository (workspace entry id); null until the workspace
   *  loads, then always set while any repository is connected */
  repoId: string | null;
  section: string;
  categoryKey: string | null;
  selectedParamId: string | null;
  compareLeft: string | null;
  compareRight: string | null;
  search: string;
  filters: RowFilters;
  prefs: ViewPrefs;
  navCollapsed: boolean;
  /** file or folder prefix the Import wizard should focus on (set by the
   *  Repository Changes inbox when jumping into an import) */
  importFocus: string | null;
  /** one-shot navigation request: scroll the grid to a parameter row or an
   *  instance column and flash-highlight it (n makes repeats re-trigger) */
  jump: { kind: "param" | "instance"; id: string; n: number } | null;
  setMode: (m: Mode) => void;
  setBrand: (b: BrandKey) => void;
  setFontScale: (f: FontScale) => void;
  setRepo: (id: string | null) => void;
  setSection: (s: string) => void;
  setCategory: (k: string | null) => void;
  selectParam: (id: string | null) => void;
  setCompare: (left: string | null, right: string | null) => void;
  setSearch: (q: string) => void;
  setFilters: (f: Partial<RowFilters>) => void;
  setPrefs: (p: Partial<ViewPrefs>) => void;
  setNavCollapsed: (c: boolean) => void;
  setImportFocus: (f: string | null) => void;
  setJump: (kind: "param" | "instance", id: string) => void;
}

export const useUI = create<UIState>((set) => ({
  mode: (localStorage.getItem("configer.mode") as Mode) || "light",
  brand: (localStorage.getItem("configer.brand") as BrandKey) || "configer",
  fontScale: (localStorage.getItem("configer.fontScale") as FontScale) || "normal",
  repoId: initialRepo,
  section: "workspace",
  categoryKey: null,
  selectedParamId: null,
  compareLeft: null,
  compareRight: null,
  search: "",
  filters: { invalidOnly: false, overriddenOnly: false, hideNA: false },
  prefs: loadPrefs(),
  navCollapsed: false,
  importFocus: null,
  jump: null,
  setMode: (mode) => {
    localStorage.setItem("configer.mode", mode);
    set({ mode });
  },
  setBrand: (brand) => {
    localStorage.setItem("configer.brand", brand);
    set({ brand });
  },
  setFontScale: (fontScale) => {
    localStorage.setItem("configer.fontScale", fontScale);
    set({ fontScale });
  },
  setRepo: (repoId) => {
    if (repoId) localStorage.setItem("configer.repoId", repoId);
    else localStorage.removeItem("configer.repoId");
    setApiRepo(repoId);
    // Everything below is state of ONE configuration; switching repositories
    // must not leak a selection, comparison or pending jump across.
    set({
      repoId,
      categoryKey: null,
      selectedParamId: null,
      compareLeft: null,
      compareRight: null,
      jump: null,
      importFocus: null,
    });
  },
  setSection: (section) => set({ section }),
  setCategory: (categoryKey) => set({ categoryKey }),
  selectParam: (selectedParamId) => set({ selectedParamId }),
  setCompare: (compareLeft, compareRight) => set({ compareLeft, compareRight }),
  setSearch: (search) => set({ search }),
  setFilters: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
  setPrefs: (p) =>
    set((s) => {
      const prefs = { ...s.prefs, ...p };
      localStorage.setItem("configer.viewPrefs", JSON.stringify(prefs));
      return { prefs };
    }),
  setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
  setImportFocus: (importFocus) => set({ importFocus }),
  setJump: (kind, id) => set((s) => ({ jump: { kind, id, n: (s.jump?.n ?? 0) + 1 } })),
}));
