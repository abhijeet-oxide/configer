import type { FontScale } from "./prefs.ts";

export interface TypographyScale {
  badge: number;
  micro: number;
  caption: number;
  small: number;
  body: number;
  label: number;
  subtitle: number;
  emphasis: number;
  title: number;
  heading: number;
  section: number;
  display: number;
  hero: number;
  metric: number;
}

export const typography: Record<FontScale, TypographyScale> = {
  small: {
    badge: 8,
    micro: 9,
    caption: 10,
    small: 11,
    body: 12,
    label: 13,
    subtitle: 14,
    emphasis: 15,
    title: 17,
    heading: 19,
    section: 21,
    display: 22,
    hero: 29,
    metric: 42,
  },
  normal: {
    badge: 9,
    micro: 10,
    caption: 11,
    small: 12,
    body: 13,
    label: 14,
    subtitle: 15,
    emphasis: 16,
    title: 18,
    heading: 20,
    section: 22,
    display: 24,
    hero: 32,
    metric: 44,
  },
  large: {
    badge: 10,
    micro: 11,
    caption: 12,
    small: 13,
    body: 15,
    label: 16,
    subtitle: 17,
    emphasis: 18,
    title: 20,
    heading: 22,
    section: 24,
    display: 27,
    hero: 35,
    metric: 48,
  },
  xlarge: {
    badge: 11,
    micro: 12,
    caption: 13,
    small: 15,
    body: 17,
    label: 18,
    subtitle: 19,
    emphasis: 20,
    title: 22,
    heading: 25,
    section: 27,
    display: 30,
    hero: 38,
    metric: 52,
  },
};

export const typographyVariableNames: Record<keyof TypographyScale, `--text-${string}`> = {
  badge: "--text-badge",
  micro: "--text-micro",
  caption: "--text-caption",
  small: "--text-small",
  body: "--text-body",
  label: "--text-label",
  subtitle: "--text-subtitle",
  emphasis: "--text-emphasis",
  title: "--text-title",
  heading: "--text-heading",
  section: "--text-section",
  display: "--text-display",
  hero: "--text-hero",
  metric: "--text-metric",
};

export function typographyVariables(scale: FontScale): Array<[string, string]> {
  const values = typography[scale];
  return Object.entries(typographyVariableNames).map(([role, variable]) => [
    variable,
    `${values[role as keyof TypographyScale]}px`,
  ]);
}
