// Reading a colour OUT of the theme.
//
// Every value here is a `var(--...)` string, not a hex. That is the whole
// point: an inline style written with one of these follows the light/dark
// switch and the active preset without the component knowing either exists.
// A component that reached for a hex is one that stays light forever, and one
// a rebrand silently misses.

import { tokens } from "./tokens";

/** A CSS custom property reference, for an inline style or a template. */
export const cssVar = (name: string): string => `var(--${name})`;

/**
 * The same colour, thinner.
 *
 * `color-mix` rather than a hex with two more digits appended: the input here
 * is usually a var(), and "#009fdb" + "22" only works when the value happens
 * to be a literal six-digit hex. It silently produced `var(--brand)22` - an
 * invalid colour, so the rule was dropped and the ring simply never appeared.
 *
 * @param amount 0..1, how much of the colour survives.
 */
export const withAlpha = (color: string, amount: number): string =>
  `color-mix(in srgb, ${color} ${Math.round(Math.max(0, Math.min(1, amount)) * 100)}%, transparent)`;

/** The palette, as variables. Use these anywhere a colour is needed inline. */
export const c = {
  brand: cssVar("brand"),
  brandStrong: cssVar("brand-strong"),
  brandSoft: cssVar("brand-soft"),
  brandBorder: cssVar("brand-border"),
  secondary: cssVar("secondary"),

  navBg: cssVar("nav-bg"),
  navBgHover: cssVar("nav-bg-hover"),
  navBgActive: cssVar("nav-bg-active"),
  navFg: cssVar("nav-fg"),
  navFgStrong: cssVar("nav-fg-strong"),
  navFgActive: cssVar("nav-fg-active"),
  navBorder: cssVar("nav-border"),

  canvas: cssVar("canvas"),
  surface: cssVar("surface"),
  surface2: cssVar("surface-2"),
  border: cssVar("border"),
  borderStrong: cssVar("border-strong"),

  /** The ground a proportional bar is drawn on. Not a palette colour - it is
   *  structural, and lives in tokens.css beside the rest of the shape. */
  track: cssVar("track"),

  text: cssVar("text"),
  text2: cssVar("text-2"),
  text3: cssVar("text-3"),

  ok: cssVar("c-ok"), okBg: cssVar("c-ok-bg"), okBd: cssVar("c-ok-bd"),
  pending: cssVar("c-pending"), pendingBg: cssVar("c-pending-bg"), pendingBd: cssVar("c-pending-bd"),
  review: cssVar("c-review"), reviewBg: cssVar("c-review-bg"), reviewBd: cssVar("c-review-bd"),
  danger: cssVar("c-danger"), dangerBg: cssVar("c-danger-bg"), dangerBd: cssVar("c-danger-bd"),
  markBg: cssVar("c-mark-bg"), markBd: cssVar("c-mark-bd"),
  base: cssVar("c-base"), baseBg: cssVar("c-base-bg"), baseBd: cssVar("c-base-bd"),
  inherit: cssVar("c-inherit"), inheritBg: cssVar("c-inherit-bg"), inheritBd: cssVar("c-inherit-bd"),
};

/** Type and shape, for the same reason. */
export const mono = cssVar("font-mono");
export const fontUI = cssVar("font-ui");

// ---------------------------------------------------------------------------
// Severity, and the verdict of a comparison
// ---------------------------------------------------------------------------

export type Severity = "critical" | "high" | "medium" | "low" | "unknown";
export type Verdict = "better" | "worse" | "unchanged" | "inconclusive";

export const severity: Record<Severity, string> = {
  critical: cssVar("sev-critical"),
  high: cssVar("sev-high"),
  medium: cssVar("sev-medium"),
  low: cssVar("sev-low"),
  unknown: cssVar("sev-unknown"),
};

/** The severity dots' fills, lighter than the text they sit beside. */
export const severitySurface: Record<Severity, string> = {
  critical: cssVar("sev-critical-bg"),
  high: cssVar("sev-high-bg"),
  medium: cssVar("sev-medium-bg"),
  low: cssVar("sev-low-bg"),
  unknown: cssVar("sev-unknown-bg"),
};

export const verdict: Record<Verdict, string> = {
  better: cssVar("v-better"),
  worse: cssVar("v-worse"),
  unchanged: cssVar("v-unchanged"),
  inconclusive: cssVar("v-inconclusive"),
};

// ---------------------------------------------------------------------------
// Environment identity
// ---------------------------------------------------------------------------

/**
 * Which environment a thing runs in - deliberately distinct from the status
 * palette, so colour carries ONE meaning. Sandbox is slate, lab blue,
 * production orange - not danger red: a healthy production instance is not an error.
 *
 * These are real values rather than variables because callers mix them
 * (a chip's tinted background is derived from the returned colour), and they
 * are the same in both modes on purpose: an environment does not change
 * identity when the lights go out.
 */
export const envColors: Record<string, string> = tokens.envColors;

export const envHex = (env: string | undefined): string =>
  (env ? envColors[env.toLowerCase()] : undefined) ?? "#ff9c84";

/**
 * The themed FACE of a move destination - sandbox, lab or production - as a
 * foreground/background/border triple of variables: the colour of the button
 * that moves a release into the environment, and of the tag that names it.
 *
 * This is the counterpart of `envColors`, not a replacement. envColors is the
 * identity MARK (one hue in both modes, a real value because callers mix it);
 * a tone is the SURFACE, and a surface has to flip with the theme - a slate
 * tag is near-white type on dark and near-black on light - so it is three
 * var() references and follows the switch like everything else here.
 *
 * Only the three pipeline destinations have one. Any other environment
 * (staging, development, ...) keeps its mark, and callers fall back to
 * `envHex` or a neutral treatment.
 */
export interface EnvTone {
  fg: string;
  bg: string;
  bd: string;
}

export const envTones: Record<string, EnvTone> = {
  sandbox: { fg: cssVar("env-sandbox"), bg: cssVar("env-sandbox-bg"), bd: cssVar("env-sandbox-bd") },
  lab: { fg: cssVar("env-lab"), bg: cssVar("env-lab-bg"), bd: cssVar("env-lab-bd") },
  production: { fg: cssVar("env-prod"), bg: cssVar("env-prod-bg"), bd: cssVar("env-prod-bd") },
  prod: { fg: cssVar("env-prod"), bg: cssVar("env-prod-bg"), bd: cssVar("env-prod-bd") },
};

export const envTone = (env: string | undefined): EnvTone | undefined =>
  (env ? envTones[env.toLowerCase()] : undefined);

/** Whether an environment label denotes production, so a change touching it
 *  can be weighted more heavily at review time. Both spellings, any case. */
export function isProductionEnv(env: string | undefined): boolean {
  const name = env?.trim().toLowerCase();
  return name === "production" || name === "prod";
}
