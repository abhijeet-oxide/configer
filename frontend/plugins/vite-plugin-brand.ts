import brandPlugin from "../src/uikit/vitePluginBrand";
import brand from "../src/brand";

// Kept at its old path so vite.config.ts does not have to move; the plugin
// itself lives in uikit/ now, identical to the copy in every other tool. It
// takes the brand as an argument rather than importing it, which is the rule
// that keeps the shared folder copyable: nothing inside it names a product.
export default function configerBrandPlugin() {
  return brandPlugin(brand);
}
