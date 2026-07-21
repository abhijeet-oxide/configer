import type { Plugin } from "vite";
import { theme, renderRootCss, faviconHref, ACTIVE_PRESET } from "../src/theme.config";

// Build-time theming: inlines the brand color variables into <head> (so there
// is no flash of the wrong theme), and sets the favicon and <title> from the
// single theme.config.ts. Runs for both `vite dev` and `vite build`.
export default function brandPlugin(): Plugin {
  return {
    name: "configer-brand",
    transformIndexHtml(html) {
      const style = `<style id="brand-tokens">${renderRootCss()}</style>`;
      const icon = `<link rel="icon" href="${faviconHref(theme.favicon)}" />`;
      const title = `${theme.appName} - ${theme.tagline}`;

      let out = html;
      // Stamp the active preset on <html> at parse time (no flash). CSS scopes
      // both the palette and the flat/soft elevation to :root[data-preset=...].
      if (ACTIVE_PRESET && ACTIVE_PRESET !== "default") {
        out = out.replace(/<html(\s|>)/, `<html data-preset="${ACTIVE_PRESET}"$1`);
      }
      // Replace the title text.
      out = out.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
      // Drop any existing favicon <link> so ours is authoritative.
      out = out.replace(/[ \t]*<link[^>]*rel=["']icon["'][^>]*>\s*\n?/gi, "");
      // Inject the generated tokens + favicon right before </head>.
      out = out.replace(/<\/head>/, `    ${style}\n    ${icon}\n  </head>`);
      return out;
    },
  };
}
