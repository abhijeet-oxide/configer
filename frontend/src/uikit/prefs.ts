// Appearance preferences: what a person tunes about their own copy of the tool.
//
// Deliberately tiny and dependency-free. An app with its own settings model
// (a store, a server-side profile) drives the provider in CONTROLLED mode and
// never touches this file; an app without one gets persistence for free.
//
// The storage key is shared on purpose. Two tools hosted on the same origin
// then agree about dark mode, which is the one preference a person expects to
// set once - and on different origins the key simply does not collide.

export type Mode = "light" | "dark";
/** What the user ASKED for; "system" follows the OS and updates live. */
export type ThemePref = Mode | "system";
export type FontScale = "small" | "normal" | "large" | "xlarge";
export type Density = "comfortable" | "compact";
export type Contrast = "standard" | "high";
/** Which status palette to paint. "typical" is the brand palette; the others
 *  move every status, severity and verdict colour onto hues that type of
 *  colour vision tells apart. */
export type ColorVision = "typical" | "red-green" | "blue-yellow";
/** "system" follows the OS reduced-motion setting; "reduce" forces it on. */
export type Motion = "system" | "reduce";
export type DateFormat = "us" | "us-numeric" | "gb" | "gb-numeric" | "iso";
export type HourCycle = "12" | "24";

export interface Appearance {
  /** requested theme; resolve with resolveMode() before painting */
  theme: ThemePref;
  fontScale: FontScale;
  density: Density;
  contrast: Contrast;
  colorVision: ColorVision;
  motion: Motion;
  underlineLinks: boolean;
  /** an IANA zone; empty follows the device */
  timeZone: string;
  dateFormat: DateFormat;
  hourCycle: HourCycle;
  /** when first-run setup was finished or skipped; empty shows it */
  onboardedAt: string;
}

export const defaultAppearance: Appearance = {
  theme: "system",
  fontScale: "normal",
  density: "comfortable",
  contrast: "standard",
  colorVision: "typical",
  motion: "system",
  underlineLinks: false,
  timeZone: "",
  dateFormat: "us",
  hourCycle: "12",
  onboardedAt: "",
};

// Every tool and every path on the origin reads this one key, which is what
// makes a choice made in one module hold in all of them. Fields were added
// without a version bump: sanitize() fills what an older copy lacks.
export const APPEARANCE_KEY = "uikit.appearance.v1";
const KEY = APPEARANCE_KEY;

/* Cross-origin bridge for the theme preference only.
 *
 * localStorage is per origin. The sign-in screen is ZITADEL's own port, so it
 * cannot read KEY. Cookies are not scoped to a port, and on one host that is
 * enough for the application and the sign-in screen to share light, dark and
 * system. The sign-in script is deploy/zitadel/login-theme.js. Font scale and
 * density stay in KEY; they have no meaning on that screen.
 */
export const THEME_COOKIE = "uikit.theme";

export function readThemeCookie(): ThemePref | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|; )uikit\.theme=(light|dark|system)(?:;|$)/);
  return m ? (m[1] as ThemePref) : null;
}

export function writeThemeCookie(theme: ThemePref): void {
  if (typeof document === "undefined") return;
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

const THEMES: ThemePref[] = ["light", "dark", "system"];
const SCALES: FontScale[] = ["small", "normal", "large", "xlarge"];
const DENSITIES: Density[] = ["comfortable", "compact"];
const CONTRASTS: Contrast[] = ["standard", "high"];
const VISIONS: ColorVision[] = ["typical", "red-green", "blue-yellow"];
const MOTIONS: Motion[] = ["system", "reduce"];
const DATE_FORMATS: DateFormat[] = ["us", "us-numeric", "gb", "gb-numeric", "iso"];
const HOUR_CYCLES: HourCycle[] = ["12", "24"];

/** The zone the device reports, or UTC where the runtime cannot say. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a theme preference to the mode to actually paint. */
export function resolveMode(pref: ThemePref): Mode {
  if (pref === "system") {
    return typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return pref;
}

function one<T>(allowed: T[], value: T, fallback: T): T {
  return allowed.includes(value) ? value : fallback;
}

function sanitize(a: Appearance): Appearance {
  const d = defaultAppearance;
  return {
    theme: one(THEMES, a.theme, d.theme),
    fontScale: one(SCALES, a.fontScale, d.fontScale),
    density: one(DENSITIES, a.density, d.density),
    contrast: one(CONTRASTS, a.contrast, d.contrast),
    colorVision: one(VISIONS, a.colorVision, d.colorVision),
    motion: one(MOTIONS, a.motion, d.motion),
    underlineLinks: a.underlineLinks === true,
    timeZone: typeof a.timeZone === "string" && (a.timeZone === "" || isTimeZone(a.timeZone)) ? a.timeZone : d.timeZone,
    dateFormat: one(DATE_FORMATS, a.dateFormat, d.dateFormat),
    hourCycle: one(HOUR_CYCLES, a.hourCycle, d.hourCycle),
    onboardedAt: typeof a.onboardedAt === "string" ? a.onboardedAt : d.onboardedAt,
  };
}

/** Forget every preference on this origin, the sign-in screen's theme included. */
export function clearAppearance(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage that cannot be read cannot be holding anything either.
  }
  if (typeof document !== "undefined") {
    document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}

export function loadAppearance(): Appearance {
  let stored = defaultAppearance;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = sanitize({ ...defaultAppearance, ...(JSON.parse(raw) as Partial<Appearance>) });
  } catch {
    // Unreadable or corrupt: the defaults are a perfectly good answer. A
    // preference failing to load must never be the reason a page does not
    // paint.
  }
  // The sign-in screen may have changed the preference while this origin was
  // closed. The cookie wins for the theme only; scale and density stay here.
  const bridged = readThemeCookie();
  if (bridged && bridged !== stored.theme) {
    stored = { ...stored, theme: bridged };
    try {
      localStorage.setItem(KEY, JSON.stringify(stored));
    } catch {
      // Same as saveAppearance: the session still paints the bridged theme.
    }
  }
  return stored;
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    // Private browsing, a full quota, storage disabled by policy: the session
    // keeps the choice in memory and simply forgets it next time.
  }
  writeThemeCookie(a.theme);
}

/** Watch the OS setting, for as long as "system" is the preference. Returns an
 *  unsubscribe, so a caller can hand it straight back from an effect. */
export function watchSystemMode(onChange: (mode: Mode) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => onChange(mq.matches ? "dark" : "light");
  apply();
  mq.addEventListener("change", apply);
  return () => mq.removeEventListener("change", apply);
}
