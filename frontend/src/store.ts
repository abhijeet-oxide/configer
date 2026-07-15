import { create } from "zustand";
import { setApiRepo } from "./api";
import type { BrandKey, FontScale, Mode } from "./theme";

// The active repository survives reloads; the API client is kept in sync so
// every repo-scoped call goes to the selected configuration.
//
// Views are deep-linked in the URL query string so any state is shareable:
//   ?app=<repoId>&view=<section>&param=<id>&inst=<name>
// The URL takes precedence over the remembered repo on first load, and the
// store keeps the URL in sync as the user navigates (back/forward work too).
const url = new URLSearchParams(window.location.search);
const urlRepo = url.get("app");
const initialRepo = urlRepo || localStorage.getItem("configer.repoId");
setApiRepo(initialRepo);
const initialSection = url.get("view") || (urlRepo ? "overview" : "workspace");
const initialParam = url.get("param");
const initialInstance = url.get("inst");

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
  /** instance whose column is highlighted in the grid */
  selectedInstance: string | null;
  compareLeft: string | null;
  compareRight: string | null;
  search: string;
  filters: RowFilters;
  prefs: ViewPrefs;
  navCollapsed: boolean;
  /** focus mode: maximize just the Configuration workspace (hide the nav rail
   *  and header), an in-app "editor fullscreen" scoped to the editor only */
  editorFocus: boolean;
  /** file or folder prefix the Import wizard should focus on (set by the
   *  Repository Changes inbox when jumping into an import) */
  importFocus: string | null;
  /** one-shot navigation request: scroll the grid to a parameter row or an
   *  instance column and flash-highlight it (n makes repeats re-trigger) */
  jump: { kind: "param" | "instance"; id: string; n: number } | null;
  /** one-shot handoff: the change request Approvals should select on open
   *  (set by Release history's "Review" action, cleared once consumed) */
  reviewCrId: number | null;
  setMode: (m: Mode) => void;
  setBrand: (b: BrandKey) => void;
  setFontScale: (f: FontScale) => void;
  setRepo: (id: string | null) => void;
  setSection: (s: string) => void;
  setCategory: (k: string | null) => void;
  selectParam: (id: string | null) => void;
  selectInstance: (name: string | null) => void;
  setCompare: (left: string | null, right: string | null) => void;
  setSearch: (q: string) => void;
  setFilters: (f: Partial<RowFilters>) => void;
  setPrefs: (p: Partial<ViewPrefs>) => void;
  setNavCollapsed: (c: boolean) => void;
  setEditorFocus: (f: boolean) => void;
  setImportFocus: (f: string | null) => void;
  setJump: (kind: "param" | "instance", id: string) => void;
  setReviewCr: (id: number | null) => void;
}

export const useUI = create<UIState>((set) => ({
  mode: (localStorage.getItem("configer.mode") as Mode) || "light",
  brand: (localStorage.getItem("configer.brand") as BrandKey) || "configer",
  fontScale: (localStorage.getItem("configer.fontScale") as FontScale) || "normal",
  repoId: initialRepo,
  section: initialSection,
  categoryKey: null,
  selectedParamId: initialParam,
  selectedInstance: initialInstance,
  compareLeft: null,
  compareRight: null,
  search: "",
  filters: { invalidOnly: false, overriddenOnly: false, hideNA: false },
  prefs: loadPrefs(),
  navCollapsed: false,
  editorFocus: false,
  importFocus: null,
  jump: null,
  reviewCrId: null,
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
      selectedInstance: null,
      compareLeft: null,
      compareRight: null,
      jump: null,
      importFocus: null,
    });
  },
  setSection: (section) => set({ section }),
  setCategory: (categoryKey) => set({ categoryKey }),
  selectParam: (selectedParamId) => set({ selectedParamId }),
  selectInstance: (selectedInstance) => set({ selectedInstance }),
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
  setEditorFocus: (editorFocus) => set({ editorFocus }),
  setImportFocus: (importFocus) => set({ importFocus }),
  setJump: (kind, id) => set((s) => ({ jump: { kind, id, n: (s.jump?.n ?? 0) + 1 } })),
  setReviewCr: (reviewCrId) => set({ reviewCrId }),
}));

// ------------------------------------------------------------------ URL sync

// Serialize the shareable slice of state into a query string. Only the fields
// that identify "which view am I looking at" are encoded; transient UI (search
// text, filters, focus) is intentionally left out so links stay clean.
function queryFor(s: UIState): string {
  const q = new URLSearchParams();
  if (s.repoId) q.set("app", s.repoId);
  if (s.section && s.section !== "workspace") q.set("view", s.section);
  if (s.selectedParamId) q.set("param", s.selectedParamId);
  if (s.selectedInstance) q.set("inst", s.selectedInstance);
  return q.toString();
}

// A "navigation" (a distinct Back/Forward stop) is a change of application or
// view. Selecting a parameter/instance or toggling the files view refines the
// current view in place, so those update the URL without pushing a history
// entry, otherwise Back would step through every row click instead of returning
// to the previous view.
function navKey(s: UIState): string {
  return `${s.repoId ?? ""}|${s.section}`;
}
let lastQuery = queryFor(useUI.getState());
let lastNavKey = navKey(useUI.getState());
useUI.subscribe((s) => {
  const q = queryFor(s);
  if (q === lastQuery) return;
  lastQuery = q;
  const next = q ? `${window.location.pathname}?${q}` : window.location.pathname;
  const nk = navKey(s);
  if (nk !== lastNavKey) {
    lastNavKey = nk;
    window.history.pushState(null, "", next); // real navigation: Back returns here
  } else {
    window.history.replaceState(null, "", next); // in-view refinement: no history noise
  }
});

// Browser back/forward: re-read the URL and apply it to the store. Switching
// repositories still routes through setApiRepo so repo-scoped calls follow.
window.addEventListener("popstate", () => {
  const p = new URLSearchParams(window.location.search);
  const repoId = p.get("app") || null;
  const section = p.get("view") || (repoId ? "overview" : "workspace");
  const selectedParamId = p.get("param");
  const selectedInstance = p.get("inst");
  lastQuery = p.toString();
  lastNavKey = `${repoId ?? ""}|${section}`;
  if (repoId !== useUI.getState().repoId) {
    setApiRepo(repoId);
    if (repoId) localStorage.setItem("configer.repoId", repoId);
  }
  useUI.setState({ repoId, section, selectedParamId, selectedInstance });
});
