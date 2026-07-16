import type { CSSProperties, ReactNode } from "react";

// StatusPill is THE status chip of the design system: a soft tinted pill with
// a dot and a short label. Tones map to the semantic palette in tokens.css.
// Use it for operational state (Synced, Pending review, Failing, Active);
// never for environment identity (that is EnvTag's job).

export type PillTone = "ok" | "pending" | "review" | "danger" | "neutral";

const TONES: Record<PillTone, { fg: string; bg: string; bd: string }> = {
  ok: { fg: "var(--c-ok)", bg: "var(--c-ok-bg)", bd: "var(--c-ok-bd)" },
  pending: { fg: "var(--c-pending)", bg: "var(--c-pending-bg)", bd: "var(--c-pending-bd)" },
  review: { fg: "var(--c-review)", bg: "var(--c-review-bg)", bd: "var(--c-review-bd)" },
  danger: { fg: "var(--c-danger)", bg: "var(--c-danger-bg)", bd: "var(--c-danger-bd)" },
  neutral: { fg: "var(--text-2)", bg: "var(--surface-2)", bd: "var(--border)" },
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
  const t = TONES[tone];
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: size === "sm" ? "0 7px" : "1px 9px",
        height: size === "sm" ? 18 : 22,
        borderRadius: "var(--r-pill)",
        background: t.bg,
        border: `1px solid ${t.bd}`,
        color: t.fg,
        fontSize: size === "sm" ? "var(--fs-11)" : "var(--fs-12)",
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: "nowrap",
        verticalAlign: "middle",
        ...style,
      }}
    >
      {icon ??
        (dot && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: "currentColor",
              flexShrink: 0,
            }}
          />
        ))}
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
