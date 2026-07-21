import { useUI } from "./store";
import { deviceTimeZone, type HourCycle } from "./settings";

// Absolute-time formatting, honoring the user's time zone and clock settings.
// Relative times ("2h ago") are zone-independent and stay with relTime; every
// ABSOLUTE timestamp the product prints should come through here so one
// setting converts the whole page.

/** The zone times are rendered in: the chosen one, or this device's. */
export function effectiveTimeZone(): string {
  return useUI.getState().timeZone ?? deviceTimeZone();
}

function hour12For(hc: HourCycle): boolean | undefined {
  if (hc === "h12") return true;
  if (hc === "h23") return false;
  return undefined; // auto: follow the browser locale
}

/** Full date + time, e.g. "21 Jul 2026, 14:05" (in the user's zone). */
export function fmtDateTime(iso: string | number | Date): string {
  const { timeZone, hourCycle } = useUI.getState();
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timeZone ?? undefined,
    hour12: hour12For(hourCycle),
  }).format(d);
}

/** Time only, e.g. "14:05" or "2:05 PM" (in the user's zone). */
export function fmtTime(iso: string | number | Date): string {
  const { timeZone, hourCycle } = useUI.getState();
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat(undefined, {
    timeStyle: "short",
    timeZone: timeZone ?? undefined,
    hour12: hour12For(hourCycle),
  }).format(d);
}

/** Subscribing variant for components that must re-render when the time
 *  settings change (the Settings page preview; tooltips re-render anyway). */
export function useTimeSettings(): { timeZone: string; hourCycle: HourCycle } {
  const timeZone = useUI((s) => s.timeZone) ?? deviceTimeZone();
  const hourCycle = useUI((s) => s.hourCycle);
  return { timeZone, hourCycle };
}
