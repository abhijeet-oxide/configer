import { APPEARANCE_KEY, defaultAppearance, loadAppearance, saveAppearance, type Appearance } from "./uikit/prefs";
// Personal settings: the ONE model for everything a person tunes about their
// own Configer experience (appearance, comfort, time). It is deliberately
// separate from view state (store.ts keeps navigation and selections) and from
// grid view preferences (ViewPrefs), so adding a future setting is one field
// here plus one control on the Settings page - nothing else moves.
//
// Persistence: a single versioned localStorage document. Legacy keys
// ("configer.mode", "configer.fontScale") are migrated on first load so
// nobody's existing choices are lost.

export type Mode = "light" | "dark";
/** What the user ASKED for; "system" follows the OS and updates live. */
export type ThemePref = Mode | "system";
export type FontScale = "small" | "normal" | "large" | "xlarge";
export type Density = "comfortable" | "compact";
export type HourCycle = "auto" | "h12" | "h23";

export interface UserSettings {
  /** requested theme; resolve with resolveMode() before painting */
  theme: ThemePref;
  fontScale: FontScale;
  density: Density;
  /** IANA zone name, or null = follow this device (auto-detect) */
  timeZone: string | null;
  /** clock style for absolute times; "auto" follows the browser locale */
  hourCycle: HourCycle;
}

export const defaultSettings: UserSettings = {
  theme: "system",
  fontScale: "normal",
  density: "comfortable",
  timeZone: null,
  hourCycle: "auto",
};


/** The device's own IANA time zone (always defined in modern browsers). */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Resolve a theme preference to the mode to actually paint. */
export function resolveMode(pref: ThemePref): Mode {
  if (pref === "system") {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

// The settings live in the platform's ONE preference record
// (uikit.appearance.v1, see uikit/prefs.ts), shared by every application on
// the origin: a theme or text size chosen in Software Gateway holds here, and
// the other way round. This module only translates between that record and the
// fields this application's store reads.
export function loadSettings(): UserSettings {
  migrateLegacy();
  return fromAppearance(loadAppearance());
}

export function saveSettings(s: UserSettings): void {
  saveAppearance(toAppearance(s, loadAppearance()));
}

export function fromAppearance(a: Appearance): UserSettings {
  return sanitize({
    theme: a.theme,
    fontScale: a.fontScale,
    density: a.density,
    timeZone: a.timeZone || null,
    hourCycle: a.hourCycle === "24" ? "h23" : "h12",
  });
}

function toAppearance(s: UserSettings, base: Appearance): Appearance {
  return {
    ...base,
    theme: s.theme,
    fontScale: s.fontScale,
    density: s.density,
    timeZone: s.timeZone ?? "",
    hourCycle: s.hourCycle === "auto" ? base.hourCycle : s.hourCycle === "h23" ? "24" : "12",
  };
}

// Before the platform record, this application kept its own. Carried across
// once, so nobody loses a dark theme to the merge.
const LEGACY_KEY = "configer.settings.v1";
function migrateLegacy(): void {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    localStorage.removeItem(LEGACY_KEY);
    if (localStorage.getItem(APPEARANCE_KEY)) return;
    const old = sanitize({ ...defaultSettings, ...(JSON.parse(raw) as Partial<UserSettings>) });
    saveAppearance(toAppearance(old, defaultAppearance));
  } catch {
    // An unreadable legacy record is simply not carried across.
  }
}

// sanitize guards against a hand-edited or stale document: any field with an
// unknown value falls back to its default instead of poisoning the UI.
function sanitize(s: UserSettings): UserSettings {
  const pick = <T,>(v: T, allowed: readonly T[], dflt: T): T =>
    allowed.includes(v) ? v : dflt;
  return {
    theme: pick(s.theme, ["light", "dark", "system"] as const, defaultSettings.theme),
    fontScale: pick(s.fontScale, ["small", "normal", "large", "xlarge"] as const, defaultSettings.fontScale),
    density: pick(s.density, ["comfortable", "compact"] as const, defaultSettings.density),
    timeZone: typeof s.timeZone === "string" && s.timeZone ? s.timeZone : null,
    hourCycle: pick(s.hourCycle, ["auto", "h12", "h23"] as const, defaultSettings.hourCycle),
  };
}

// --------------------------------------------------------------- first run
// Whether the welcome tour has been seen on this device. A plain flag (not a
// setting): it is about onboarding state, not a preference.
const WELCOME_KEY = "configer.welcomed.v1";
export const welcomeSeen = (): boolean => localStorage.getItem(WELCOME_KEY) === "1";
export const markWelcomeSeen = (): void => localStorage.setItem(WELCOME_KEY, "1");
export const clearWelcomeSeen = (): void => localStorage.removeItem(WELCOME_KEY);

// A link may say what to do about the first-run tour:
//
//   ?welcome=skip   treat this device as already welcomed
//   ?welcome=show   replay the tour whatever this device remembers
//
// This is what you want when handing somebody a deep link that should not open
// with a dialog on top of it, when driving the UI from a browser test, and when
// taking screenshots. It is read ONCE, at module load - before the router
// canonicalizes the address bar and drops the parameter - and recorded on the
// device, so it holds for every later navigation in that browser.
//
// Nothing else is accepted: an unrecognized value leaves the tour alone rather
// than guessing which way a stray "welcome=0" was meant.
function applyWelcomeParam(): void {
  try {
    const want = new URLSearchParams(window.location.search).get("welcome");
    if (want === "skip") markWelcomeSeen();
    else if (want === "show") clearWelcomeSeen();
  } catch {
    // no URL or no storage: the tour behaves exactly as it did
  }
}
applyWelcomeParam();

// --------------------------------------------------------------- time zones
/** Every IANA zone the browser knows, for the searchable picker. */
export function allTimeZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const zones = intl.supportedValuesOf?.("timeZone");
    if (zones && zones.length > 0) return zones;
  } catch {
    // older engine: fall through to the short list
  }
  return [
    "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore",
    "Asia/Tokyo", "Australia/Sydney",
  ];
}

// Cities renamed across tz database versions: whichever spelling this
// browser's list carries, people search by either. Keyed by the zone's city
// token, value is the other spelling to also match.
const ZONE_ALIASES: Record<string, string> = {
  calcutta: "kolkata",
  kolkata: "calcutta",
  kiev: "kyiv",
  kyiv: "kiev",
  saigon: "ho chi minh",
  ho_chi_minh: "saigon",
  rangoon: "yangon",
  yangon: "rangoon",
  bombay: "mumbai",
  madras: "chennai",
  astana: "nur-sultan",
  godthab: "nuuk",
  nuuk: "godthab",
};

/** Extra search words for a zone (renamed-city aliases), or "". */
export function zoneAliasTerms(tz: string): string {
  const city = tz.split("/").pop()?.toLowerCase() ?? "";
  return ZONE_ALIASES[city] ?? "";
}

/** "UTC+05:30" style offset label for a zone right now. */
export function zoneOffsetLabel(tz: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    // "GMT+5:30" -> "UTC+05:30"; plain "GMT" -> "UTC"
    if (!name || name === "GMT") return "UTC";
    return name.replace(/^GMT/, "UTC").replace(/([+-])(\d):/, "$10$2:");
  } catch {
    return "";
  }
}
