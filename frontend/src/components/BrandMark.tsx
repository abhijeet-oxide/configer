import { theme as brand } from "../theme.config";

// BrandMark is the product's logo tile, resolved once from the brand config
// (an image, an inline SVG, or a text glyph). Every surface that shows the mark
// - the navigation rail, the phone header, the boot screen - renders THIS, so
// the identity can never differ between window sizes or states.
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
