// Theme system: light/dark algorithms, company-brand token overrides, and a
// comfort text-size scale (accessibility for less-technical / older users).
import { theme as antdTheme, type ThemeConfig } from "antd";

export type Mode = "light" | "dark";
export type BrandKey = "configer" | "azure" | "emerald" | "violet";
export type FontScale = "normal" | "large";

export const brands: Record<BrandKey, { label: string; colorPrimary: string }> = {
  configer: { label: "Configer", colorPrimary: "#2f6bff" },
  azure: { label: "Azure", colorPrimary: "#0078d4" },
  emerald: { label: "Emerald", colorPrimary: "#0f9d6e" },
  violet: { label: "Violet", colorPrimary: "#7c3aed" },
};

// Semantic accents used consistently across the app (also mirrored in CSS):
// green = live/valid · amber = pending · blue = in review · red = invalid/danger.
// Red is reserved for errors, failures, and destructive actions ONLY; it never
// denotes an environment (a healthy production instance is not an error).
export const semantic = {
  ok: "#0ca30c",
  pending: "#fa8c16",
  review: "#1677ff",
  danger: "#d03b3b",
};

// Environment identity colors. These label WHICH environment an instance runs
// in; they are deliberately distinct from the status palette above so color
// carries one meaning. Production is a serious indigo (not danger-red), staging
// amber, development green. Single source of truth: import envHex/envColors
// instead of hardcoding hexes per component.
export const envColors: Record<string, string> = {
  production: "#4338ca", // indigo: serious, high-stakes, but not an error
  prod: "#4338ca", // alias of production
  staging: "#fa8c16", // amber
  development: "#0ca30c", // green
  lab: "#0f9d6e", // teal
  sandbox: "#7c3aed", // violet
  nonprod: "#0891b2", // cyan
};
export const envHex = (env: string | undefined): string =>
  (env ? envColors[env.toLowerCase()] : undefined) ?? "#8c8c8c";

// Suggested environment names offered in the pickers. The field is free text -
// these are only defaults; any custom value is accepted.
export const ENV_PRESETS = ["Development", "Lab", "Staging", "Sandbox", "Prod", "Nonprod"];

export function buildTheme(mode: Mode, brand: BrandKey, scale: FontScale = "normal"): ThemeConfig {
  const base = scale === "large" ? 15 : 13;
  const dark = mode === "dark";
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: brands[brand].colorPrimary,
      borderRadius: 8,
      fontSize: base,
      fontFamily:
        `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
      // clearer plane separation: page canvas vs raised cards
      colorBgLayout: dark ? "#0f0f10" : "#f4f5f7",
      colorBgContainer: dark ? "#17181a" : "#ffffff",
      colorBorderSecondary: dark ? "#26272b" : "#e9eaee",
    },
    components: {
      Layout: {
        headerHeight: 48,
        headerPadding: "0 16px",
      },
      Card: {
        boxShadowTertiary: dark
          ? "0 1px 2px rgba(0,0,0,0.5)"
          : "0 1px 2px rgba(16,24,40,0.05), 0 1px 3px rgba(16,24,40,0.06)",
      },
      Table: {
        headerBg: dark ? "#1d1e21" : "#fafbfc",
        cellPaddingBlockSM: 4,
        cellPaddingInlineSM: 8,
        rowHoverBg: dark ? "#202226" : "#f2f6ff",
      },
      Menu: {
        itemBorderRadius: 8,
        itemMarginInline: 8,
      },
      Statistic: {
        contentFontSize: scale === "large" ? 24 : 20,
      },
    },
  };
}
