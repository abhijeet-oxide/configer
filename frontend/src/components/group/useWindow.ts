import { useCallback, useEffect, useMemo, useState } from "react";

// Windowing over a list whose row heights are KNOWN in advance.
//
// The group editor can be opened on a branch holding seven hundred settings.
// Every one of them is a label and a real form control, and mounting seven
// hundred of those is a second and a half of blocked main thread - during which
// nothing has happened on screen, so the click reads as ignored and the dialog
// reads as broken. Rendering only what is on screen turns that into the twenty
// or so the frame can hold.
//
// Heights are known rather than measured, which is what keeps this small: a
// field is a label over one control, and the two variants (an ordinary field, a
// wide one holding a list or a paragraph) are fixed sizes the layout already
// commits to. Knowing them means one prefix-sum pass and a binary search per
// scroll, with no measure-render-remeasure loop and no rows jumping as their
// real heights arrive.

export interface Windowed {
  /** first row to render (inclusive) */
  start: number;
  /** last row to render (exclusive) */
  end: number;
  /** pixels of nothing standing in for the rows above `start` */
  padTop: number;
  /** pixels of nothing standing in for the rows below `end` */
  padBottom: number;
  /** the scroller's measured width, for callers that lay out by column count */
  width: number;
}

/** The first index whose row bottom is past `y`. Binary search, because a
 *  linear scan per scroll event is the thing being avoided. */
function firstAfter(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * @param ref       the scrolling element
 * @param heights   every row's height, in order
 * @param overscan  rows to render beyond each edge, so a fast scroll does not
 *                  show a band of nothing before React catches up
 */
export function useWindow(
  ref: React.RefObject<HTMLElement | null>,
  heights: number[],
  overscan = 6,
): Windowed {
  // Cumulative tops: offsets[i] is where row i starts, offsets[n] is the total.
  // One pass per change of the row model, not one per scroll.
  const offsets = useMemo(() => {
    const next = new Array<number>(heights.length + 1);
    next[0] = 0;
    for (let i = 0; i < heights.length; i++) next[i + 1] = next[i] + heights[i];
    return next;
  }, [heights]);

  const [box, setBox] = useState({ top: 0, height: 0, width: 0 });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setBox((prev) =>
      prev.top === el.scrollTop && prev.height === el.clientHeight && prev.width === el.clientWidth
        ? prev
        : { top: el.scrollTop, height: el.clientHeight, width: el.clientWidth },
    );
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    // Scroll is passive: this only reads geometry and sets state, so there is
    // nothing to preventDefault and no reason to hold up the scroll for it.
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [ref, measure]);

  const total = offsets[heights.length] ?? 0;
  // Before the first measurement the height is 0, which would render nothing at
  // all and leave the dialog looking empty. Assume a screenful until the real
  // box arrives one frame later.
  const viewport = box.height || 600;
  const first = Math.max(0, firstAfter(offsets, box.top) - overscan);
  const last = Math.min(heights.length, firstAfter(offsets, box.top + viewport) + 1 + overscan);

  return {
    start: first,
    end: last,
    padTop: offsets[first] ?? 0,
    padBottom: Math.max(0, total - (offsets[last] ?? total)),
    width: box.width,
  };
}
