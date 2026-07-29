import { useState } from "react";
import { Button, Modal, Segmented, Typography } from "antd";
import { changedSummary, condense, diffValues, LONG_VALUE, type DiffPart } from "../../valuediff";
import { fmtValue } from "../../rules";

// ValueDiff is THE way Configer shows one value becoming another: the review
// modal, the inspector, the change history and the approvals detail all render
// through it, so "what changed" reads the same everywhere.
//
// The rule it follows is that a value change is only reviewable if the reader
// can see the CHANGE, not just the two values. A short value shows whole,
// before struck in red and after in green. A long one is condensed to the
// edited stretches with an ellipsis standing in for the identical text between
// them, and "View details" opens the full pair with the same highlighting. The
// colors are the ones every comparison tool uses (removed red, added green)
// because a reviewer should not have to learn our vocabulary to read a diff.

function Marks({ parts, side }: { parts: DiffPart[]; side: "before" | "after" }) {
  // The before side shows what was there (unchanged + removed); the after side
  // shows what will be there (unchanged + added). Rendering both sides from one
  // part list is what keeps the two columns aligned on their common text.
  const keep = side === "before" ? "del" : "ins";
  return (
    <>
      {parts
        .filter((p) => p.op === "same" || p.op === keep)
        .map((p, i) =>
          p.op === "same" ? (
            <span key={i}>{p.text}</span>
          ) : (
            <mark key={i} className={side === "before" ? "vd-del" : "vd-ins"}>
              {p.text}
            </mark>
          ),
        )}
    </>
  );
}

/** InlineValueDiff renders one side's text with its changes marked, condensed
 *  to the edited stretches when the value is long. */
export function InlineValueDiff({
  parts,
  side,
  condensed = true,
}: {
  parts: DiffPart[];
  side: "before" | "after";
  condensed?: boolean;
}) {
  const shown = condensed ? condense(parts) : parts;
  const empty = shown.every((p) => !p.text);
  if (empty) return <span className="vd-empty">(empty)</span>;
  return (
    <span className={`vd-side mono${condensed ? " vd-condensed" : ""}`}>
      <Marks parts={shown} side={side} />
    </span>
  );
}

export default function ValueDiff({
  before,
  after,
  /** how the pair is laid out inline: side by side with an arrow (tables), or
   *  stacked (the narrow inspector rail). */
  layout = "row",
  label,
}: {
  before: unknown;
  after: unknown;
  layout?: "row" | "stacked";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"changes" | "full">("changes");

  const b = fmtValue(before);
  const a = fmtValue(after);
  const parts = diffValues(b === "-" ? "" : b, a === "-" ? "" : a);
  const stats = changedSummary(parts);
  const long = b.length > LONG_VALUE || a.length > LONG_VALUE;

  const pair = (
    <span className={layout === "row" ? "vd-pair" : "vd-pair vd-pair-stacked"}>
      <InlineValueDiff parts={parts} side="before" />
      <span className="vd-arrow" aria-hidden>
        →
      </span>
      <InlineValueDiff parts={parts} side="after" />
    </span>
  );

  if (!long) return pair;

  return (
    <>
      <span className="vd-wrap">
        {pair}
        <Button type="link" size="small" className="vd-more" onClick={() => setOpen(true)}>
          View details
        </Button>
      </span>
      <Modal
        title={label ? `What changed in ${label}` : "What changed"}
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={820}
      >
        <div className="vd-modal">
          <div className="vd-modal-head">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {stats.edits === 0
                ? "The values are identical."
                : `${stats.edits} edit${stats.edits === 1 ? "" : "s"} · ${stats.removed} character${
                    stats.removed === 1 ? "" : "s"
                  } removed, ${stats.added} added, in a value of ${a.length} characters.`}
            </Typography.Text>
            <Segmented
              size="small"
              value={view}
              onChange={(v) => setView(v as "changes" | "full")}
              options={[
                { label: "Just the changes", value: "changes" },
                { label: "Full value", value: "full" },
              ]}
            />
          </div>
          <div className="vd-block vd-block-before">
            <span className="vd-block-tag">Before</span>
            <InlineValueDiff parts={parts} side="before" condensed={view === "changes"} />
          </div>
          <div className="vd-block vd-block-after">
            <span className="vd-block-tag">After</span>
            <InlineValueDiff parts={parts} side="after" condensed={view === "changes"} />
          </div>
        </div>
      </Modal>
    </>
  );
}
