import type { CSSProperties, ReactNode } from "react";

// StatusPill is THE status chip of the design system: a pastel tinted pill
// with a dot and a short label. Tones map to the semantic palette in
// tokens.css. Use it for operational state (Synced, Pending review, Failing,
// Active); never for environment identity (that is EnvTag's job).

export type PillTone = "ok" | "pending" | "review" | "danger" | "neutral";

const TONE_CLASS: Record<PillTone, string> = {
  ok: "bg-ok-bg border-ok-bd text-ok",
  pending: "bg-pending-bg border-pending-bd text-pending",
  review: "bg-review-bg border-review-bd text-review",
  danger: "bg-danger-bg border-danger-bd text-danger",
  neutral: "bg-surface-2 border-line text-ink-2",
};

export function StatusPill({
  tone,
  children,
  dot = true,
  icon,
  size = "md",
  style,
  title,
}: {
  tone: PillTone;
  children: ReactNode;
  /** show the leading status dot (skipped automatically when an icon is given) */
  dot?: boolean;
  icon?: ReactNode;
  size?: "sm" | "md";
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={style}
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium leading-none whitespace-nowrap align-middle ${
        size === "sm" ? "h-[18px] px-2 text-[11px]" : "h-[22px] px-2.5 text-xs"
      } ${TONE_CLASS[tone]}`}
    >
      {icon ?? (dot && <span className="size-1.5 shrink-0 rounded-full bg-current" />)}
      {children}
    </span>
  );
}

// ChangeChip labels a diff row the way the reference does: Modified (blue),
// Added (green), Removed (red), Unchanged (neutral).
export type ChangeKind = "modified" | "added" | "removed" | "unchanged";

const CHANGE_TONE: Record<ChangeKind, PillTone> = {
  modified: "review",
  added: "ok",
  removed: "danger",
  unchanged: "neutral",
};
const CHANGE_LABEL: Record<ChangeKind, string> = {
  modified: "Modified",
  added: "Added",
  removed: "Removed",
  unchanged: "Unchanged",
};

export function ChangeChip({ kind, size = "sm" }: { kind: ChangeKind; size?: "sm" | "md" }) {
  return (
    <StatusPill tone={CHANGE_TONE[kind]} dot={false} size={size}>
      {CHANGE_LABEL[kind]}
    </StatusPill>
  );
}
