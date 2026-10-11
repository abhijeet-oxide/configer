import type { CSSProperties } from "react";
import type { BrandIdentity } from "../brand";

// The product's mark and name, drawn the same way in every tool.
//
// They take the identity as a PROP rather than importing it, which is the rule
// that keeps this folder copyable: a shared component that reached for
// "../brand" would be a shared component that hardcodes one product's name.

/** The mark on its brand-coloured plate: the form the product wears in the
 *  navigation, on a boot screen, and beside a sign-in card. One component, so
 *  the identity cannot differ between window sizes or states. */
export function BrandMark({
  brand,
  size = 28,
  /** draw the plate; off gives the bare glyph, for a dark surface that already
   *  provides the ground */
  tile = true,
  style,
}: {
  brand: BrandIdentity;
  size?: number;
  tile?: boolean;
  style?: CSSProperties;
}) {
  if (brand.logo.bare) tile = false;
  const box: CSSProperties = {
    width: size,
    height: size,
    borderRadius: tile ? Math.round(size * 0.29) : 0,
    fontSize: Math.round(size * 0.5),
    ...style,
  };
  const cls = `ui-mark${tile ? " is-tile" : ""}`;
  if (brand.logo.src) {
    return <img className={cls} src={brand.logo.src} alt={brand.appName} style={box} />;
  }
  if (brand.logo.svg) {
    // Scripts in SVG run under innerHTML. They do not run when the SVG is an image.
    const src = `data:image/svg+xml;utf8,${encodeURIComponent(brand.logo.svg)}`;
    return <img className={cls} src={src} alt={brand.appName} style={box} />;
  }
  return (
    <span className={cls} style={box}>
      {brand.logo.text ?? brand.appName.charAt(0)}
    </span>
  );
}

/** A name with its first word in the brand colour and the rest in the text
 *  colour: the one way a product or platform name is written. */
export function Wordmark({ name, className }: { name: string; className?: string }) {
  const at = name.indexOf(" ");
  return (
    <span className={`ui-wordmark${className ? ` ${className}` : ""}`}>
      <span className="ui-wordmark-lead">{at < 0 ? name : name.slice(0, at)}</span>
      {at >= 0 && <> <span className="ui-wordmark-rest">{name.slice(at + 1)}</span></>}
    </span>
  );
}

/**
 * The mark, the name, and what the product does, as one block.
 *
 * The text column is explicitly start-aligned, and that is load-bearing rather
 * than tidy. These two lines are different widths - the caption is nearly
 * always the wider one - so on any surface that centres its text (a boot card,
 * a sign-in card) the short name floats to the middle of the box the caption
 * sized, and reads as a mark with a hole punched between it and its own name.
 * A lockup must align to itself, never to whatever it was dropped into.
 */
export function BrandLockup({
  brand,
  caption = true,
  size = 28,
  tile = true,
  /** the caption text; defaults to the brand's own nav caption */
  captionText,
  /** name colour: the navigation's own foreground by default */
  onDark = false,
  style,
}: {
  brand: BrandIdentity;
  caption?: boolean;
  size?: number;
  tile?: boolean;
  captionText?: string;
  onDark?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={`ui-lockup${onDark ? " on-dark" : ""}`} style={style}>
      <BrandMark brand={brand} size={size} tile={tile} />
      <div className="ui-lockup-text">
        <Wordmark name={brand.appName} className="ui-lockup-name" />
        {caption && (captionText ?? brand.navCaption) && (
          <span className="ui-lockup-caption">{captionText ?? brand.navCaption}</span>
        )}
      </div>
    </div>
  );
}
