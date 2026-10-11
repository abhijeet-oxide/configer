import type { ReactNode } from "react";

/** The tint behind a card's mark. Status tones are for panels ABOUT state. */
export type CardIconTone = "brand" | "ok" | "review" | "pending" | "danger" | "neutral";

/**
 * A card's title: the name, an optional second line, and the subject's state
 * beside it. Pass the result as `SectionCard`'s `title`, with `extra` for the
 * controls.
 *
 * `icon` and `tone` are accepted and not drawn. A tinted tile beside every
 * card title made each panel as loud as the numbers in it; the stat tiles keep
 * theirs, because a tile IS its figure.
 */
export default function CardHead({
  title,
  sub,
  status,
}: {
  icon?: ReactNode;
  tone?: CardIconTone;
  title: ReactNode;
  /** A second line under the name: what the panel is counting, or over what. */
  sub?: ReactNode;
  /** The subject's state, stated beside its name - a pill, usually. */
  status?: ReactNode;
}) {
  return (
    <>
      <span className="ui-card-head-name">
        <span className="ui-card-head-line">
          <span className="ui-card-head-text">{title}</span>
          {status}
        </span>
        {sub && <span className="ui-card-head-sub">{sub}</span>}
      </span>
    </>
  );
}

/**
 * One figure in a row of them.
 *
 * The label is above the value rather than beside it, because these are read
 * as a row: eyes travel across the values and drop to a label only for the one
 * that surprised them.
 */
export function Figure({ label, value }: { label: ReactNode; value: ReactNode }) {
  const displayValue = value === "Not measured"
    ? <span className="slm-quiet-value">{value}</span>
    : value

  return (
    <div className="ui-figure">
      <div className="ui-figure-label">{label}</div>
      <div className="ui-figure-value">{displayValue}</div>
    </div>
  );
}
