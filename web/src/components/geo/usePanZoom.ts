import { useCallback, useRef, useState } from "react";

// Pan and zoom over an SVG, in the SVG's own coordinates.
//
// A map of an estate that cannot be moved is a picture of an estate. Three
// sites on one campus are one dot until somebody can get closer, and "which of
// these four is the one in trouble" is exactly the question a map is opened to
// answer. So: drag to move, wheel to zoom at the pointer, double click to step
// in, and buttons and arrow keys for everybody not using a mouse.
//
// The transform is applied to a single <g>; nothing is ever re-projected, so
// zooming stays smooth however much geometry is on screen. Screen coordinates
// are converted through the SVG's own CTM rather than by measuring the element
// and doing the arithmetic here, which is what keeps the maths right whatever
// preserveAspectRatio the caller chose.

export interface Transform {
  k: number;
  x: number;
  y: number;
}

export const IDENTITY: Transform = { k: 1, x: 0, y: 0 };

const MIN_K = 1;
const MAX_K = 14;

const clampK = (k: number) => Math.min(Math.max(k, MIN_K), MAX_K);

export function usePanZoom(width: number, height: number) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [t, setT] = useState<Transform>(IDENTITY);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);

  /** A client point in the SVG's own coordinates. */
  const toLocal = useCallback((clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return [width / 2, height / 2];
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y];
  }, [width, height]);

  /** Keep the picture inside the frame: at k=1 it is exactly the frame, and
   *  zoomed in it may not be dragged past its own edges. Without this the map
   *  can be thrown off screen and the only way back is the reset button. */
  const clamp = useCallback(
    (next: Transform): Transform => {
      const k = clampK(next.k);
      const maxX = 0;
      const minX = width - width * k;
      const maxY = 0;
      const minY = height - height * k;
      return {
        k,
        x: Math.min(Math.max(next.x, minX), maxX),
        y: Math.min(Math.max(next.y, minY), maxY),
      };
    },
    [width, height],
  );

  /** Zoom by a factor about a fixed point in SVG coordinates, so whatever is
   *  under the pointer stays under the pointer. */
  const zoomAbout = useCallback(
    (factor: number, cx: number, cy: number) =>
      setT((prev) => {
        const k = clampK(prev.k * factor);
        const real = k / prev.k; // the factor that actually applied after clamping
        return clamp({ k, x: cx - (cx - prev.x) * real, y: cy - (cy - prev.y) * real });
      }),
    [clamp],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      const [cx, cy] = toLocal(e.clientX, e.clientY);
      zoomAbout(Math.pow(0.998, e.deltaY), cx, cy);
    },
    [toLocal, zoomAbout],
  );

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const svg = svgRef.current;
      const ctm = svg?.getScreenCTM();
      if (!ctm) return;
      // Convert the movement through the matrix WITHOUT its translation, so a
      // drag moves the map by exactly the distance the pointer travelled.
      const dx = (e.clientX - d.x) / ctm.a;
      const dy = (e.clientY - d.y) / ctm.d;
      if (Math.abs(e.clientX - d.x) > 3 || Math.abs(e.clientY - d.y) > 3) d.moved = true;
      d.x = e.clientX;
      d.y = e.clientY;
      setT((prev) => clamp({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    },
    [clamp],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  /** Whether the gesture that just ended was a drag rather than a click. A pin
   *  must not open its instance because somebody let go of the map on top of
   *  it. */
  const wasDragged = useCallback(() => drag.current?.moved === true, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      const step = 40;
      const center = [width / 2, height / 2] as const;
      switch (e.key) {
        case "ArrowLeft":
          setT((p) => clamp({ ...p, x: p.x + step }));
          break;
        case "ArrowRight":
          setT((p) => clamp({ ...p, x: p.x - step }));
          break;
        case "ArrowUp":
          setT((p) => clamp({ ...p, y: p.y + step }));
          break;
        case "ArrowDown":
          setT((p) => clamp({ ...p, y: p.y - step }));
          break;
        case "+":
        case "=":
          zoomAbout(1.4, center[0], center[1]);
          break;
        case "-":
        case "_":
          zoomAbout(1 / 1.4, center[0], center[1]);
          break;
        case "0":
          setT(IDENTITY);
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    [clamp, zoomAbout, width, height],
  );

  /** Frame a box of the drawing area - how "fit to instances" works. */
  const fitTo = useCallback(
    (box: { minX: number; minY: number; maxX: number; maxY: number } | null) => {
      if (!box) {
        setT(IDENTITY);
        return;
      }
      const pad = 60;
      const w = Math.max(box.maxX - box.minX + pad * 2, 80);
      const h = Math.max(box.maxY - box.minY + pad * 2, 80);
      const k = clampK(Math.min(width / w, height / h));
      const cx = (box.minX + box.maxX) / 2;
      const cy = (box.minY + box.maxY) / 2;
      setT(clamp({ k, x: width / 2 - cx * k, y: height / 2 - cy * k }));
    },
    [clamp, width, height],
  );

  return {
    svgRef,
    transform: t,
    reset: () => setT(IDENTITY),
    zoomIn: () => zoomAbout(1.5, width / 2, height / 2),
    zoomOut: () => zoomAbout(1 / 1.5, width / 2, height / 2),
    fitTo,
    wasDragged,
    handlers: {
      onWheel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      onDoubleClick: (e: React.MouseEvent<SVGSVGElement>) => {
        const [cx, cy] = toLocal(e.clientX, e.clientY);
        zoomAbout(1.8, cx, cy);
      },
    },
  };
}
