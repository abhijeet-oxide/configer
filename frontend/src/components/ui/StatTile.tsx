import type { CSSProperties, ReactNode } from "react";

// StatTile is the reference's stat card in soft-UI: a quiet label, a strong
// value, an optional sub-line and leading icon, resting on a neumorphic
// surface. Clickable tiles lift on hover and go to where the number came from.
export default function StatTile({
  label,
  value,
  sub,
  icon,
  onClick,
  style,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-3 rounded-card bg-surface px-4 py-3 shadow-neu ${
        onClick ? "card-clickable cursor-pointer" : ""
      }`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      style={style}
    >
      {icon && (
        <div className="flex size-[34px] shrink-0 items-center justify-center rounded-md text-base">
          {icon}
        </div>
      )}
      {/* The sub-line is a sentence, not a metric: it has to wrap inside the
          tile rather than run past its edge. whitespace-nowrap kept "Types and
          rules pass - not a deployment safety check" on one line, so the card
          clipped it mid-word. The label and the value stay on one line - they
          are short by construction - but truncate rather than overflow. */}
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 truncate text-xs text-ink-2">{label}</div>
        <div className="text-xl leading-tight font-semibold text-ink break-words">{value}</div>
        {sub && <div className="mt-0.5 text-[11px] leading-snug text-ink-3">{sub}</div>}
      </div>
    </div>
  );
}
