// Theme: one deliberate product identity expressed twice - as CSS variables
// (generated from uikit/tokens.ts and inlined by the brand Vite plugin) for the
// hand-rolled surfaces, and as Ant Design tokens so the primitive layer
// matches. Both derive from the SAME tokens, so they cannot drift.
//
// None of that lives here any more. It lives in `uikit/`, which is
// byte-identical to the copy in every other tool on this platform - the only
// way two codebases stay looking the same is for the shared part to be the
// SAME FILES rather than two careful copies of the same intentions.
//
//   TO RESKIN     edit uikit/tokens.ts, and every tool follows
//   TO RENAME     edit brand.ts
//
// What remains here is what is genuinely Configer's: the words this product
// uses for an environment. Everything else is re-exported from the kit so the
// existing import sites keep working.
export { buildTheme, envColors, envHex, isProductionEnv } from "./uikit";
export type { Density, FontScale, Mode, ThemePref } from "./settings";

import { tokens } from "./uikit";

// The single brand primary, from the shared tokens (kept for existing
// importers; anything new should read `c.brand` from the kit, which is a
// variable and therefore follows the theme).
export const BRAND = tokens.light.brand;

// Semantic accents used consistently across the app: green = healthy/valid,
// amber = attention/pending, blue = review/primary, red = errors, failures and
// destructive actions ONLY; it never denotes an environment (a healthy
// production instance is not an error).
export const semantic = {
  ok: tokens.light.ok,
  pending: tokens.light.pending,
  review: tokens.light.review,
  danger: tokens.light.danger,
};

// Suggested environment names offered in the pickers. The field is free text;
// these are only defaults; any custom value is accepted.
export const ENV_PRESETS = ["Development", "Lab", "Staging", "Sandbox", "Prod", "Nonprod"];

// An environment is ONE environment however it was spelled. Names reach the
// product from several places that do not agree on case - a product descriptor
// writes "lab", the folder-name guess writes "development", a person types
// "Lab" - and comparing them literally turns one environment into three: three
// chips, three colours, three entries in every picker, and a fleet that cannot
// be selected by environment any more.
//
// So every name is resolved to the spelling above before it is shown, stored or
// compared. Only CASE is reconciled, never wording: "prod" and "production" are
// left as the different words they are, because deciding they mean the same
// thing is a judgement about somebody's estate rather than about typography.
export function canonicalEnv(env: string): string;
export function canonicalEnv(env: undefined): undefined;
export function canonicalEnv(env: string | undefined): string | undefined;
export function canonicalEnv(env: string | undefined): string | undefined {
  if (!env) return env;
  const trimmed = env.trim();
  return ENV_PRESETS.find((p) => p.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
}

// The choices an environment picker offers: the presets plus whatever the
// estate already uses, with names that differ only in case folded together.
export function envOptions(known: (string | undefined)[] = []): string[] {
  const seen = new Map<string, string>();
  for (const name of [...ENV_PRESETS, ...known]) {
    const value = canonicalEnv(name);
    if (!value) continue;
    if (!seen.has(value.toLowerCase())) seen.set(value.toLowerCase(), value);
  }
  return [...seen.values()];
}
