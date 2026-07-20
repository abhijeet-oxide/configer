import { Tooltip } from "antd";
import { motion, useReducedMotion } from "framer-motion";
import { CheckOutlined } from "../../icons";

// Stepper is the product's one progress indicator for every multi-step flow
// (import, onboarding, new application) AND the change-request lifecycle - one
// component so the steppers never diverge. It is a single clean row: a
// numbered node per step with a one-line label, joined by a connector that
// fills with the brand color as the user advances. Completed steps collapse to
// a check; the current step carries a soft brand ring. The row is centered and
// its steps are evenly distributed edge to edge (the last node sits flush, not
// trailed by an empty connector slot), so it never looks left-packed. Labels
// stay single-line so they never wrap into the cramped two-row look of a raw
// component stepper.

export interface StepDef {
  /** short, single-word-ish label */
  label: string;
  /** optional glyph shown on upcoming/active nodes instead of the number */
  icon?: React.ReactNode;
  /** optional tooltip explaining the step */
  explain?: React.ReactNode;
  /** render this step in the danger tone (e.g. a rejected change request) */
  error?: boolean;
}

export default function Stepper({
  steps,
  current,
  className,
  ariaLabel = "Progress",
}: {
  steps: StepDef[];
  /** zero-based index of the active step */
  current: number;
  className?: string;
  ariaLabel?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <div
      className={`mx-auto flex w-full max-w-[640px] items-start ${className ?? ""}`}
      role="list"
      aria-label={ariaLabel}
    >
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const isErr = !!s.error;
        const filled = done || active;
        const last = i === steps.length - 1;
        const accent = isErr ? "var(--c-danger)" : "var(--brand)";
        const nodeColor = isErr ? "var(--c-danger)" : filled ? "var(--brand)" : "var(--surface-2)";
        const numColor = isErr || filled ? "#fff" : "var(--text-3)";
        const node = (
          <motion.div
            className="relative flex size-8 items-center justify-center rounded-full text-[13px] font-semibold"
            style={{
              background: nodeColor,
              color: numColor,
              border: isErr || filled ? "none" : "1.5px solid var(--border-strong)",
              boxShadow: active ? `0 0 0 4px color-mix(in srgb, ${accent} 18%, transparent)` : undefined,
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
        );
        return (
          // The last step shrinks to its content so the connectors (flex-1)
          // share all the slack evenly and the final node lands flush right -
          // no trailing gap that would pull the row off-center.
          <div
            key={s.label}
            className="flex min-w-0 items-start"
            style={{ flex: last ? "0 0 auto" : "1 1 0%" }}
            role="listitem"
          >
            {/* Node + label, centered as a column. */}
            <div className="flex min-w-0 flex-col items-center gap-1.5" style={{ flex: "0 0 auto" }}>
              {s.explain ? <Tooltip title={s.explain}>{node}</Tooltip> : node}
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
            {!last && (
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
