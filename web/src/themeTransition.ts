// The theme reveal moved into the shared design system, where every tool that
// mounts a ThemeProvider gets it: `useTheme().toggleMode(point)` reveals, and
// the kit's own toggle button already passes the point. Kept at this path so
// the existing call sites did not have to move.
//
// It reads the provider now rather than this app's store, which is what let it
// be shared at all - and since the provider here is controlled BY that store,
// the store is still the truth.
export { revealThemeChange, pointOf } from "./uikit";
