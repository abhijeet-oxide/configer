import { flushSync } from "react-dom";
import { useUI } from "./store";
import type { Mode } from "./theme";

// toggleThemeWithReveal flips light/dark with a radial reveal: the new theme
// spreads as a growing circle from the point that was clicked, via the View
// Transitions API. Browsers without the API, reduced-motion users, and calls
// without a click point all fall back to an instant switch. The DOM theme
// attributes are set synchronously inside the transition callback so the
// old/new snapshots are exact.

export function toggleThemeWithReveal(point?: { x: number; y: number }) {
  const { mode, setMode } = useUI.getState();
  const next: Mode = mode === "dark" ? "light" : "dark";
  const apply = () => {
    flushSync(() => setMode(next));
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
  };

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof document.startViewTransition !== "function" || reduce || !point) {
    apply();
    return;
  }

  const { x, y } = point;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = document.startViewTransition(apply);
  transition.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`],
        },
        {
          duration: 550,
          easing: "cubic-bezier(0.2, 0.8, 0.4, 1)",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => {
      // The transition could not start (e.g. another one is running): the
      // theme is applied either way, only the reveal is skipped.
    });
}
