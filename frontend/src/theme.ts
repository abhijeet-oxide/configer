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
// green = live/valid · amber = pending · blue = in review · red = invalid/production.
export const semantic = {
  ok: "#0ca30c",
  pending: "#fa8c16",
  review: "#1677ff",
  danger: "#d03b3b",
};

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
