import brand from "../brand";

// BrandMark is the product's logo tile, resolved once from `brand.ts` (an
// image, an inline SVG, or a text glyph). Every surface that shows the mark -
// the navigation rail, the phone header, the boot screen - renders THIS, so
// the identity can never differ between window sizes or states.
//
// The TILE is this app's own presentation: a rounded plate carrying the mark,
// which is what its icon rail is built around. The shared kit offers a plainer
// BrandMark/BrandLockup for a tool whose navigation wants one; both read the
// same identity, so what the mark IS never differs between tools - only how
// this product's chrome frames it.
export default function BrandMark({ size = 28 }: { size?: number }) {
  const style =
    size === 28
      ? undefined
      : {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.29),
          fontSize: Math.round(size * 0.5),
        };
  if (brand.logo.src) {
    return <img className="logo-tile" src={brand.logo.src} alt={brand.appName} style={style} />;
  }
  if (brand.logo.svg) {
    return <span className="logo-tile" style={style} dangerouslySetInnerHTML={{ __html: brand.logo.svg }} />;
  }
  return (
    <div className="logo-tile" style={style}>
      {brand.logo.text ?? brand.appName.charAt(0)}
    </div>
  );
}
