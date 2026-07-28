import type { CSSProperties, ReactNode } from "react";

// The product's motion vocabulary, kept deliberately small: content fades in
// with a gentle rise (FadeIn), and collections cascade with a short stagger
// (Stagger + StaggerItem). The virtualized parameter grid stays out of this on
// purpose.
//
// These are CSS animations (see "Motion vocabulary" in index.css), not a
// JavaScript animation runtime. Three fades and a stagger did not justify
// framer-motion, which cost 371 KB (122 KB gzipped) in the ENTRY bundle -
// downloaded by every visitor before anything renders - to express what
// @keyframes expresses for nothing. Timing comes from the same motion tokens
// the rest of the app uses (--dur-view, --ease), so the vocabulary cannot drift
// from the CSS surfaces, and reduced-motion is handled by the stylesheet.

export function FadeIn({
  children,
  delay = 0,
  y = 8,
  className,
  style,
}: {
  children: ReactNode;
  delay?: number;
  /** initial rise distance in px */
  y?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`cfg-fade-in${className ? ` ${className}` : ""}`}
      style={{ "--rise": `${y}px`, "--delay": `${delay}s`, ...style } as CSSProperties}
    >
      {children}
    </div>
  );
}

export function Stagger({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`cfg-stagger${className ? ` ${className}` : ""}`} style={style}>
      {children}
    </div>
  );
}

export function StaggerItem({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  // The cascade delay comes from this element's position under .cfg-stagger,
  // so items stay ordinary children and callers pass nothing extra.
  return (
    <div className={`cfg-stagger-item${className ? ` ${className}` : ""}`} style={style}>
      {children}
    </div>
  );
}
