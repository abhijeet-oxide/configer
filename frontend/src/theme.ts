// Theme system: one deliberate product identity expressed twice - as CSS
// variables (generated from theme.config.ts and inlined by the brand Vite
// plugin) for custom surfaces, and here as Ant Design tokens so the primitive
// layer matches. Both derive from the SAME config, so they cannot drift.
// To customize the look, edit theme.config.ts - not this file.
import { theme as antdTheme, type ThemeConfig } from "antd";
import { theme as brand } from "./theme.config";

export type Mode = "light" | "dark";
export type FontScale = "normal" | "large";

// The single brand primary, from the theme config (kept for existing importers).
export const BRAND = brand.light.brand;

// Semantic accents used consistently across the app: green = healthy/valid,
// amber = attention/pending, blue = review/primary, red = errors, failures and
// destructive actions ONLY; it never denotes an environment (a healthy
// production instance is not an error).
export const semantic = {
  ok: brand.light.ok,
  pending: brand.light.pending,
  review: brand.light.review,
  danger: brand.light.danger,
};

// Environment identity colors. These label WHICH environment an instance runs
// in; they are deliberately distinct from the status palette above so color
// carries one meaning. Production is a serious indigo (not danger-red).
// Single source of truth: import envHex/envColors instead of hardcoding.
export const envColors: Record<string, string> = brand.envColors;
export const envHex = (env: string | undefined): string =>
  (env ? envColors[env.toLowerCase()] : undefined) ?? "#8c8c8c";

// Suggested environment names offered in the pickers. The field is free text;
// these are only defaults; any custom value is accepted.
export const ENV_PRESETS = ["Development", "Lab", "Staging", "Sandbox", "Prod", "Nonprod"];

export function buildTheme(mode: Mode, scale: FontScale = "normal"): ThemeConfig {
  const dark = mode === "dark";
  const p = dark ? brand.dark : brand.light;
  const base = scale === "large" ? brand.type.fontSizeBase + 2 : brand.type.fontSizeBase;
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: p.brand,
      colorInfo: p.brand,
      colorLink: p.brand,
      colorSuccess: p.ok,
      colorWarning: p.pending,
      colorError: p.danger,
      borderRadius: brand.shape.borderRadius,
      controlHeight: brand.shape.controlHeight,
      fontSize: base,
      fontFamily: brand.type.fontFamily,
      // three planes: pastel page canvas < content surface < floating surface
      colorBgLayout: p.canvas,
      colorBgContainer: p.surface,
      colorBgElevated: dark ? p.surface2 : p.surface,
      colorBorder: p.borderStrong,
      colorBorderSecondary: p.border,
      colorText: p.text,
      colorTextSecondary: p.text2,
      colorTextTertiary: p.text3,
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
          ? "5px 5px 12px rgba(0,0,0,0.45), -4px -4px 10px rgba(255,255,255,0.035)"
          : "5px 5px 12px rgba(163,177,198,0.28), -4px -4px 10px rgba(255,255,255,0.85)",
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
