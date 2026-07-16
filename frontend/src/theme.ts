// Theme system: one deliberate product identity (AT&T blue primary over a
// neutral canvas) expressed twice: as CSS variables in tokens.css for custom
// surfaces, and here as Ant Design tokens so the primitive layer matches.
// Light is the design target; dark stays fully functional.
import { theme as antdTheme, type ThemeConfig } from "antd";

export type Mode = "light" | "dark";
export type FontScale = "normal" | "large";

// The single brand primary. Must stay in sync with --brand in tokens.css.
export const BRAND = "#0057b8";
const BRAND_DARK = "#4d94e8";

// Semantic accents used consistently across the app (mirrored in tokens.css):
// green = healthy/valid, amber = attention/pending, blue = review/primary,
// red = errors, failures and destructive actions ONLY; it never denotes an
// environment (a healthy production instance is not an error).
export const semantic = {
  ok: "#067647",
  pending: "#b54708",
  review: "#0057b8",
  danger: "#b42318",
};

// Environment identity colors. These label WHICH environment an instance runs
// in; they are deliberately distinct from the status palette above so color
// carries one meaning. Production is a serious indigo (not danger-red).
// Single source of truth: import envHex/envColors instead of hardcoding.
export const envColors: Record<string, string> = {
  production: "#4338ca", // indigo: serious, high-stakes, but not an error
  prod: "#4338ca", // alias of production
  staging: "#b54708", // amber
  development: "#067647", // green
  lab: "#0f9d6e", // teal
  sandbox: "#7c3aed", // violet
  nonprod: "#0891b2", // cyan
};
export const envHex = (env: string | undefined): string =>
  (env ? envColors[env.toLowerCase()] : undefined) ?? "#8c8c8c";

// Suggested environment names offered in the pickers. The field is free text;
// these are only defaults; any custom value is accepted.
export const ENV_PRESETS = ["Development", "Lab", "Staging", "Sandbox", "Prod", "Nonprod"];

export function buildTheme(mode: Mode, scale: FontScale = "normal"): ThemeConfig {
  const base = scale === "large" ? 15 : 13;
  const dark = mode === "dark";
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? BRAND_DARK : BRAND,
      colorInfo: dark ? BRAND_DARK : BRAND,
      colorLink: dark ? BRAND_DARK : BRAND,
      colorSuccess: dark ? "#4cc38a" : "#067647",
      colorWarning: dark ? "#f2b13a" : "#b54708",
      colorError: dark ? "#f0716a" : "#b42318",
      borderRadius: 6,
      controlHeight: 30,
      fontSize: base,
      fontFamily:
        `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
      // three planes: page canvas < content surface < floating surface
      colorBgLayout: dark ? "#0f1115" : "#f5f6f8",
      colorBgContainer: dark ? "#16181d" : "#ffffff",
      colorBgElevated: dark ? "#1b1e24" : "#ffffff",
      colorBorder: dark ? "#343943" : "#d0d5dd",
      colorBorderSecondary: dark ? "#262a31" : "#e4e7ec",
      colorText: dark ? "#e6e9ee" : "#101828",
      colorTextSecondary: dark ? "#a5adba" : "#475467",
      colorTextTertiary: dark ? "#6c7684" : "#98a2b3",
    },
    components: {
      Layout: {
        headerHeight: 48,
        headerPadding: "0 16px",
      },
      Button: {
        fontWeight: 500,
        primaryShadow: "none",
        defaultShadow: "none",
        dangerShadow: "none",
      },
      Card: {
        boxShadowTertiary: dark
          ? "0 1px 2px rgba(0,0,0,0.5)"
          : "0 1px 2px rgba(16,24,40,0.05)",
        headerFontSize: base,
      },
      Table: {
        headerBg: dark ? "#1b1e24" : "#fafbfc",
        headerColor: dark ? "#a5adba" : "#475467",
        headerSplitColor: "transparent",
        cellPaddingBlock: 10,
        cellPaddingBlockSM: 4,
        cellPaddingInlineSM: 8,
        rowHoverBg: dark ? "#1b1e24" : "#f5f8fc",
      },
      Tabs: {
        titleFontSize: base,
        horizontalItemPadding: "10px 4px",
        horizontalMargin: "0",
      },
      Tag: {
        defaultBg: dark ? "#1b1e24" : "#f2f4f7",
        defaultColor: dark ? "#a5adba" : "#475467",
      },
      Tree: {
        nodeSelectedBg: dark ? "rgba(77,148,232,0.16)" : "#e8f1fb",
      },
      Statistic: {
        contentFontSize: scale === "large" ? 24 : 20,
      },
    },
  };
}
