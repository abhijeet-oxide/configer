import type { CSSProperties, ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

// The product's motion vocabulary, built on framer-motion and kept deliberately
// small: content fades in with a gentle rise (FadeIn), and collections cascade
// with a short stagger (Stagger + StaggerItem). Timing mirrors the CSS motion
// tokens (--dur-view 300ms, --ease); reduced-motion users get instant content.
// The virtualized parameter grid stays out of this on purpose.

const EASE = [0.2, 0.8, 0.4, 1] as const;

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
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      style={style}
      initial={reduce ? false : { opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE } },
};

export function Stagger({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const reduce = useReducedMotion();
  if (reduce) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }
  return (
    <motion.div className={className} style={style} variants={container} initial="hidden" animate="show">
      {children}
    </motion.div>
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
  const reduce = useReducedMotion();
  if (reduce) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }
  return (
    <motion.div className={className} style={style} variants={item}>
      {children}
    </motion.div>
  );
}
