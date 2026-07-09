// Theme presets demonstrate the "dark / light / company-brand via token
// overrides" requirement. Each preset is a set of Ant Design design tokens; the
// active mode chooses the light or dark algorithm. Company themes are just a
// different `colorPrimary` (and could be loaded from YAML/JSON at runtime).
import { theme as antdTheme, type ThemeConfig } from "antd";

export type Mode = "light" | "dark";
export type BrandKey = "configer" | "azure" | "emerald" | "violet";

export const brands: Record<BrandKey, { label: string; colorPrimary: string }> = {
  configer: { label: "Configer", colorPrimary: "#2f6bff" },
  azure: { label: "Azure", colorPrimary: "#0078d4" },
  emerald: { label: "Emerald", colorPrimary: "#10b981" },
  violet: { label: "Violet", colorPrimary: "#7c3aed" },
};

export function buildTheme(mode: Mode, brand: BrandKey): ThemeConfig {
  return {
    algorithm:
      mode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: brands[brand].colorPrimary,
      borderRadius: 6,
      fontSize: 13,
    },
    components: {
      Layout: {
        headerHeight: 48,
        headerPadding: "0 16px",
      },
      Table: {
        headerBg: mode === "dark" ? "#1f1f1f" : "#fafafa",
        cellPaddingBlockSM: 4,
        cellPaddingInlineSM: 8,
      },
    },
  };
}
