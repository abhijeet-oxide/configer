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
      className={`flex min-h-10 min-w-0 shrink-0 items-center gap-2 bg-surface px-3 ${
        border ? "border-b border-line" : ""
      }`}
      style={style}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{left}</div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}
