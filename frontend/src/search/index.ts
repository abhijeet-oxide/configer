// The search barrel. Importing it wires up the whole framework: registering the
// commands and the built-in providers (both for their import side effects), and
// re-exporting the pieces the UI consumes. Anything that renders search imports
// from here.
import "../commands"; // register commands
import "./providers"; // register built-in providers

export { useSearchOpen } from "./open";
export { queryAll } from "./registry";
export { resolveTarget } from "./resolveTarget";
export type {
  SearchHit,
  SearchContext,
  SearchScope,
  SearchData,
  Nav,
  AppCtx,
  Target,
  HitType,
} from "./types";
