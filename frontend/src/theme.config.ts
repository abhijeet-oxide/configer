// =============================================================================
// Configer brand + theme - THE single file to customize the app's look.
// =============================================================================
// Everything visual is controlled here and applied at BUILD time (it is picked
// up by `npm run dev` and `npm run build` alike). Edit `themeOverrides` below;
// anything you omit falls back to `defaultTheme`, so out of the box the app
// looks exactly as it ships.
//
// This one file drives three layers so they can never drift apart:
//   1. CSS custom properties (:root / [data-theme="dark"]) - generated and
//      inlined into <head> by plugins/vite-plugin-brand.ts (no flash).
//   2. Ant Design tokens - theme.ts reads this config instead of hardcoding.
//   3. Identity - favicon, <title>, sidebar logo and app name.
//
// Keep this file dependency-free: it is imported by both the browser bundle and
// the Node-side Vite plugin.
// -----------------------------------------------------------------------------

/** A full set of themeable colors for one mode (light or dark). */
export interface Palette {
  // Primary (brand) and its variants
  brand: string;
  brandStrong: string; // hover / pressed brand
  brandSoft: string; // tinted fill behind selected/brand surfaces
  brandBorder: string;
  // Secondary accent. Defaults to brandStrong so it is inert until you set it;
  // exposed as var(--secondary) for your own accents.
  secondary: string;
  // Sidebar / navigation rail
  navBg: string;
  navBgHover: string;
  navBgActive: string;
  navFg: string;
  navFgActive: string;
  navBorder: string;
  // Surfaces: canvas (page) < surface (content) < surface2 (raised)
  canvas: string;
  surface: string;
  surface2: string;
  border: string;
  borderStrong: string;
  illSurface: string; // "paper" fill inside the state illustrations
  // Text
  text: string;
  text2: string;
  text3: string;
  // Semantic status triples (foreground / pastel background / border)
  ok: string; okBg: string; okBd: string;
  pending: string; pendingBg: string; pendingBd: string;
  review: string; reviewBg: string; reviewBd: string;
  danger: string; dangerBg: string; dangerBd: string;
  // Cell provenance (base = inherited from shared layer, inherit = neutral)
  base: string; baseBg: string; baseBd: string;
  inherit: string; inheritBg: string; inheritBd: string;
}

export interface BrandConfig {
  /** Product name shown in the sidebar and browser title. */
  appName: string;
  /** Long descriptor used in the browser <title> (after the app name). */
  tagline: string;
  /** Short caption shown under the name in the sidebar. */
  navCaption: string;
  /** Sidebar logo mark: a short text glyph, an inline <svg> string, or a src. */
  logo: { text?: string; svg?: string; src?: string };
  /** Favicon: an emoji, an inline <svg...> string, or a path/URL to a file. */
  favicon: string;
  /** Shape tokens fed to Ant Design. */
  shape: { borderRadius: number; controlHeight: number };
  /** Type tokens fed to Ant Design. */
  type: { fontFamily: string; fontSizeBase: number };
  light: Palette;
  dark: Palette;
  /** Environment identity colors (which environment an instance runs in). */
  envColors: Record<string, string>;
}

// Palette key -> CSS custom property. The names match what index.css / styles.css
// already reference, so nothing downstream changes.
export const VAR_MAP: Array<[keyof Palette, string]> = [
  ["brand", "--brand"], ["brandStrong", "--brand-strong"], ["brandSoft", "--brand-soft"],
  ["brandBorder", "--brand-border"], ["secondary", "--secondary"],
  ["navBg", "--nav-bg"], ["navBgHover", "--nav-bg-hover"], ["navBgActive", "--nav-bg-active"],
  ["navFg", "--nav-fg"], ["navFgActive", "--nav-fg-active"], ["navBorder", "--nav-border"],
  ["canvas", "--canvas"], ["surface", "--surface"], ["surface2", "--surface-2"],
  ["border", "--border"], ["borderStrong", "--border-strong"], ["illSurface", "--ill-surface"],
  ["text", "--text"], ["text2", "--text-2"], ["text3", "--text-3"],
  ["ok", "--c-ok"], ["okBg", "--c-ok-bg"], ["okBd", "--c-ok-bd"],
  ["pending", "--c-pending"], ["pendingBg", "--c-pending-bg"], ["pendingBd", "--c-pending-bd"],
  ["review", "--c-review"], ["reviewBg", "--c-review-bg"], ["reviewBd", "--c-review-bd"],
  ["danger", "--c-danger"], ["dangerBg", "--c-danger-bg"], ["dangerBd", "--c-danger-bd"],
  ["base", "--c-base"], ["baseBg", "--c-base-bg"], ["baseBd", "--c-base-bd"],
  ["inherit", "--c-inherit"], ["inheritBg", "--c-inherit-bg"], ["inheritBd", "--c-inherit-bd"],
];

// -----------------------------------------------------------------------------
// Defaults: the identity Configer ships with. Change values via `themeOverrides`
// below rather than editing these, so you can always diff against the baseline.
// -----------------------------------------------------------------------------
export const defaultTheme: BrandConfig = {
  appName: "Configer",
  tagline: "Configuration Lifecycle Management",
  navCaption: "CONFIG LIFECYCLE",
  // A parameter x instance matrix - the product's core idea - not a letter.
  // Two solid cells on the diagonal, two faded: a grid whose values vary.
  logo: {
    svg:
      "<svg width='18' height='18' viewBox='0 0 20 20' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
      "<rect x='1.5' y='1.5' width='7' height='7' rx='1.9' fill='white'/>" +
      "<rect x='11.5' y='1.5' width='7' height='7' rx='1.9' fill='white' fill-opacity='0.45'/>" +
      "<rect x='1.5' y='11.5' width='7' height='7' rx='1.9' fill='white' fill-opacity='0.45'/>" +
      "<rect x='11.5' y='11.5' width='7' height='7' rx='1.9' fill='white'/></svg>",
  },
  favicon:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
    "<rect width='32' height='32' rx='8' fill='#0057b8'/>" +
    "<g transform='translate(6 6)'>" +
    "<rect x='0' y='0' width='8' height='8' rx='2.2' fill='white'/>" +
    "<rect x='12' y='0' width='8' height='8' rx='2.2' fill='white' fill-opacity='0.45'/>" +
    "<rect x='0' y='12' width='8' height='8' rx='2.2' fill='white' fill-opacity='0.45'/>" +
    "<rect x='12' y='12' width='8' height='8' rx='2.2' fill='white'/></g></svg>",
  shape: { borderRadius: 6, controlHeight: 30 },
  type: {
    fontFamily:
      `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
    fontSizeBase: 13,
  },
  light: {
    brand: "#0057b8", brandStrong: "#004494", brandSoft: "#e8f1fb", brandBorder: "#b2ccea",
    secondary: "#004494",
    navBg: "#0a1f3c", navBgHover: "rgba(255, 255, 255, 0.06)", navBgActive: "#0f62d6",
    navFg: "#b9c6d8", navFgActive: "#ffffff", navBorder: "rgba(255, 255, 255, 0.08)",
    canvas: "#eef1f6", surface: "#ffffff", surface2: "#f7f9fc",
    border: "#e7ebf1", borderStrong: "#d5dbe4", illSurface: "#ffffff",
    text: "#101828", text2: "#475467", text3: "#98a2b3",
    ok: "#067647", okBg: "#e2f6ea", okBd: "#b7e6cb",
    pending: "#b54708", pendingBg: "#fcf1dd", pendingBd: "#f4dda4",
    review: "#0057b8", reviewBg: "#e4eefa", reviewBd: "#bdd4ee",
    danger: "#b42318", dangerBg: "#fcebe9", dangerBd: "#f5c8c2",
    base: "#6941c6", baseBg: "#f4f0fd", baseBd: "#e0d3fa",
    inherit: "#667085", inheritBg: "#f2f4f7", inheritBd: "#e0e4ea",
  },
  dark: {
    brand: "#4d94e8", brandStrong: "#74abec", brandSoft: "rgba(77, 148, 232, 0.16)",
    brandBorder: "rgba(77, 148, 232, 0.45)", secondary: "#74abec",
    navBg: "#081830", navBgHover: "rgba(255, 255, 255, 0.07)", navBgActive: "#0f62d6",
    navFg: "#a8b6ca", navFgActive: "#ffffff", navBorder: "rgba(255, 255, 255, 0.08)",
    canvas: "#101318", surface: "#171b21", surface2: "#1c2129",
    border: "#262b33", borderStrong: "#353b45", illSurface: "#232a33",
    text: "#e6e9ee", text2: "#a5adba", text3: "#6c7684",
    ok: "#4cc38a", okBg: "rgba(23, 178, 106, 0.14)", okBd: "rgba(23, 178, 106, 0.4)",
    pending: "#f2b13a", pendingBg: "rgba(247, 144, 9, 0.14)", pendingBd: "rgba(247, 144, 9, 0.4)",
    review: "#63a7f0", reviewBg: "rgba(77, 148, 232, 0.14)", reviewBd: "rgba(77, 148, 232, 0.4)",
    danger: "#f0716a", dangerBg: "rgba(240, 68, 56, 0.14)", dangerBd: "rgba(240, 68, 56, 0.4)",
    base: "#b490f5", baseBg: "rgba(148, 108, 230, 0.16)", baseBd: "rgba(148, 108, 230, 0.42)",
    inherit: "#98a2b3", inheritBg: "rgba(152, 162, 179, 0.14)", inheritBd: "rgba(152, 162, 179, 0.34)",
  },
  envColors: {
    production: "#4338ca", prod: "#4338ca", staging: "#b54708", development: "#067647",
    lab: "#0f9d6e", sandbox: "#7c3aed", nonprod: "#0891b2",
  },
};

// -----------------------------------------------------------------------------
// YOUR CUSTOMIZATIONS. Deep-merged over defaultTheme. Examples:
//
//   export const themeOverrides: DeepPartial<BrandConfig> = {
//     appName: "Acme Config",
//     tagline: "Platform Settings",
//     logo: { text: "A" },
//     favicon: "🛠",                      // emoji, an <svg ...> string, or "/logo.svg"
//     light: { brand: "#7c3aed", secondary: "#06b6d4", navBg: "#1e1b4b" },
//     dark:  { brand: "#a78bfa" },
//   };
// -----------------------------------------------------------------------------
export const themeOverrides: DeepPartial<BrandConfig> = {};

// -----------------------------------------------------------------------------
// THEME PRESETS. A preset is a named look built on top of the defaults. Ship
// several; an operator picks ONE with a single line below. "default" is the
// original identity (unchanged); "instrument" is the flatter, more owned look
// (crisp elevation via CSS, a cobalt accent, deeper neutrals - the elevation
// half is applied in tokens.css under :root[data-preset="instrument"]).
// -----------------------------------------------------------------------------
export const presets: Record<string, DeepPartial<BrandConfig>> = {
  default: {},
  instrument: {
    shape: { borderRadius: 7 },
    light: {
      brand: "#2f4bd6", brandStrong: "#2439ab", brandSoft: "#ecefff", brandBorder: "#c5cdf6",
      secondary: "#2f4bd6",
      navBg: "#0b1730", navBgActive: "#2f4bd6",
      canvas: "#e8e9ee", surface: "#ffffff", surface2: "#f4f5f8",
      border: "#e1e3ea", borderStrong: "#ccd0da",
      text: "#0f1729", text2: "#465063", text3: "#8b93a4",
      review: "#2f4bd6", reviewBg: "#ecefff", reviewBd: "#c5cdf6",
    },
    dark: {
      brand: "#8098f6", brandStrong: "#97abf8", brandSoft: "rgba(90,110,240,0.18)",
      brandBorder: "rgba(90,110,240,0.5)", secondary: "#8098f6",
      navBg: "#080f1f", navBgActive: "#2f4bd6",
      canvas: "#0d1017", surface: "#141821", surface2: "#1a1f2a",
      border: "#242a36", borderStrong: "#333a48",
      review: "#8098f6", reviewBg: "rgba(90,110,240,0.16)", reviewBd: "rgba(90,110,240,0.42)",
    },
  },
};

// THE SWITCH. Change this one value (or leave it "default" to ship unchanged).
// Everything - colors AND the flat/soft elevation - follows from it.
export const ACTIVE_PRESET = "default";

// --- machinery (usually no need to touch below) ------------------------------

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, over: DeepPartial<T>): T {
  if (!isObject(base) || !isObject(over)) return (over as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = isObject(b) && isObject(v) ? deepMerge(b, v as DeepPartial<unknown>) : v;
  }
  return out as T;
}

/** The resolved, active theme: defaults, then the chosen preset, then any
 *  hand overrides on top. */
export const theme: BrandConfig = deepMerge(
  deepMerge(defaultTheme, presets[ACTIVE_PRESET] ?? {}),
  themeOverrides,
);

/** One mode's palette as `--var: value;` declarations. */
function paletteToCss(p: Palette): string {
  return VAR_MAP.map(([key, cssVar]) => `${cssVar}: ${p[key]};`).join(" ");
}

/** The color layer. The default palette lands on :root; every OTHER preset is
 *  emitted scoped to :root[data-preset="<name>"], so switching preset (the
 *  data-preset attribute the brand plugin stamps) flips the whole palette with
 *  no rebuild, and both looks always ship together. Hand overrides
 *  (themeOverrides) apply on top of whichever preset is active. */
export function renderRootCss(): string {
  const base = deepMerge(defaultTheme, themeOverrides);
  const blocks = [
    `:root { ${paletteToCss(base.light)} }`,
    `[data-theme="dark"] { ${paletteToCss(base.dark)} }`,
  ];
  for (const [name, over] of Object.entries(presets)) {
    if (name === "default" || !over) continue;
    const merged = deepMerge(deepMerge(defaultTheme, over), themeOverrides);
    blocks.push(`:root[data-preset="${name}"] { ${paletteToCss(merged.light)} }`);
    blocks.push(`[data-theme="dark"][data-preset="${name}"] { ${paletteToCss(merged.dark)} }`);
  }
  return blocks.join("\n");
}

/** Resolve a favicon field (emoji / inline svg / path) to an href. */
export function faviconHref(favicon: string): string {
  const s = favicon.trim();
  if (s.startsWith("<svg")) return "data:image/svg+xml," + encodeURIComponent(s);
  if (/^(\/|https?:|data:)/.test(s) || /\.(svg|png|ico|jpe?g|gif|webp)$/i.test(s)) return s;
  // Treat anything else (e.g. an emoji) as a glyph centered on a square.
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
    `<text x='16' y='25' font-size='26' text-anchor='middle'>${s}</text></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}
