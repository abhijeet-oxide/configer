import type { CSSProperties, ReactNode } from "react";

// StatTile is the reference's stat card: a quiet label, a strong value, an
// optional sub-line and an optional leading icon. Clickable tiles lift on
// hover (via .card-clickable) and navigate to the place the number came from.
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
      className={onClick ? "card-clickable" : undefined}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        boxShadow: "var(--el-1)",
        padding: "var(--sp-3) var(--sp-4)",
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-3)",
        minWidth: 0,
        cursor: onClick ? "pointer" : undefined,
        ...style,
      }}
    >
      {icon && (
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: "var(--r-md)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            fontSize: 16,
          }}
        >
          {icon}
        </div>
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "var(--fs-12)", color: "var(--text-2)", marginBottom: 2, whiteSpace: "nowrap" }}>
          {label}
        </div>
        <div style={{ fontSize: "var(--fs-20)", fontWeight: 650, color: "var(--text)", lineHeight: 1.2 }}>
          {value}
        </div>
        {sub && (
          <div style={{ fontSize: "var(--fs-11)", color: "var(--text-3)", marginTop: 2, whiteSpace: "nowrap" }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}
