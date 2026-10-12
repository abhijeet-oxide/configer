import brand from "../brand";
import { BrandMark as SharedBrandMark } from "../uikit";

// BrandMark is the product's mark, resolved once from `brand.ts`. Every surface
// that shows it - the navigation rail, the phone header, the boot screen -
// renders THIS. Like Software Gateway, it is a thin binding onto the shared
// kit's BrandMark, so the AT&T globe draws identically in both tools; the kit
// leaves the plate off for a `bare` mark that carries its own colour.
export default function BrandMark({ size = 28 }: { size?: number }) {
  return <SharedBrandMark brand={brand} size={size} />;
}
