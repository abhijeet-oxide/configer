// The accessibility half of the palette: what a person's contrast and colour
// vision settings change about the colours in tokens.ts.
//
// Applied to the SEED palette, before Ant Design derives anything, so a Tag,
// an Alert, a severity dot and a hand-written `var(--c-ok)` all move together.
// The defaults are untouched: with "standard" and "typical" this returns its
// input.

import type { Palette } from "./tokens.ts";
import type { ColorVision, Contrast, Mode } from "./prefs.ts";

export interface Access {
  contrast: Contrast;
  colorVision: ColorVision;
}

export const typicalAccess: Access = { contrast: "standard", colorVision: "typical" };

type Patch = Partial<Palette>;

// Red-green (protanopia, deuteranopia): blue against vermilion, the pair from
// Okabe and Ito's palette, with yellow between. Info moves to violet so it is
// not a second blue beside "ok".
const RED_GREEN: Record<Mode, Patch> = {
  light: {
    ok: "#0068b3", okBg: "#e8f1fa", okBd: "#b5d3ee",
    pending: "#7d6600", pendingBg: "#fbf6dc", pendingBd: "#e9dc98",
    danger: "#b84a00", dangerBg: "#fdefe6", dangerBd: "#f3c8a8",
    review: "#6b45b0", reviewBg: "#f3eefb", reviewBd: "#d8c9ef",
    sevCritical: "#d55e00", sevHigh: "#e69f00", sevMedium: "#f0e442", sevLow: "#0072b2",
    sevCriticalBg: "#fdefe6", sevHighBg: "#fdf4e0", sevMediumBg: "#fcf9dc", sevLowBg: "#e6f1f9",
    sevKev: "#8e2c6e", sevKevBg: "#f8eaf3", sevKevBd: "#e3b6d3",
    vBetter: "#0068b3", vWorse: "#b84a00",
  },
  dark: {
    ok: "#5aaef0", okBg: "rgba(0, 114, 178, 0.18)", okBd: "rgba(90, 174, 240, 0.45)",
    pending: "#e8d44d", pendingBg: "rgba(240, 228, 66, 0.14)", pendingBd: "rgba(240, 228, 66, 0.4)",
    danger: "#ff8c42", dangerBg: "rgba(213, 94, 0, 0.2)", dangerBd: "rgba(255, 140, 66, 0.45)",
    review: "#b49ae6", reviewBg: "rgba(123, 79, 184, 0.2)", reviewBd: "rgba(180, 154, 230, 0.45)",
    sevCritical: "#ff8c42", sevHigh: "#f5b335", sevMedium: "#f0e442", sevLow: "#5aaef0",
    sevCriticalBg: "rgba(213, 94, 0, 0.2)", sevHighBg: "rgba(230, 159, 0, 0.18)",
    sevMediumBg: "rgba(240, 228, 66, 0.14)", sevLowBg: "rgba(0, 114, 178, 0.2)",
    sevKev: "#e59acb", sevKevBg: "rgba(142, 44, 110, 0.4)", sevKevBd: "rgba(229, 154, 203, 0.45)",
    vBetter: "#5aaef0", vWorse: "#ff8c42",
  },
};

// Blue-yellow (tritanopia): the axis left is red against cyan, so "ok" is
// teal and every warning sits on the red side, told apart by lightness.
const BLUE_YELLOW: Record<Mode, Patch> = {
  light: {
    ok: "#00796b", okBg: "#e3f4f1", okBd: "#a8dcd4",
    pending: "#8a5300", pendingBg: "#fbf1e3", pendingBd: "#ecd2ad",
    danger: "#c8102e", dangerBg: "#fdecef", dangerBd: "#f3b9c3",
    sevCritical: "#c8102e", sevHigh: "#f26b5b", sevLow: "#00897b",
    sevCriticalBg: "#fdecef", sevHighBg: "#fdeeec", sevLowBg: "#e3f4f1",
    vBetter: "#00796b", vWorse: "#c8102e",
  },
  dark: {
    ok: "#4dd0c0", okBg: "rgba(0, 137, 123, 0.2)", okBd: "rgba(77, 208, 192, 0.45)",
    danger: "#ff6b81", dangerBg: "rgba(200, 16, 46, 0.22)", dangerBd: "rgba(255, 107, 129, 0.45)",
    sevCritical: "#ff6b81", sevHigh: "#ff9e80", sevLow: "#4dd0c0",
    sevCriticalBg: "rgba(200, 16, 46, 0.22)", sevHighBg: "rgba(242, 107, 91, 0.2)",
    sevLowBg: "rgba(0, 137, 123, 0.2)",
    vBetter: "#4dd0c0", vWorse: "#ff6b81",
  },
};

// High contrast darkens the quiet type and the rules, and takes the brand blue
// to a shade that clears 4.5:1 as text on white (#009fdf is 3:1).
const HIGH_CONTRAST: Record<Mode, Patch> = {
  light: {
    brand: "#00709e", brandStrong: "#005a80", brandBorder: "#5fa9c9",
    navFg: "#25323d", navFgActive: "#005a80",
    text: "#000000", text2: "#1f2c37", text3: "#33424e",
    border: "#8d99a3", borderStrong: "#5c6873",
  },
  dark: {
    brand: "#6fd0f7", brandStrong: "#a1e1fa", brandBorder: "rgba(111, 208, 247, 0.7)",
    navFg: "#e1e8ed", navFgActive: "#a1e1fa",
    canvas: "#000000",
    text: "#ffffff", text2: "#e1e8ed", text3: "#c7d1d8",
    border: "#6b7783", borderStrong: "#94a0ab",
  },
};

const VISION: Record<ColorVision, Record<Mode, Patch> | null> = {
  typical: null,
  "red-green": RED_GREEN,
  "blue-yellow": BLUE_YELLOW,
};

export function isTypical(a: Access): boolean {
  return a.contrast === "standard" && a.colorVision === "typical";
}

/** One mode's palette with a person's contrast and colour vision applied. */
export function accessiblePalette(p: Palette, mode: Mode, a: Access = typicalAccess): Palette {
  if (isTypical(a)) return p;
  const vision = VISION[a.colorVision]?.[mode] ?? {};
  const contrast = a.contrast === "high" ? HIGH_CONTRAST[mode] : {};
  return { ...p, ...vision, ...contrast };
}
