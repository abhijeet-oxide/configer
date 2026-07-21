import { GithubOutlined, LockOutlined, DatabaseOutlined, ApiOutlined } from "../icons";

// Shared visual language for source plugins: an icon and an accent color per
// plugin, driven by the manifest's own `icon`/`color` hints so a new provider
// styles itself without touching this file (the switch is only a fallback).

export function sourceIcon(iconSlug?: string): React.ReactNode {
  switch (iconSlug) {
    case "git":
      return <GithubOutlined />;
    case "vault":
      return <LockOutlined />;
    case "database":
      return <DatabaseOutlined />;
    default:
      return <ApiOutlined />;
  }
}

// sourceHex maps an AntD-style color name to a concrete accent, preferring the
// product's semantic CSS tokens so light/dark themes stay consistent.
export function sourceHex(color?: string): string {
  switch (color) {
    case "orange":
      return "var(--c-pending)";
    case "gold":
      return "#d4a017";
    case "blue":
      return "var(--c-review)";
    case "green":
      return "var(--c-ok)";
    case "purple":
      return "#6c3df4";
    case "red":
      return "var(--c-danger)";
    case "magenta":
      return "#c41d7f";
    default:
      return "var(--brand)";
  }
}
