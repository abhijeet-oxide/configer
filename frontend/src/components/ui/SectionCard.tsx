import type { CSSProperties, ReactNode } from "react";

// SectionCard is the standard content surface: white, subtle border, level-1
// elevation, optional title row with a right-side action ("View all"). Use
// grouping and whitespace first; reach for a card only when the reference
// composition calls for one.
export default function SectionCard({
  title,
  extra,
  children,
  style,
  bodyStyle,
  padded = true,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  padded?: boolean;
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        boxShadow: "var(--el-1)",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        ...style,
      }}
    >
      {(title || extra) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--sp-2)",
            padding: "var(--sp-3) var(--sp-4)",
            fontSize: "var(--fs-13)",
            fontWeight: 600,
            color: "var(--text)",
          }}
        >
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </span>
          {extra && <span style={{ flexShrink: 0, fontWeight: 400 }}>{extra}</span>}
        </div>
      )}
      <div
        style={{
          padding: padded ? `${title || extra ? "0" : "var(--sp-4)"} var(--sp-4) var(--sp-4)` : 0,
          minWidth: 0,
          flex: 1,
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}
