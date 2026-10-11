import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { stepCritical } from "../spring";

/**
 * The one movement between one screen and the next.
 *
 * A change of page is the most frequent transition in either product. What
 * used to happen was a keyframe that remounted this element, so every route
 * began at opacity 0. A second click threw that frame away and started again,
 * which reads as a jump rather than as a change of mind.
 *
 * Opacity now springs from the value already on screen. Leaving fades the
 * current page out; arriving fades the next one in from that same opacity,
 * velocity included. Clicking back before the fade finishes reverses it.
 * There is no slide and no bounce. Reduced motion swaps at full opacity.
 *
 * The scroller is found by walking up from this element rather than being
 * passed in, so nothing here needs to know which frame it is inside. Scroll
 * resets when the next page is actually shown, and with `auto` rather than
 * `smooth`: two animations over the same pixels is the stutter, not the cure.
 */

// Two legs (out, then in). Shorter than the shared 0.35s response so the pair
// stays near the old 200ms entrance.
const PAGE_RESPONSE = 0.16;

type Held = { key: string; node: ReactNode };

function reducedNow(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function settled(value: number, velocity: number, target: number): boolean {
  return Math.abs(value - target) < 0.01 && Math.abs(velocity) < 0.05;
}

export default function PageTransition({
  routeKey,
  children,
  /** leave the scroll where it is - for a view whose tabs are part of the key */
  keepScroll = false,
  /**
   * Fill the frame instead of flowing in it.
   *
   * A shell mounted `flush` hands its page the whole height and lets the panes
   * inside manage their own scrolling, so anything wrapped around that page has
   * to be as tall as the page or the panes collapse. An ordinary page ignores
   * this and stays a block in the normal flow.
   */
  fill = false,
}: {
  routeKey: string;
  children: ReactNode;
  keepScroll?: boolean;
  fill?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef({ value: 1, velocity: 0 });
  const frame = useRef(0);
  const entered = useRef(false);
  const seen = useRef<Held>({ key: routeKey, node: children });
  const [reduced, setReduced] = useState(reducedNow);
  const [leaving, setLeaving] = useState<Held | null>(null);

  // Remember the tree we are on. When the route changes, hold that tree for
  // the fade out instead of swapping it for a new element at opacity 0.
  if (seen.current.key !== routeKey) {
    const from = seen.current;
    seen.current = { key: routeKey, node: children };
    if (!reduced) {
      if (leaving?.key === routeKey) setLeaving(null);
      else if (!leaving) setLeaving(from);
    }
  } else {
    seen.current = { key: routeKey, node: children };
  }

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useLayoutEffect(() => {
    if (keepScroll || leaving) return;
    const scroller = ref.current?.closest(".ui-shell-page");
    scroller?.scrollTo({ top: 0, behavior: "auto" });
  }, [routeKey, keepScroll, leaving]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    cancelAnimationFrame(frame.current);

    if (reduced) {
      live.current = { value: 1, velocity: 0 };
      el.style.opacity = "";
      if (leaving) setLeaving(null);
      return;
    }

    if (!entered.current) {
      entered.current = true;
      live.current = { value: 0, velocity: 0 };
    }

    const target = leaving ? 0 : 1;
    el.style.opacity = String(live.current.value);

    if (settled(live.current.value, live.current.velocity, target)) {
      live.current = { value: target, velocity: 0 };
      el.style.opacity = target === 1 ? "" : "0";
      if (target === 0) setLeaving(null);
      return;
    }

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const next = stepCritical(
        live.current.value,
        live.current.velocity,
        target,
        dt,
        PAGE_RESPONSE,
      );
      live.current = next;
      if (settled(next.value, next.velocity, target)) {
        live.current = { value: target, velocity: 0 };
        el.style.opacity = target === 1 ? "" : "0";
        if (target === 0) setLeaving(null);
        return;
      }
      el.style.opacity = next.value.toFixed(3);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [routeKey, leaving, reduced]);

  return (
    <div ref={ref} className={`ui-page${fill ? " is-fill" : ""}`}>
      {leaving ? leaving.node : children}
    </div>
  );
}
