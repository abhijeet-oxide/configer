import { create } from "zustand";
import { setApiRepo } from "./api";
import type { BrandKey, FontScale, Mode } from "./theme";

// ------------------------------------------------------------------ routing
// Sections that belong to ONE application (rendered as tabs on the
// Configuration page). "overview" is the default tab and has no URL slug.
const APP_SECTIONS_SET = new Set([
  "overview", "config", "compare", "changes", "drafts", "approvals", "instances", "files", "drift", "import",
]);
// Section <-> URL slug. Overview is intentionally absent: it is the default
// tab, so its path is just /application/<id> with no suffix.
const SECTION_TO_SLUG: Record<string, string> = {
  config: "editor",
  files: "files",
  compare: "compare",
  changes: "history",
  approvals: "approvals",
  instances: "instances",
  drift: "repository-changes",
  import: "import",
};
const SLUG_TO_SECTION: Record<string, string> = Object.fromEntries(
  Object.entries(SECTION_TO_SLUG).map(([s, slug]) => [slug, s]),
);

// parseLocation reads the current path + query into a view. A path-named app
// wins; otherwise a legacy ?app=&view= link resolves; otherwise it is the
// portfolio. repoId is null only when the location does not name an app (the
// caller falls back to the remembered repository).
function parseLocation(): { repoId: string | null; section: string; param: string | null; inst: string | null } {
  const p = new URLSearchParams(window.location.search);
  const param = p.get("param");
  const inst = p.get("inst");
  const legacyApp = p.get("app");
  if (legacyApp) return { repoId: legacyApp, section: p.get("view") || "overview", param, inst };

  const segs = window.location.pathname.split("/").filter(Boolean);
  if (segs[0] === "application" && segs[1]) {
    const slug = segs[2];
    const section = slug ? SLUG_TO_SECTION[slug] ?? "overview" : "overview";
    return { repoId: decodeURIComponent(segs[1]), section, param, inst };
  }
  if (segs[0] === "plugins") return { repoId: null, section: "plugins", param, inst };
  return { repoId: null, section: "workspace", param, inst };
}

// The active repository survives reloads; the API client is kept in sync so
// every repo-scoped call goes to the selected configuration.
//
// URLs are path-based and human-readable so any view is shareable:
//   /overview                    the applications portfolio (no app selected)
//   /application/<id>            one application, Overview (the default tab)
//   /application/<id>/<tab>      a specific tab (editor, files, compare, …)
//   /plugins                     the plugins admin surface
// A selected parameter/instance rides in the query string (?param=&inst=) as a
// refinement of the current view. Legacy ?app=&view= links still resolve.
const parsed0 = parseLocation();
const initialRepo = parsed0.repoId || localStorage.getItem("configer.repoId");
setApiRepo(initialRepo);
const initialSection = parsed0.section;
const initialParam = parsed0.param;
const initialInstance = parsed0.inst;

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

// Which editor panels are open (true) vs quick-collapsed. Persisted so the
// workspace shape survives reloads.
export interface PanelsOpen {
  left: boolean;
  right: boolean;
  systems: boolean;
}

const defaultPanels: PanelsOpen = { left: true, right: true, systems: true };

function loadPanels(): PanelsOpen {
  try {
    const raw = localStorage.getItem("configer.panels");
    if (raw) return { ...defaultPanels, ...JSON.parse(raw) };
  } catch {
    // corrupted prefs: fall back to defaults
  }
  return defaultPanels;
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
  /** editor panel visibility: quick-collapse for the left parameter tree,
   *  the right details panel, and the systems pane (bottom of the tree) */
  panels: PanelsOpen;
  /** one-shot navigation request: scroll the grid to a parameter row, an
   *  instance column, or one cell (kind "cell": id=paramId, inst=instance)
   *  and flash-highlight it (n makes repeats re-trigger) */
  jump: { kind: "param" | "instance" | "cell"; id: string; inst?: string; n: number } | null;
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
  togglePanel: (which: keyof PanelsOpen) => void;
  setImportFocus: (f: string | null) => void;
  setJump: (kind: "param" | "instance" | "cell", id: string, inst?: string) => void;
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
  panels: loadPanels(),
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
  togglePanel: (which) =>
    set((s) => {
      const panels = { ...s.panels, [which]: !s.panels[which] };
      localStorage.setItem("configer.panels", JSON.stringify(panels));
      return { panels };
    }),
  setImportFocus: (importFocus) => set({ importFocus }),
  setJump: (kind, id, inst) => set((s) => ({ jump: { kind, id, inst, n: (s.jump?.n ?? 0) + 1 } })),
  setReviewCr: (reviewCrId) => set({ reviewCrId }),
}));

// ------------------------------------------------------------------ URL sync

// pathFor serializes the shareable slice of state into a path (+ optional
// ?param=&inst= refinement). Transient UI (search, filters, focus) is left out
// so links stay clean.
function pathFor(s: UIState): string {
  const q = new URLSearchParams();
  if (s.selectedParamId) q.set("param", s.selectedParamId);
  if (s.selectedInstance) q.set("inst", s.selectedInstance);
  const qs = q.toString() ? `?${q.toString()}` : "";

  const section = s.section === "drafts" ? "changes" : s.section;
  if (section === "plugins") return `/plugins${qs}`;
  // Portfolio level: the application never appears in the URL.
  if (section === "workspace" || section === "home" || !s.repoId) return `/overview${qs}`;
  if (APP_SECTIONS_SET.has(section)) {
    const slug = SECTION_TO_SLUG[section]; // undefined for overview -> default tab
    return `/application/${encodeURIComponent(s.repoId)}${slug ? `/${slug}` : ""}${qs}`;
  }
  return `/overview${qs}`;
}

// A "navigation" (a distinct Back/Forward stop) is a change of application or
// view. Selecting a parameter/instance refines the current view in place, so
// those update the URL without pushing a history entry, otherwise Back would
// step through every row click instead of returning to the previous view.
function navKey(s: UIState): string {
  return `${s.repoId ?? ""}|${s.section === "drafts" ? "changes" : s.section}`;
}
let lastPath = pathFor(useUI.getState());
let lastNavKey = navKey(useUI.getState());
// Canonicalize the initial URL (root "/" -> "/overview", and legacy
// ?app=&view= links -> the path form) without adding a history entry.
window.history.replaceState(null, "", lastPath);
useUI.subscribe((s) => {
  const next = pathFor(s);
  if (next === lastPath) return;
  lastPath = next;
  const nk = navKey(s);
  if (nk !== lastNavKey) {
    lastNavKey = nk;
    window.history.pushState(null, "", next); // real navigation: Back returns here
  } else {
    window.history.replaceState(null, "", next); // in-view refinement: no history noise
  }
});

// Browser back/forward: re-read the URL and apply it to the store. A location
// that does not name an application (the portfolio) keeps the remembered
// repository in state so switching back into it still works — it just isn't in
// the URL. Switching repositories still routes through setApiRepo.
window.addEventListener("popstate", () => {
  const loc = parseLocation();
  const current = useUI.getState();
  const repoId = loc.repoId ?? current.repoId; // portfolio: keep the active repo
  lastPath = pathFor({ ...current, ...loc, repoId } as UIState);
  lastNavKey = `${repoId ?? ""}|${loc.section === "drafts" ? "changes" : loc.section}`;
  if (repoId !== current.repoId) {
    setApiRepo(repoId);
    if (repoId) localStorage.setItem("configer.repoId", repoId);
  }
  useUI.setState({ repoId, section: loc.section, selectedParamId: loc.param, selectedInstance: loc.inst });
});
