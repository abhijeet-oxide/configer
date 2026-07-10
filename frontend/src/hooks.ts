import { useEffect, useRef, useState } from "react";

// useElementSize observes an element with a single shared ResizeObserver per
// hook instance and reports its content size. Used to auto-fit grid columns
// and virtual-list heights to the available space instead of hardcoding
// pixels: no polling, no memory churn.
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: Math.round(box.width), height: Math.round(box.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, ...size };
}
