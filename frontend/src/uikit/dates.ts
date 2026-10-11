// Dates and times in the zone and format a person chose (prefs.ts).
//
// Module state rather than context, because the formatters are called from
// table renderers, tooltips and plain functions that have no hook to read
// one. ThemeProvider calls setDatePreferences while it renders, so everything
// it renders below that call already formats with the new choice.

import { defaultAppearance, type DateFormat, type HourCycle } from "./prefs.ts";

export interface DatePreferences {
  /** an IANA zone; empty follows the device */
  timeZone: string;
  dateFormat: DateFormat;
  hourCycle: HourCycle;
}

type Style = "day" | "absolute" | "time" | "timeSeconds" | "dayMonth";

let prefs: DatePreferences = {
  timeZone: defaultAppearance.timeZone,
  dateFormat: defaultAppearance.dateFormat,
  hourCycle: defaultAppearance.hourCycle,
};
let cache = new Map<Style, Intl.DateTimeFormat>();

export function setDatePreferences(next: DatePreferences): void {
  if (
    next.timeZone === prefs.timeZone &&
    next.dateFormat === prefs.dateFormat &&
    next.hourCycle === prefs.hourCycle
  ) {
    return;
  }
  prefs = { ...next };
  cache = new Map();
}

const LOCALE: Record<DateFormat, string> = {
  us: "en-US",
  "us-numeric": "en-US",
  gb: "en-GB",
  "gb-numeric": "en-GB",
  iso: "en-CA",
};

function options(style: Style, p: DatePreferences): Intl.DateTimeFormatOptions {
  const numeric = p.dateFormat === "us-numeric" || p.dateFormat === "gb-numeric" || p.dateFormat === "iso";
  const day: Intl.DateTimeFormatOptions = numeric
    ? { year: "numeric", month: "2-digit", day: "2-digit" }
    : { year: "numeric", month: "short", day: "2-digit" };
  const time: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: p.hourCycle === "12" };
  const zone: Intl.DateTimeFormatOptions = p.timeZone ? { timeZone: p.timeZone } : {};
  switch (style) {
    case "day": return { ...day, ...zone };
    case "absolute": return { ...day, ...time, ...zone };
    case "time": return { ...time, ...zone };
    case "timeSeconds": return { ...time, second: "2-digit", ...zone };
    case "dayMonth": return numeric ? { month: "2-digit", day: "2-digit", ...zone } : { month: "short", day: "2-digit", ...zone };
  }
}

function formatter(style: Style): Intl.DateTimeFormat {
  let f = cache.get(style);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE[prefs.dateFormat], options(style, prefs));
    cache.set(style, f);
  }
  return f;
}

function toTime(value: string | number | Date | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const t = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function render(f: Intl.DateTimeFormat, p: DatePreferences, t: number): string {
  // en-CA writes ISO order with "-" separators; its time half keeps a comma
  // that ISO does not have.
  return f
    .formatToParts(t)
    .map((part) => (p.dateFormat === "iso" && part.type === "literal" && part.value === ", " ? " " : part.value))
    .join("");
}

function format(style: Style, value: string | number | Date | undefined | null): string | null {
  const t = toTime(value);
  return t === null ? null : render(formatter(style), prefs, t);
}

/** A moment as a given set of preferences would show it, for a settings preview. */
export function previewDateTime(p: DatePreferences, at: number = Date.now()): string {
  return render(new Intl.DateTimeFormat(LOCALE[p.dateFormat], options("absolute", p)), p, at);
}

/** `Oct 10, 2026` - a date without a time. */
export const formatDate = (value: string | number | Date | undefined | null) => format("day", value);
/** `Oct 10, 2026, 04:34 PM` - the tooltip form. */
export const formatDateTime = (value: string | number | Date | undefined | null) => format("absolute", value);
/** `04:34 PM` */
export const formatTime = (value: string | number | Date | undefined | null) => format("time", value);
/** `04:34:09 PM` */
export const formatTimeSeconds = (value: string | number | Date | undefined | null) => format("timeSeconds", value);
/** `Oct 10` */
export const formatDayMonth = (value: string | number | Date | undefined | null) => format("dayMonth", value);

/** The calendar day a moment falls on in the chosen zone, as `2026-10-10`. */
export function dayKey(value: string | number | Date): string {
  const t = toTime(value) ?? Date.now();
  const f = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    ...(prefs.timeZone ? { timeZone: prefs.timeZone } : {}),
  });
  return f.format(t);
}

/** The hour of the day in the chosen zone, 0-23. */
export function hourOf(value: string | number | Date): number {
  const t = toTime(value) ?? Date.now();
  const f = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", hourCycle: "h23",
    ...(prefs.timeZone ? { timeZone: prefs.timeZone } : {}),
  });
  return Number(f.format(t)) % 24;
}

/** `GMT-5`, for a label beside a time. */
export function zoneLabel(zone: string, at: number = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone || undefined, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? zone;
  } catch {
    return zone;
  }
}

/** Every zone the runtime knows, falling back to the device's own. */
export function timeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    const list = supported ? supported("timeZone") : [];
    return list.includes("UTC") ? list : ["UTC", ...list];
  } catch {
    return ["UTC"];
  }
}
