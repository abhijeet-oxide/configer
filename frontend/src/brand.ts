import type { BrandIdentity } from "./uikit";

// WHO THIS DEPLOYMENT IS. The one file that says "Configer".
//
// Everything else visual - the palette, the spacing, the controls, the
// primitives - comes from `uikit/`, the design system this tool shares byte for
// byte with every other tool on the platform (see uikit/README.md). This file
// is the deliberate exception, and the reason the shared folder can be copied
// over the top of this repository without breaking it: two products that look
// the same must still say which one you are looking at.
//
// So a rebrand is this file plus `uikit/tokens.ts`, and nothing else.

const brand: BrandIdentity = {
  appName: "Configer",
  tagline: "Configuration Lifecycle Management",
  navCaption: "CONFIG LIFECYCLE",
  // Configuration LAYERS: a solid top plate over two receding echo edges - the
  // base layer and the instance overlays stacked on top. Symmetrical about the
  // vertical axis; the layers gently breathe (animated in index.css, paused
  // under prefers-reduced-motion). Rounded joins keep it soft, not spiky.
  logo: {
    svg:
      "<svg class='cfg-mark' width='19' height='19' viewBox='0 0 24 24' fill='none' " +
      "stroke-linejoin='round' stroke-linecap='round' xmlns='http://www.w3.org/2000/svg'>" +
      "<path class='cfg-bot' d='M3.6 15.3 L12 19.8 L20.4 15.3' stroke='white' stroke-width='1.9' stroke-opacity='0.32'/>" +
      "<path class='cfg-mid' d='M3.6 11.6 L12 16.1 L20.4 11.6' stroke='white' stroke-width='1.9' stroke-opacity='0.58'/>" +
      "<path class='cfg-top' d='M12 3.6 L20.6 8 L12 12.4 L3.4 8 Z' fill='white'/></svg>",
  },
  favicon:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
    "<rect width='32' height='32' rx='8' fill='#0057b8'/>" +
    "<g fill='none' stroke='white' stroke-linejoin='round' stroke-linecap='round'>" +
    "<path d='M8 20.4 L16 24.6 L24 20.4' stroke-width='2.4' stroke-opacity='0.32'/>" +
    "<path d='M8 16.9 L16 21.1 L24 16.9' stroke-width='2.4' stroke-opacity='0.58'/>" +
    "<path d='M16 6.4 L24 10.5 L16 14.6 L8 10.5 Z' fill='white' stroke='none'/></g></svg>",
};

export default brand;
