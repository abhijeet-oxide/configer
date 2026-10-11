import type { CSSProperties, ReactNode } from "react";
import type { CardIconTone } from "./CardHead";

// StatTile is the one number-on-a-card in the system: a quiet label, a strong
// value, an optional sub-line and leading icon. A clickable tile lifts under
// the pointer and goes to where the number came from - a number nobody can
// open is a number nobody can check.
export default function StatTile({
  label,
  value,
  sub,
  icon,
  tone,
  quiet = false,
  onClick,
  aside,
  style,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  /** Tint on the icon well. Same tones as CardHead, so a row of tiles and a
   *  row of panels read as one system. */
  tone?: CardIconTone;
  /** A zero, or any figure that should recede rather than shout. */
  quiet?: boolean;
  onClick?: () => void;
  /** A small picture of the figure at the tile's right edge: a trend, a split. */
  aside?: ReactNode;
  style?: CSSProperties;
}) {
  const iconClass = `ui-stat-icon${tone ? ` tone-${tone}` : ""}`;
  return (
    <div
      className={`ui-stat${onClick ? " is-clickable" : ""}${quiet ? " is-quiet" : ""}`}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      style={style}
    >
      {icon && <div className={iconClass}>{icon}</div>}
      <div className="ui-stat-main">
        <div className="ui-stat-label">{label}</div>
        <div className="ui-stat-value ui-num">{value}</div>
        {sub && <div className="ui-stat-sub">{sub}</div>}
      </div>
      {aside && <div className="ui-stat-aside">{aside}</div>}
    </div>
  );
}
