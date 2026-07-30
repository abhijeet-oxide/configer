import { useMemo, useState } from "react";
import { Tooltip, App as AntApp } from "antd";
import { CheckOutlined, TagOutlined } from "../icons";
import { relTime } from "./DashboardView";
import UserAvatar from "./UserAvatar";
import type { BranchLane, ChangeRequest, ChangeState, TimelineEntry } from "../api";

// ChangeGraph draws the application's history the way somebody would draw it on
// a whiteboard: the trunk running down the page, the standing environment
// branches running down beside it, and every change request as a line that
// LEAVES the trunk at one commit, carries a card, and either comes back in at
// another commit, ends unmerged, or ends in a cross.
//
// A commit list cannot answer the questions this view exists for - are two
// changes out at once, did they leave from the same commit, is prod behind
// main, which one was rejected - because a list has no shape. Here the shape IS
// the answer, and the rules are few enough to hold in your head:
//
//   colour     green   the trunk, always
//              orange  published: it left and came back
//              blue    still out: a draft, or waiting on a reviewer
//              red     rejected: it left and never came back
//              others  a standing environment branch, one colour each
//   dot        a commit. Hover for its full id, click to copy it.
//   star       the trunk's head - where the application is right now.
//   card       one change request, sitting ON its own branch line between the
//              commit it forked from and the commit it merged into.
//   cross      the end of a line that never rejoined.
//
// Everything is anchored to real commits: a fork leaves the exact dot it was
// based on, a merge enters the exact dot that brought it in, and two changes
// from one commit leave from that one dot together.

const PAD_TOP = 40;
const PAD_BOTTOM = 34;
const ROW_H = 44;
const LANE_W = 46;
const CARD_W = 268;
const CARD_H = 104;
const CARD_GAP = 16;
/** how far the first change-request column sits from the last standing lane */
const CR_OFFSET = 44;
const CR_COL_W = CARD_W + 34;
const DOT_R = 6;
const BEND = 14;
/** vertical clearance between the runs of changes that share a fork commit */
const RUN_STEP = 9;

/** The state palette, exactly as the graph's legend states it. */
const STATE: Record<ChangeState, { color: string; label: string; dashed: boolean }> = {
  draft: { color: "var(--cg-open)", label: "Draft, not sent for review", dashed: true },
  under_review: { color: "var(--cg-open)", label: "Out for review", dashed: true },
  approved: { color: "var(--cg-open)", label: "Approved, not published yet", dashed: true },
  published: { color: "var(--cg-published)", label: "Published", dashed: false },
  rejected: { color: "var(--cg-rejected)", label: "Rejected in review", dashed: true },
};

/** Standing branches get their own colours; the trunk is always green. */
const ENV_COLORS = ["var(--cg-env-1)", "var(--cg-env-2)", "var(--cg-env-3)", "var(--cg-env-4)"];

interface CrPlacement {
  cr: ChangeRequest;
  /** row index it forked from, and the row it merged into (null if it never did) */
  forkRow: number;
  mergeRow: number | null;
  col: number;
}

export default function ChangeGraph({
  snapshots,
  lanes,
  head,
  changes,
  onOpenChange,
  onOpenCommit,
}: {
  /** the trunk, newest first */
  snapshots: TimelineEntry[];
  /** the standing branches beside it, the trunk first */
  lanes: BranchLane[];
  /** the trunk's head commit */
  head: string;
  changes: ChangeRequest[];
  onOpenChange: (cr: ChangeRequest) => void;
  onOpenCommit: (sha: string) => void;
}) {
  const trunkLane = lanes.find((l) => l.trunk);
  const envLanes = useMemo(() => lanes.filter((l) => !l.trunk), [lanes]);

  // Anchor every change to the commits it really touched: the row it forked
  // from and, if it landed, the row that brought it in. A change whose commits
  // are off the end of the window in view still gets drawn, anchored to the
  // nearest row it can be - it happened, and leaving it out would say it did not.
  const placements = useMemo<CrPlacement[]>(() => {
    const rowOf = (sha?: string) => (sha ? snapshots.findIndex((s) => s.sha === sha) : -1);
    const rowByTime = (iso: string) => {
      const t = new Date(iso).getTime();
      // Rows run newest-first, so the row a change was based on is the first
      // one at or before its creation.
      const i = snapshots.findIndex((s) => new Date(s.date).getTime() <= t);
      return i >= 0 ? i : Math.max(0, snapshots.length - 1);
    };

    const ordered = [...changes]
      .filter((c) => c.state !== "draft" || (c.items?.length ?? 0) > 0)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // A column per change, reused whenever two changes cannot collide.
    const busy: [number, number][][] = [];
    const out: CrPlacement[] = [];
    for (const cr of ordered) {
      const fr = rowOf(cr.baseSha);
      const forkRow = fr >= 0 ? fr : rowByTime(cr.createdAt);
      const mr = rowOf(cr.mergeSha);
      const mergeRow =
        cr.state === "published"
          ? mr >= 0 && mr < forkRow
            ? mr
            : Math.max(0, forkRow - 1)
          : null;
      // The vertical band the change occupies, in rows. An unmerged change
      // still needs room above its fork for its card.
      const top = mergeRow ?? forkRow - 1;
      const span: [number, number] = [Math.min(top, forkRow) - 0.5, forkRow + 0.5];

      let col = 0;
      while (busy[col]?.some(([a, b]) => span[0] < b && a < span[1])) col++;
      (busy[col] ??= []).push(span);
      out.push({ cr, forkRow, mergeRow, col });
    }
    return out;
  }, [changes, snapshots]);

  // Row heights. A row is one line tall until a change's card has to fit
  // between its fork and its merge, at which point the rows in between grow to
  // make room - so the card sits ON its branch rather than beside it.
  // How much room the picture needs above its first row: an unmerged change
  // hangs its card above the commit it forked from, and the topmost one of
  // those would otherwise be drawn off the top of the box.
  const headroom = useMemo(() => {
    const needsRoom = placements.some((p) => p.mergeRow == null && p.forkRow === 0);
    return needsRoom ? CARD_H + CARD_GAP * 2 : 0;
  }, [placements]);

  const rowY = useMemo(() => {
    const h = new Array(Math.max(1, snapshots.length)).fill(ROW_H);
    for (const p of placements) {
      const top = p.mergeRow ?? Math.max(0, p.forkRow - 1);
      const need = CARD_H + CARD_GAP * 2;
      const rows = Math.max(1, p.forkRow - top);
      let have = 0;
      for (let i = top; i < p.forkRow; i++) have += h[i] ?? ROW_H;
      if (have < need) {
        const add = (need - have) / rows;
        for (let i = top; i < p.forkRow; i++) h[i] = (h[i] ?? ROW_H) + add;
      }
    }
    const ys = [PAD_TOP + headroom];
    for (let i = 0; i < h.length; i++) ys.push(ys[i] + h[i]);
    return ys;
  }, [placements, snapshots.length, headroom]);

  const yOf = (row: number) => rowY[Math.max(0, Math.min(row, rowY.length - 1))];
  const laneX = (i: number) => PAD_TOP + i * LANE_W;
  const crX = (col: number) => laneX(lanes.length - 1) + CR_OFFSET + col * CR_COL_W;

  const cols = Math.max(0, ...placements.map((p) => p.col + 1));
  const height = (rowY[snapshots.length] ?? PAD_TOP) + PAD_BOTTOM;
  const width = cols > 0 ? crX(cols - 1) + CARD_W + 40 : laneX(lanes.length) + 120;

  if (snapshots.length === 0) return null;

  const laneColor = (i: number, l: BranchLane) =>
    l.trunk ? "var(--cg-main)" : ENV_COLORS[(i - 1) % ENV_COLORS.length];

  return (
    <div className="vg-wrap">
      <Legend />
      <div className="vg" style={{ width, height }}>
        <svg width={width} height={height} className="vg-svg">
          <defs>
            <filter id="vg-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* The standing lines: the trunk, then each environment branch. They
              run the whole height because that is what standing means. */}
          {lanes.map((l, i) => (
            <line
              key={l.name}
              className="vg-lane"
              x1={laneX(i)}
              x2={laneX(i)}
              y1={PAD_TOP - 18}
              y2={height - PAD_BOTTOM + 18}
              style={{ stroke: laneColor(i, l) }}
            />
          ))}

          {/* Each change's own line, out of the trunk and (maybe) back in. */}
          {placements.map((p) => (
            <CrLine
              key={`l-${p.cr.id}`}
              p={p}
              x={crX(p.col)}
              trunkX={laneX(0)}
              yFork={yOf(p.forkRow)}
              yTop={p.mergeRow != null ? yOf(p.mergeRow) : cardTop(p, yOf) - CARD_GAP}
              cardTop={cardTop(p, yOf)}
            />
          ))}

          {/* Commits on the trunk. */}
          {snapshots.map((c, i) => (
            <CommitDot
              key={c.sha}
              c={c}
              x={laneX(0)}
              y={yOf(i)}
              color="var(--cg-main)"
              isHead={c.sha === head}
              onCopy={onOpenCommit}
            />
          ))}

          {/* Commits a standing branch has that the trunk does not, drawn on
              that branch's own line at their own time. */}
          {envLanes.map((l, li) =>
            (l.commits ?? []).map((c) => (
              <CommitDot
                key={`${l.name}-${c.sha}`}
                c={c}
                x={laneX(li + 1)}
                y={yForDate(c.date, snapshots, yOf)}
                color={laneColor(li + 1, l)}
                onCopy={onOpenCommit}
              />
            )),
          )}
        </svg>

        {/* A standing branch says its name at both ends of its own line, so a
            lane is identified wherever you happen to be looking. */}
        {lanes.map((l, i) => (
          <span key={`t-${l.name}`}>
            {/* The name at both ends, staggered so neighbours never collide on
                a narrow lane. How far behind the trunk a branch is belongs on
                hover: it is a number you look up, not one you scan. */}
            <Tooltip title={laneWords(l)}>
              <span
                className="vg-lane-name is-top"
                style={{
                  left: laneX(i),
                  top: i % 2 ? -20 : 0,
                  ["--c" as string]: laneColor(i, l),
                }}
              >
                {l.name}
              </span>
            </Tooltip>
            <Tooltip title={laneWords(l)}>
              <span
                className="vg-lane-name is-bottom"
                style={{
                  left: laneX(i),
                  top: height + (i % 2 ? 20 : 0),
                  ["--c" as string]: laneColor(i, l),
                }}
              >
                {l.name}
                {l.behind > 0 && <em className="vg-behind"> -{l.behind}</em>}
              </span>
            </Tooltip>
          </span>
        ))}

        {/* Tags sit on the commit they mark. */}
        {snapshots.map((c, i) =>
          (c.refs ?? [])
            .filter((rf) => /\d/.test(rf))
            .map((rf) => (
              <span
                key={`${c.sha}-${rf}`}
                className="vg-tag"
                style={{ left: laneX(Math.max(0, lanes.length - 1)) + 14, top: yOf(i) }}
              >
                <TagOutlined style={{ fontSize: 9 }} /> {rf}
              </span>
            )),
        )}

        {placements.map((p) => (
          <ChangeCard
            key={p.cr.id}
            cr={p.cr}
            style={{ left: crX(p.col) - 18, top: cardTop(p, yOf), width: CARD_W, height: CARD_H }}
            onOpen={() => onOpenChange(p.cr)}
          />
        ))}
      </div>
      {!trunkLane && <div className="vg-note">No branch information available for this repository.</div>}
    </div>
  );
}

/** What a standing branch is doing relative to the trunk, in words. */
function laneWords(l: BranchLane): string {
  if (l.trunk) return `${l.name} - the branch changes are published to`;
  const ahead = l.commits?.length ?? 0;
  if (!ahead && !l.behind) return `${l.name} - level with the trunk`;
  const bits: string[] = [];
  if (ahead) bits.push(`${ahead} commit${ahead === 1 ? "" : "s"} of its own`);
  if (l.behind) bits.push(`${l.behind} behind the trunk`);
  return `${l.name} - ${bits.join(", ")}`;
}

/** Where a change's card sits: centred on the stretch of its own line between
 *  the commit it forked from and the one it merged into. */
function cardTop(p: CrPlacement, yOf: (r: number) => number): number {
  const yFork = yOf(p.forkRow);
  if (p.mergeRow != null) return (yOf(p.mergeRow) + yFork) / 2 - CARD_H / 2;
  // Unmerged: it sits above its fork, on the piece of line that has no end yet.
  return yFork - CARD_GAP - CARD_H;
}

/** A branch commit's y: level with the trunk commit of its own moment, so time
 *  reads straight across the picture. */
function yForDate(iso: string, snapshots: TimelineEntry[], yOf: (r: number) => number): number {
  const t = new Date(iso).getTime();
  const i = snapshots.findIndex((s) => new Date(s.date).getTime() <= t);
  return yOf(i >= 0 ? i : snapshots.length - 1);
}

/**
 * One change's line: out of the trunk at its fork commit, up its own column
 * through its card, and back into the trunk at the commit that merged it.
 * Unmerged, the line simply stops; rejected, it stops at a cross.
 */
function CrLine({
  p,
  x,
  trunkX,
  yFork,
  yTop,
  cardTop,
}: {
  p: CrPlacement;
  x: number;
  trunkX: number;
  yFork: number;
  yTop: number;
  cardTop: number;
}) {
  const st = STATE[p.cr.state];
  // Two changes that left the same commit leave from the SAME dot - that is the
  // fact being drawn - but their runs out to their own columns must not lie on
  // top of each other, or the second one is invisible. So each column leaves
  // the dot exactly, then steps to a run of its own a few pixels clear.
  const runOut = yFork - p.col * RUN_STEP;
  const runIn = yTop + p.col * RUN_STEP;
  const stub = trunkX + 16;
  const b = Math.min(BEND, Math.max(6, Math.abs(yFork - runOut) || BEND));

  const out = `M ${trunkX} ${yFork}
     L ${stub} ${yFork}
     ${p.col > 0 ? `Q ${stub + b} ${yFork} ${stub + b} ${runOut}` : ""}
     L ${x - BEND} ${runOut}
     Q ${x} ${runOut} ${x} ${runOut - BEND}
     L ${x} ${cardTop + CARD_H}`;

  const back =
    p.mergeRow != null
      ? `M ${x} ${cardTop}
         L ${x} ${runIn + BEND}
         Q ${x} ${runIn} ${x - BEND} ${runIn}
         L ${stub + (p.col > 0 ? b : 0)} ${runIn}
         ${p.col > 0 ? `Q ${stub} ${runIn} ${stub} ${yTop}` : ""}
         L ${trunkX} ${yTop}`
      : `M ${x} ${cardTop} L ${x} ${cardTop - CARD_GAP * 1.6}`;

  return (
    <g className="vg-cr" style={{ ["--c" as string]: st.color }}>
      <path d={out} fill="none" strokeDasharray={st.dashed ? "6 5" : undefined} />
      <path d={back} fill="none" strokeDasharray={st.dashed ? "6 5" : undefined} />
      {/* The fork is ON the trunk commit, so the two are visibly one event. */}
      <circle cx={trunkX} cy={yFork} r={3.5} className="vg-fork" />
      {p.mergeRow != null && <circle cx={trunkX} cy={yTop} r={3.5} className="vg-fork" />}
      {p.cr.state === "rejected" && (
        <g className="vg-cross" transform={`translate(${x} ${cardTop - CARD_GAP * 1.6 - 7})`}>
          <line x1={-6} y1={-6} x2={6} y2={6} />
          <line x1={6} y1={-6} x2={-6} y2={6} />
        </g>
      )}
    </g>
  );
}

/** A commit. Hovering names it in full; clicking copies it. */
function CommitDot({
  c,
  x,
  y,
  color,
  isHead,
  onCopy,
}: {
  c: TimelineEntry | { sha: string; short: string; author: string; date: string; message: string; parents?: string[] };
  x: number;
  y: number;
  color: string;
  isHead?: boolean;
  onCopy: (sha: string) => void;
}) {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);
  const merge = (c.parents?.length ?? 0) > 1;
  return (
    <Tooltip
      title={
        <span>
          <span className="mono">{c.sha}</span>
          <br />
          {c.message}
          <br />
          <span style={{ opacity: 0.75 }}>
            {c.author} · {relTime(c.date)}
            {merge ? " · merge" : ""}
            {isHead ? " · head" : ""}
          </span>
          <br />
          <span style={{ opacity: 0.6 }}>{copied ? "copied" : "click to copy the commit id"}</span>
        </span>
      }
    >
      <g
        className="vg-dot-g"
        onClick={() => {
          void navigator.clipboard?.writeText(c.sha);
          setCopied(true);
          message.success("Commit id copied");
          setTimeout(() => setCopied(false), 1200);
          onCopy(c.sha);
        }}
      >
        <circle cx={x} cy={y} r={DOT_R + 7} className="vg-dot-hit" />
        {/* The head glows, so "where are we now" needs no counting. */}
        {isHead && <Star x={x} y={y} color={color} />}
        {!isHead && (
          <circle
            cx={x}
            cy={y}
            r={DOT_R}
            className={`vg-dot${merge ? " is-merge" : ""}${copied ? " is-copied" : ""}`}
            style={{ ["--c" as string]: color }}
          />
        )}
      </g>
    </Tooltip>
  );
}

/** The head of the trunk: a star, glowing, because it is the one commit that
 *  answers "what is live right now". */
function Star({ x, y, color }: { x: number; y: number; color: string }) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 9 : 4;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(x + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`);
  }
  return (
    <polygon
      points={pts.join(" ")}
      className="vg-star"
      style={{ ["--c" as string]: color }}
      filter="url(#vg-glow)"
    />
  );
}

function ChangeCard({
  cr,
  style,
  onOpen,
}: {
  cr: ChangeRequest;
  style: React.CSSProperties;
  onOpen: () => void;
}) {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);
  const st = STATE[cr.state];
  const sha = cr.mergeSha || cr.commitSha;
  const n = cr.items?.length ?? 0;
  const branch = cr.branch || (cr.state === "draft" ? "branch created on submit" : "");

  return (
    <div
      className={`vg-card${st.dashed ? " is-open" : ""}`}
      style={{ ...style, ["--c" as string]: st.color }}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="vg-card-top">
        <span className="vg-cat">{cr.category || "change"}</span>
        <span className="vg-crid">{cr.number ? `CR-${cr.number}` : "draft"}</span>
        <Tooltip title={st.label}>
          <span className="vg-state">{st.label.split(",")[0]}</span>
        </Tooltip>
      </div>
      <div className="vg-card-title" title={cr.title}>
        {cr.title === "Draft changes" ? "Unnamed draft" : cr.title}
      </div>
      <Tooltip title={branch}>
        <div className={`vg-branch${cr.branch ? "" : " is-muted"}`}>{branch}</div>
      </Tooltip>
      <div className="vg-card-foot">
        <UserAvatar name={cr.author} size={16} />
        <span className="vg-who" title={cr.author}>{cr.author}</span>
        <Tooltip title={new Date(cr.updatedAt ?? cr.createdAt).toLocaleString()}>
          <span className="vg-when">{relTime(cr.updatedAt ?? cr.createdAt)}</span>
        </Tooltip>
        <span className="vg-grow" />
        <Tooltip title={`${n} change${n === 1 ? "" : "s"} in this request`}>
          <span className="vg-n">{n}</span>
        </Tooltip>
        {sha && (
          <Tooltip title={<span className="mono">{sha}</span>}>
            <span
              className={`vg-sha${copied ? " is-copied" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                void navigator.clipboard?.writeText(sha);
                setCopied(true);
                message.success("Commit id copied");
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <CheckOutlined style={{ fontSize: 9 }} /> : sha.slice(0, 7)}
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** What the colours mean, said once, where the colours are. */
function Legend() {
  const items: [string, string][] = [
    ["var(--cg-main)", "trunk"],
    ["var(--cg-published)", "published"],
    ["var(--cg-open)", "in flight"],
    ["var(--cg-rejected)", "rejected"],
    ["var(--cg-env-1)", "environment branch"],
  ];
  return (
    <div className="vg-legend">
      {items.map(([c, l]) => (
        <span key={l} className="vg-legend-item">
          <i style={{ background: c }} />
          {l}
        </span>
      ))}
      <span className="vg-legend-item vg-legend-star">
        <i className="vg-legend-starmark" />
        head
      </span>
    </div>
  );
}
