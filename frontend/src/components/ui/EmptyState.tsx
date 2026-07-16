import type { ReactNode } from "react";
import { Button } from "antd";

// EmptyState replaces the bare AntD Empty in recomposed flows: an icon in a
// soft circle, a one-line title, a one-line hint and an optional action.
export default function EmptyState({
  icon,
  title,
  hint,
  actionLabel,
  onAction,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--sp-2)",
        padding: "var(--sp-8) var(--sp-4)",
        textAlign: "center",
      }}
    >
      {icon && (
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            background: "var(--brand-soft)",
            color: "var(--brand)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 20,
            marginBottom: "var(--sp-1)",
          }}
        >
          {icon}
        </div>
      )}
      <div style={{ fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--text)" }}>{title}</div>
      {hint && <div style={{ fontSize: "var(--fs-12)", color: "var(--text-2)", maxWidth: 420 }}>{hint}</div>}
      {actionLabel && onAction && (
        <Button type="primary" size="small" onClick={onAction} style={{ marginTop: "var(--sp-2)" }}>
          {actionLabel}
        </Button>
      )}
      {children}
    </div>
  );
}
