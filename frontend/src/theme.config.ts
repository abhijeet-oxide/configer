// =============================================================================
// Configer brand + theme - now a THIN BINDING onto the shared design system.
// =============================================================================
// This file used to hold every colour in the product. It no longer decides
// anything: the palette, the presets, the shape and type tokens and the CSS
// variable generation all live in `uikit/`, which is byte-identical to the copy
// in every other tool on this platform, so the tools cannot drift apart.
//
//   TO RESKIN THE PRODUCT      edit uikit/tokens.ts (and every tool follows)
//   TO RENAME THE PRODUCT      edit brand.ts
//
// What is left here is the join between the two: the `theme` object this
// application has always imported, carrying identity and palette together.
// Existing importers keep working unchanged, which is why adopting the shared
// system was not also a rewrite of six components.
import brand from "./brand";
import {
  ACTIVE_PRESET,
  defaultTokens,
  faviconHref,
  presets,
  renderRootCss,
  tokenOverrides,
  tokens,
  VAR_MAP,
} from "./uikit";
import type { BrandIdentity, DeepPartial, Palette, ThemeTokens } from "./uikit";

/** The full config this app reads: who we are, plus how we look. */
export type BrandConfig = BrandIdentity & ThemeTokens;

/** The resolved, active theme. */
export const theme: BrandConfig = { ...brand, ...tokens };

// Re-exported so nothing downstream has to learn two import paths at once.
export {
  ACTIVE_PRESET,
  defaultTokens,
  faviconHref,
  presets,
  renderRootCss,
  tokenOverrides,
  VAR_MAP,
};
export type { DeepPartial, Palette, ThemeTokens };

/** @deprecated the old name for `tokenOverrides`; edit uikit/tokens.ts instead. */
export const themeOverrides = tokenOverrides;
/** @deprecated the old name for the baseline; it is `defaultTokens` now. */
export const defaultTheme = { ...brand, ...defaultTokens };
