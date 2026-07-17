import { motion, useReducedMotion } from "framer-motion";
import { CheckOutlined } from "../../icons";

// Stepper is the product's one progress indicator for multi-step flows
// (import, onboarding, new application). It is a single clean row: a numbered
// node per step with a one-line label, joined by a connector that fills with
// the brand color as the user advances. Completed steps collapse to a check;
// the current step carries a soft brand ring. Deliberately compact and
// single-line so labels never wrap into the cramped two-row look of a raw
// component stepper.

export interface StepDef {
  /** short, single-word-ish label */
  label: string;
  /** optional glyph shown on upcoming/active nodes instead of the number */
  icon?: React.ReactNode;
}

export default function Stepper({
  steps,
  current,
  className,
}: {
  steps: StepDef[];
  /** zero-based index of the active step */
  current: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <div className={`flex items-start ${className ?? ""}`} role="list" aria-label="Progress">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const nodeColor = done || active ? "var(--brand)" : "var(--surface-2)";
        const numColor = done || active ? "#fff" : "var(--text-3)";
        return (
          <div key={s.label} className="flex min-w-0 flex-1 items-start" role="listitem">
            {/* Node + label, centered as a column. */}
            <div className="flex min-w-0 flex-col items-center gap-1.5" style={{ flex: "0 0 auto" }}>
              <motion.div
                className="relative flex size-8 items-center justify-center rounded-full text-[13px] font-semibold"
                style={{
                  background: nodeColor,
                  color: numColor,
                  border: done || active ? "none" : "1.5px solid var(--border-strong)",
                  boxShadow: active ? "0 0 0 4px color-mix(in srgb, var(--brand) 18%, transparent)" : undefined,
                }}
                initial={false}
                animate={reduce ? {} : { scale: active ? 1.06 : 1 }}
                transition={{ duration: 0.2, ease: [0.2, 0.8, 0.4, 1] }}
              >
                {done ? (
                  <motion.span
                    initial={reduce ? false : { scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.2 }}
                    className="flex items-center"
                  >
                    <CheckOutlined style={{ fontSize: 13 }} />
                  </motion.span>
                ) : s.icon ? (
                  <span style={{ fontSize: 14, display: "inline-flex" }}>{s.icon}</span>
                ) : (
                  i + 1
                )}
              </motion.div>
              <span
                className="max-w-[9rem] truncate text-center text-xs leading-tight"
                style={{
                  color: active ? "var(--text)" : done ? "var(--text-2)" : "var(--text-3)",
                  fontWeight: active ? 600 : 400,
                }}
                title={s.label}
              >
                {s.label}
              </span>
            </div>
            {/* Connector to the next node; fills brand once this step is done. */}
            {i < steps.length - 1 && (
              <div className="relative mx-1 mt-4 h-0.5 flex-1 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
                <motion.div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ background: "var(--brand)" }}
                  initial={false}
                  animate={{ width: done ? "100%" : "0%" }}
                  transition={{ duration: reduce ? 0 : 0.35, ease: [0.2, 0.8, 0.4, 1] }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
