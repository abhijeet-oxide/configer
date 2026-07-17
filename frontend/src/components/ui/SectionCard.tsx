import type { CSSProperties, ReactNode } from "react";

// SectionCard is the standard content surface: a neumorphic card (soft dual
// shadow, no hard border) with an optional title row and a right-side action
// ("View all"). Use grouping and whitespace first; reach for a card only when
// the composition calls for one.
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
    <div className="flex min-w-0 flex-col rounded-card-lg bg-surface shadow-neu" style={style}>
      {(title || extra) && (
        <div className="flex items-center justify-between gap-2 px-4 py-3 text-[13px] font-semibold text-ink">
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{title}</span>
          {extra && <span className="shrink-0 font-normal">{extra}</span>}
        </div>
      )}
      <div
        className={`min-w-0 flex-1 ${padded ? (title || extra ? "px-4 pb-4" : "p-4") : "overflow-hidden rounded-card-lg"}`}
        style={bodyStyle}
      >
        {children}
      </div>
    </div>
  );
}
