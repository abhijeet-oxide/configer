import type { ReactNode } from "react";

// PageHeader standardizes the top block of every screen: a strong title, an
// optional description in secondary text, and a right-aligned actions slot.
export default function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** optional extra row under the title (context chips, filter tabs) */
  children?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: "var(--sp-4)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-3)", minWidth: 0 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: "var(--fs-20)",
              fontWeight: 650,
              color: "var(--text)",
              lineHeight: 1.25,
              display: "flex",
              alignItems: "center",
              gap: "var(--sp-2)",
              minWidth: 0,
              flexWrap: "wrap",
            }}
          >
            {title}
          </div>
          {description && (
            <div style={{ fontSize: "var(--fs-13)", color: "var(--text-2)", marginTop: 2 }}>{description}</div>
          )}
        </div>
        {actions && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexShrink: 0 }}>{actions}</div>
        )}
      </div>
      {children}
    </div>
  );
}
