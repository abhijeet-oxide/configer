import type { CSSProperties, ReactNode } from "react";

// Toolbar is the compact control strip above a working surface: one 40px row,
// 8px gaps, a bottom hairline. Left content leads, right content trails.
export default function Toolbar({
  left,
  right,
  style,
  border = true,
}: {
  left?: ReactNode;
  right?: ReactNode;
  style?: CSSProperties;
  border?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        minHeight: 40,
        padding: "0 var(--sp-3)",
        borderBottom: border ? "1px solid var(--border)" : undefined,
        background: "var(--surface)",
        flexShrink: 0,
        minWidth: 0,
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0, flex: 1 }}>{left}</div>
      {right && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexShrink: 0 }}>{right}</div>
      )}
    </div>
  );
}
