import { useMemo } from "react";
import { Button, Tooltip } from "antd";
import type { ParamChange, ParamHistoryEntry } from "../api";
import { STATUS, statusColor, statusOf, typeMark, type FlowStatus } from "../changestatus";
import { relTime } from "./DashboardView";

// One parameter's value, told as the story of the decisions that shaped it.
//
// The Change Flow does this for a whole application, horizontally, at full
// screen width. This does it for ONE value in a side panel four hundred pixels
// wide, and the narrowness is the whole design constraint: the picture runs
// downwards, newest first, and a change hangs off the trunk to the right rather
// than travelling along a lane of its own.
//
// It exists because the commit log cannot answer the question people bring
// here. "Why does this say 9090?" is not answered by a list of hashes; it is
// answered by "CR-14 raised it, Priya approved it, and the CR-9 that asked for
// 9443 first was turned down because it had no ticket". The first half of that
// is in git. The second half is not, and never can be: a rejected change
// reaches no commit, so a log will never mention it however far back it reads.
// So the trunk and the change requests are drawn together, and the refused ones
// are as visible as the ones that landed - which is the point, because the
// refused one is what somebody is standing here trying to understand.
//
// The rules are the Change Flow's rules, at a tenth of the size:
//
//   colour  means status, and nothing else. Red is only ever "this did not
//           happen".
//   a state is never said in one channel alone - it is a colour AND a line
//           style AND a node shape, so the picture survives being small,
//           printed, or read by somebody who cannot separate the hues.
//   a shape says what a node is: a filled dot is a commit, a ring with a core
//           is where a change came back in, a dashed ring has not landed yet,
//           a crossed circle never will.

/** Rail geometry. The rail is drawn per ROW rather than as one overlay across
 *  the whole list, so every y is a constant this file knows rather than
 *  something measured off the DOM after layout - which is what makes the
 *  picture correct at first paint and after a refetch, with no reflow pass. */
const RAIL_W = 30;
/** Where the trunk line runs, and where a fork's node sits. */
const TRUNK_X = 10;
const FORK_X = 26;
/** The node's height inside its row: level with the first line of text beside
 *  it, so a dot always points at the thing it labels. */
const NODE_Y = 13;
/** The least a row can be. Rows size to their CONTENT and the rail stretches to
 *  match, so this is a floor for a sparse row rather than a height anything is
 *  padded out to. */
const MIN_ROW = 30;

type Row =
  | { kind: "trunk"; key: string; at: string; entry: ParamHistoryEntry; change: ParamChange | null }
  | { kind: "fork"; key: string; at: string; change: ParamChange };

/** A value as it should be read: an empty string is a value, and "not defined"
 *  is a different thing again. Neither may be shown as blank space, because
 *  blank space reads as "nothing happened here". */
function shown(v: string, present = true): string {
  if (!present) return "(not defined)";
  return v === "" ? "(empty)" : v;
}

/** The node at a row's rail: SHAPE says what kind of moment this was, before
 *  any colour is read at all. */
function Node({ kind, tone }: { kind: "commit" | "merge" | "pending" | "rejected"; tone: string }) {
  if (kind === "merge")
    return (
      <>
        <circle cx={TRUNK_X} cy={NODE_Y} r={5} fill="var(--surface)" stroke={tone} strokeWidth={2} />
        <circle cx={TRUNK_X} cy={NODE_Y} r={1.9} fill={tone} />
      </>
    );
  if (kind === "commit") return <circle cx={TRUNK_X} cy={NODE_Y} r={3.4} fill={tone} />;
  if (kind === "pending")
    return (
      <circle
        cx={FORK_X}
        cy={NODE_Y}
        r={4.4}
        fill="var(--surface)"
        stroke={tone}
        strokeWidth={1.8}
        strokeDasharray="2.6 3"
      />
    );
  // Rejected: a circle with a cross through it. It never became anything, and
  // the shape says so without needing the red to be seen.
  return (
    <>
      <circle cx={FORK_X} cy={NODE_Y} r={4.6} fill="var(--surface)" stroke={tone} strokeWidth={1.8} />
      <line x1={FORK_X - 2.6} y1={NODE_Y - 2.6} x2={FORK_X + 2.6} y2={NODE_Y + 2.6} stroke={tone} strokeWidth={1.6} />
      <line x1={FORK_X + 2.6} y1={NODE_Y - 2.6} x2={FORK_X - 2.6} y2={NODE_Y + 2.6} stroke={tone} strokeWidth={1.6} />
    </>
  );
}

/** One row's rail: the trunk running through it, and - on a fork row - the
 *  curve out of the commit the change left from.
 *
 *  The list is newest first, so the commit a change forked FROM is below it.
 *  The curve therefore leaves the bottom of the rail and rises to the right,
 *  which is exactly the shape a reader already knows from a branch diagram
 *  turned on its side. */
function Rail({ row, first, last }: { row: Row; first: boolean; last: boolean }) {
  const tone = row.kind === "fork" ? statusColor(statusOf(row.change.state)) : "var(--cf-node, var(--text-2))";
  const status: FlowStatus | null = row.kind === "fork" ? statusOf(row.change.state) : null;
  // The trunk is drawn with PERCENTAGES, which <line> understands, so it fills
  // whatever height the row's text turns out to need. The fork curve is drawn
  // with absolute numbers, because a path's `d` does not accept percentages at
  // all - a `100%` in there is not a long line, it is a line that never
  // renders. It is a short peel-off just below the node rather than a sweep
  // from the row's floor, which says the same thing and cannot depend on a
  // height nothing here knows.
  // The svg is ABSOLUTELY POSITIONED inside a plain div, and that div is the
  // thing sitting in the row. An <svg> is a REPLACED element: given no height
  // it falls back to its intrinsic 150px, so every row in this picture was at
  // least that tall and two consecutive commits sat an inch apart with nothing
  // whatsoever between them. Taking it out of flow hands the row's height back
  // to the text, which is the only thing that should be deciding it.
  return (
    <div className="pf-railwrap" style={{ flexBasis: RAIL_W, width: RAIL_W }}>
      <svg className={`pf-rail${status ? ` is-${status}` : ""}`} aria-hidden="true">
        {/* The trunk. It runs the full height of every row except where the
            picture actually ends, so the line never stops mid-story. A last row
            that is a FORK still has trunk below it - older commits the window
            simply did not reach - so only a last TRUNK row closes the line
            off. */}
        <line
          className="pf-trunk"
          x1={TRUNK_X}
          y1={first && row.kind === "trunk" ? NODE_Y : 0}
          x2={TRUNK_X}
          y2={last && row.kind === "trunk" ? NODE_Y : "100%"}
        />
        {row.kind === "fork" && (
          <path
            className="pf-fork"
            d={`M${TRUNK_X},${NODE_Y + 20} C${TRUNK_X},${NODE_Y + 9} ${FORK_X},${NODE_Y + 13} ${FORK_X},${NODE_Y}`}
            fill="none"
            stroke={tone}
          />
        )}
        {row.kind === "trunk" ? (
          <Node kind={row.change ? "merge" : "commit"} tone={tone} />
        ) : (
          <Node kind={row.change.state === "rejected" ? "rejected" : "pending"} tone={tone} />
        )}
      </svg>
    </div>
  );
}

/** What to call a change on a row: its number, or plainly a draft, which has
 *  no number because it is not a change request yet. */
const refOf = (c: ParamChange) => (c.number ? `CR-${c.number}` : c.state === "draft" ? "Draft" : `CR-${c.id}`);

/** The one edit worth putting on the row. A change usually touches this cell
 *  once; when it touches several (a global edit plus an instance override) the
 *  first is shown and the rest counted, because the row is one line wide. */
function editLine(c: ParamChange) {
  const e = c.edits[0];
  if (!e) return null;
  const more = c.edits.length - 1;
  return (
    <div className="pf-values">
      <span className="pf-old mono">{shown(e.old)}</span>
      <span className="pf-to">
        <span className="pf-arrow">→</span>
        <span className="pf-new mono">{e.action === "set" ? shown(e.new) : e.action}</span>
      </span>
      {e.instance && <span className="pf-scope">{e.instance}</span>}
      {e.scope === "global" && <span className="pf-scope">all instances</span>}
      {more > 0 && <span className="pf-scope">+{more} more</span>}
    </div>
  );
}

export default function ParameterFlow({
  entries,
  changes,
  onResume,
  resuming,
  canResume,
  onOpenChange,
}: {
  entries: ParamHistoryEntry[];
  changes: ParamChange[];
  /** resume a rejected change's work into the reader's draft */
  onResume?: (id: number) => void;
  resuming?: number | null;
  canResume?: boolean;
  onOpenChange?: (id: number) => void;
}) {
  const rows = useMemo<Row[]>(() => {
    // A PUBLISHED change is not drawn as a fork: it is already on the trunk,
    // and the commit that carries it names it. Drawing both would say the same
    // thing twice and, worse, imply the change is still out there waiting.
    const landed = new Set(
      entries.map((e) => e.changeId).filter((id): id is number => typeof id === "number" && id > 0),
    );
    const byId = new Map(changes.map((c) => [c.id, c]));

    const trunk = entries.map((e): Row => ({
      kind: "trunk",
      key: e.sha,
      at: e.date,
      entry: e,
      change: e.changeId ? (byId.get(e.changeId) ?? null) : null,
    }));
    const forks = changes
      .filter((c) => c.state !== "published" && !landed.has(c.id))
      .map((c): Row => ({ kind: "fork", key: `cr-${c.id}`, at: c.updatedAt || c.createdAt, change: c }));

    // One list, newest first. A change that is still out there sits above the
    // commit it forked from, which is where the eye expects the thing that has
    // not happened yet.
    return [...trunk, ...forks].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  }, [entries, changes]);

  if (rows.length === 0) return null;

  return (
    <div className="pf">
      {rows.map((row, i) => {
        const first = i === 0;
        const last = i === rows.length - 1;
        return (
          <div
            className={`pf-row${row.kind === "fork" ? " is-fork" : ""}`}
            key={row.key}
            style={{ minHeight: MIN_ROW }}
          >
            <Rail row={row} first={first} last={last} />
            <div className="pf-body">
              {row.kind === "trunk" ? (
                <TrunkRow entry={row.entry} change={row.change} oldest={last} onOpenChange={onOpenChange} />
              ) : (
                <ForkRow
                  change={row.change}
                  changes={changes}
                  onResume={onResume}
                  resuming={resuming}
                  canResume={canResume}
                  onOpenChange={onOpenChange}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A value the repository really had, and the reviewed decision that put it
 *  there. A commit that came out of no change request (an onboarding write, a
 *  push made outside Configer) simply says so by naming nobody - which is
 *  itself worth seeing. */
function TrunkRow({
  entry,
  change,
  oldest,
  onOpenChange,
}: {
  entry: ParamHistoryEntry;
  change: ParamChange | null;
  /** the last row the window reaches. Its "changed" is not a fact about this
   *  commit - it is where the reading stopped - so it is not claimed. */
  oldest: boolean;
  onOpenChange?: (id: number) => void;
}) {
  return (
    <div className={entry.changed ? "" : "pf-quiet"}>
      <div className="pf-values">
        <span className={`pf-new mono${entry.changed ? " is-set" : ""}`}>{shown(entry.value, entry.present)}</span>
        {entry.changed && !oldest && <span className="pf-tag">changed</span>}
      </div>
      {change && (
        <div className="pf-crline">
          <button type="button" className="pf-crlink" onClick={() => onOpenChange?.(change.id)}>
            {refOf(change)}
          </button>
          <span className="pf-crtitle">{change.title}</span>
          {change.approvals ? (
            <Tooltip title={`${change.approvals} sign-off${change.approvals === 1 ? "" : "s"} on this change`}>
              <span className="pf-tag is-ok">approved</span>
            </Tooltip>
          ) : null}
        </div>
      )}
      <div className="pf-meta">
        <Tooltip title={entry.message || undefined}>
          <span className="mono">{entry.short}</span>
        </Tooltip>
        <span>·</span>
        <span>{entry.author}</span>
        <span>·</span>
        <span>{relTime(entry.date)}</span>
      </div>
    </div>
  );
}

/** A proposal that is not on the trunk: still being written, waiting on
 *  somebody, cleared but not shipped, or refused. */
function ForkRow({
  change,
  changes,
  onResume,
  resuming,
  canResume,
  onOpenChange,
}: {
  change: ParamChange;
  changes: ParamChange[];
  onResume?: (id: number) => void;
  resuming?: number | null;
  canResume?: boolean;
  onOpenChange?: (id: number) => void;
}) {
  const status = statusOf(change.state);
  const look = STATUS[status];
  const mark = typeMark(change.category);
  const successor = change.resumedInto ? changes.find((c) => c.id === change.resumedInto) : null;
  const predecessor = change.resumedFrom ? changes.find((c) => c.id === change.resumedFrom) : null;

  return (
    <div className={`pf-fork-body is-${status}`}>
      <div className="pf-crline">
        <button type="button" className="pf-crlink" onClick={() => onOpenChange?.(change.id)}>
          {refOf(change)}
        </button>
        <span className="pf-crtitle">{change.title}</span>
        <Tooltip title={mark.label}>
          <span className="pf-type" aria-label={mark.label}>
            {mark.icon}
          </span>
        </Tooltip>
      </div>
      {editLine(change)}
      <div className="pf-meta">
        <Tooltip title={look.words}>
          <span className="pf-state">{look.label}</span>
        </Tooltip>
        <span>·</span>
        <span>{change.author}</span>
        <span>·</span>
        <span>{relTime(change.updatedAt || change.createdAt)}</span>
        {change.branch && (
          <>
            <span>·</span>
            <Tooltip title="The branch this change's work is on">
              <span className="mono pf-branch">{change.branch}</span>
            </Tooltip>
          </>
        )}
      </div>
      {/* Why it was turned down, in the reviewer's own words. This is the line
          the reader came for, so it is on the row and not behind a click. */}
      {change.state === "rejected" && change.rejectReason && (
        <div className="pf-reason">
          &ldquo;{change.rejectReason}&rdquo;
          {change.rejectedBy && <span className="pf-by"> - {change.rejectedBy}</span>}
        </div>
      )}
      {/* Lineage. A rejection that was picked up again is a step, not a dead
          end, and the reader should be able to follow the same piece of work
          forward rather than reading two unrelated edits to one value. */}
      {successor && (
        <div className="pf-lineage">
          Picked up again as{" "}
          <button type="button" className="pf-crlink" onClick={() => onOpenChange?.(successor.id)}>
            {refOf(successor)}
          </button>
        </div>
      )}
      {predecessor && (
        <div className="pf-lineage">
          Carries the work of{" "}
          <button type="button" className="pf-crlink" onClick={() => onOpenChange?.(predecessor.id)}>
            {refOf(predecessor)}
          </button>
        </div>
      )}
      {/* Resume is offered only where it is the answer: refused work that
          nobody has already picked up. */}
      {change.state === "rejected" && canResume && !successor && onResume && (
        <Button
          size="small"
          className="pf-resume"
          loading={resuming === change.id}
          onClick={() => onResume(change.id)}
        >
          Resume this change
        </Button>
      )}
    </div>
  );
}
