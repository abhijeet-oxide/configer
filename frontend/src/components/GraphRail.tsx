// The branch picture down the left of the history, drawn the way every git
// client people already read draws it: one line for the branch being published
// to, a coloured line for each piece of work that has left it, a node on the
// row each thing happened at, and a curve where a line joins or leaves.
//
// Three rules govern the whole thing.
//
// It is CONTINUOUS. The rail is one unbroken picture from the first row to the
// last, so lanes are drawn across the full height of every row with no gaps
// between them - an earlier version left the spacing between cards undrawn and
// the trunk appeared to be cut into pieces.
//
// It is TOPOLOGICAL, not decorative: lanes come from the commits' real parent
// links, so a merge is drawn where a merge happened and a line ends where its
// work ended. Nothing is inferred from the order rows happen to be in.
//
// It is SMALL. A history is something you scan, so a row is one line tall and
// the rail is sized to match; everything else lives in the row beside it.

/** Geometry. Rows are one line tall, so the rail is short and dense. */
export const ROW_H = 34;
const LANE_W = 15;
const RAIL_PAD = 9;
const DOT_R = 4.5;

const laneX = (lane: number) => RAIL_PAD + lane * LANE_W;
export const railWidth = (lanes: number) => RAIL_PAD * 2 + Math.max(1, lanes) * LANE_W;

/** The lane palette, defined as theme-aware tokens in index.css so it holds up
 *  in both modes and lives in one place. Lane 0 is the published line and takes
 *  the brand's own colour; the branch lanes are deliberately other hues, so
 *  "which line is this" is answered by colour rather than by counting across. */
const LANE_COUNT = 5;
export const laneColor = (lane: number) =>
  lane === 0 ? "var(--gg-lane-0)" : `var(--gg-lane-${1 + ((lane - 1) % LANE_COUNT)})`;

export type NodeShape = "commit" | "merge" | "tip" | "open";

/** One row's lanes, as computed by the layout below. */
export interface RailRow {
  /** the lane this row's node sits in */
  lane: number;
  shape: NodeShape;
  /** the node's own colour, when it should differ from its lane's (an open
   *  change is coloured by its status) */
  color?: string;
  /** lanes drawn top-to-bottom across this row, the node's lane included */
  vertical: number[];
  /** lanes that stop at this row's node, curving into it from above */
  joins: number[];
  /** lanes that begin at this row's node, curving away below it */
  forks: number[];
  /** the node's own lane starts here: nothing is drawn above it */
  opensLane?: boolean;
  /** the node's own lane ends here: nothing is drawn below it */
  closesLane?: boolean;
}

/**
 * One row's slice of the rail: a fixed-height SVG, so curves keep their shape
 * and the whole column tiles seamlessly however many rows there are.
 */
export default function GraphRail({
  row,
  lanes,
  first,
  last,
  height = ROW_H,
}: {
  row: RailRow;
  lanes: number;
  first: boolean;
  last: boolean;
  /** taller than a row when the row beneath it is expanded */
  height?: number;
}) {
  const w = railWidth(lanes);
  const mid = ROW_H / 2;
  const x = laneX(row.lane);
  const nodeColor = row.color ?? laneColor(row.lane);

  // A lane that merely passes through runs the full height. The node's own lane
  // is cut back at the ends of the history so the rail does not trail off into
  // nothing above the newest row or below the oldest.
  const verticals = row.vertical.map((lane) => {
    const isNode = lane === row.lane;
    const top = isNode && (first || row.opensLane) ? mid : 0;
    const bottom = isNode && (last || row.closesLane) ? mid : height;
    return (
      <line
        key={`v${lane}`}
        x1={laneX(lane)}
        x2={laneX(lane)}
        y1={top}
        y2={bottom}
        stroke={laneColor(lane)}
        strokeWidth={2}
        strokeLinecap="round"
      />
    );
  });

  // A join arrives from above and lands on the node; a fork leaves the node and
  // heads down. Both are the same S-curve, mirrored.
  const curve = (lane: number, dir: "join" | "fork") => {
    const lx = laneX(lane);
    const y0 = dir === "join" ? 0 : height;
    const c = dir === "join" ? mid * 0.6 : mid + (height - mid) * 0.4;
    return (
      <path
        key={`${dir}${lane}`}
        d={`M ${lx} ${y0} C ${lx} ${c} ${x} ${dir === "join" ? mid - mid * 0.4 : mid + mid * 0.4} ${x} ${mid}`}
        fill="none"
        stroke={laneColor(lane)}
        strokeWidth={2}
        strokeLinecap="round"
      />
    );
  };

  return (
    <svg
      width={w}
      height={height}
      viewBox={`0 0 ${w} ${height}`}
      style={{ flexShrink: 0, display: "block" }}
      aria-hidden
    >
      {verticals}
      {row.joins.map((lane) => curve(lane, "join"))}
      {row.forks.map((lane) => curve(lane, "fork"))}
      {/* A merge is drawn hollow and a plain commit filled, as git clients do;
          an open change gets a ring so it reads as "not landed". */}
      {row.shape === "open" && (
        <circle cx={x} cy={mid} r={DOT_R + 3} fill="none" stroke={nodeColor} strokeWidth={1} opacity={0.35} />
      )}
      <circle
        cx={x}
        cy={mid}
        r={DOT_R}
        fill={row.shape === "merge" || row.shape === "open" ? "var(--surface)" : nodeColor}
        stroke={nodeColor}
        strokeWidth={2}
      />
    </svg>
  );
}

// --- layout ----------------------------------------------------------------

/** What the layout needs to know about one row, in display order (newest
 *  first). `parents` are SHAs; an open change names the commit it branched
 *  from so it can be drawn leaving the trunk there. */
export interface GraphInput {
  sha: string;
  parents: string[];
  /** an open change: it has left the trunk and not landed */
  open?: boolean;
  /** the node's colour when it should not take its lane's */
  color?: string;
}

/**
 * layoutGraph assigns every row a lane and works out which lanes run through
 * it, join it and fork from it.
 *
 * The algorithm is the standard one: walk rows newest-first holding a set of
 * "open ends" - SHAs some already-drawn row is still waiting to see. A row
 * takes the leftmost lane waiting for it (or a fresh one if nothing is), its
 * first parent inherits that lane, and each further parent opens a lane of its
 * own that will be drawn joining back when its commit comes round.
 */
export function layoutGraph(rows: GraphInput[]): { rows: RailRow[]; lanes: number } {
  // lane index -> the SHA that lane is currently waiting to reach. An open
  // change needs no special case here: it is a node whose parent is the commit
  // it branched from, so it holds a lane down to that commit and joins there,
  // which is exactly what it does in the repository.
  const waiting: (string | null)[] = [];
  const out: RailRow[] = [];
  let maxLanes = 1;

  const claim = (sha: string): number => {
    const existing = waiting.indexOf(sha);
    if (existing >= 0) return existing;
    const free = waiting.indexOf(null);
    if (free >= 0) {
      waiting[free] = sha;
      return free;
    }
    waiting.push(sha);
    return waiting.length - 1;
  };

  // Lane 0 belongs to the trunk. Reserving it before the walk keeps the
  // published line on the left however many open changes sit above its tip -
  // otherwise the first row drawn would take it and the trunk would wander.
  const trunk = rows.find((r) => !r.open);
  if (trunk) waiting.push(trunk.sha);

  for (const row of rows) {
    // Every lane waiting for THIS commit lands here; the leftmost becomes the
    // node's lane and the rest are drawn joining into it.
    const mine: number[] = [];
    waiting.forEach((sha, i) => {
      if (sha === row.sha) mine.push(i);
    });
    const opensLane = mine.length === 0;
    const lane = opensLane ? claim(row.sha) : mine[0];
    const joins = mine.slice(1);
    for (const j of joins) waiting[j] = null;

    // The first parent carries this lane onward; any others fork into lanes of
    // their own, to be drawn joining back when their commit comes round.
    waiting[lane] = row.parents[0] ?? null;
    const forks: number[] = [];
    for (const p of row.parents.slice(1)) {
      const l = claim(p);
      if (l !== lane) forks.push(l);
    }

    // Lanes still open on other work pass straight through this row.
    const vertical: number[] = [];
    waiting.forEach((sha, i) => {
      if (sha !== null && i !== lane) vertical.push(i);
    });
    const closesLane = waiting[lane] === null;
    vertical.push(lane); // the node's own lane, cut back by opens/closes

    out.push({
      lane,
      shape: row.open ? "open" : row.parents.length > 1 ? "merge" : "commit",
      color: row.color,
      vertical: vertical.sort((a, b) => a - b),
      joins,
      forks,
      opensLane,
      closesLane,
    });
    for (const l of [lane, ...joins, ...forks, ...vertical]) maxLanes = Math.max(maxLanes, l + 1);
  }
  return { rows: out, lanes: Math.max(1, maxLanes) };
}
