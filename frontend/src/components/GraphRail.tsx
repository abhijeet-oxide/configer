import { theme as antdTheme } from "antd";

// GraphRail draws the branch picture down the left of the timeline, the way
// every git client that people already read draws it: one line for the branch
// being published to, a coloured line for each change that has left it, a dot
// on the row each thing happened at, and a curve where a branch rejoins.
//
// It exists because the timeline used to be a column of dots on one straight
// line. That shape can only say "these things happened in this order" - it
// cannot show that two changes are in flight right now, that they both started
// from the same commit, or that the one at the top has not landed anywhere
// yet. Those are the questions somebody opens a history to ask.
//
// The rail is deliberately not a general git-graph engine. It draws exactly the
// topology Configer creates: a trunk, changes branching off its tip, and merges
// back into it. Anything more would be drawing possibilities the product cannot
// produce.

/** Horizontal distance between lanes, and the trunk's own offset. */
const LANE_W = 16;
const RAIL_PAD = 10;
/** Where the dot sits from the top of a row - level with the card's title. */
export const DOT_Y = 18;
const DOT_R = 5;

export type RailNodeKind = "trunk" | "merge" | "branch";

export interface RailRow {
  /** which lane this row's node sits in; 0 is the trunk */
  lane: number;
  kind: RailNodeKind;
  /** the node's colour; the lane it owns is drawn in it too */
  color: string;
  /** lanes that pass THROUGH this row without a node on it */
  through: number[];
  /** this row is where `lane` curves back into the trunk */
  mergesHere?: number[];
  /** nothing is drawn above the node in its own lane (the branch starts here) */
  opensLane?: boolean;
  /** nothing is drawn below the node in its own lane (the history ends here) */
  closesLane?: boolean;
}

function railWidth(lanes: number): number {
  return RAIL_PAD * 2 + Math.max(1, lanes) * LANE_W;
}

const laneX = (lane: number) => RAIL_PAD + lane * LANE_W + LANE_W / 2;

/**
 * One row's slice of the rail. It is absolutely positioned over the row and
 * stretches to whatever height the row turns out to be, so a card that expands
 * takes its piece of the lines with it.
 */
export default function GraphRail({
  row,
  lanes,
  trunkColor,
  first,
  last,
}: {
  row: RailRow;
  lanes: number;
  trunkColor: string;
  first: boolean;
  last: boolean;
}) {
  const { token } = antdTheme.useToken();
  const w = railWidth(lanes);
  const colorOf = (lane: number) => (lane === row.lane ? row.color : lane === 0 ? trunkColor : row.color);

  // Vertical lane segments. Each is a plain element rather than SVG so it
  // stretches with the row without the stroke width distorting.
  const segments: React.ReactNode[] = [];
  const addSegment = (lane: number, from: number | "top", to: number | "bottom", color: string) => {
    segments.push(
      <span
        key={`${lane}-${from}-${to}`}
        style={{
          position: "absolute",
          left: laneX(lane) - 1,
          top: from === "top" ? 0 : from,
          bottom: to === "bottom" ? 0 : undefined,
          height: to === "bottom" ? undefined : (to as number) - (from === "top" ? 0 : from),
          width: 2,
          background: color,
          opacity: lane === 0 ? 0.9 : 0.75,
          borderRadius: 1,
        }}
      />,
    );
  };

  for (const lane of row.through) {
    addSegment(lane, "top", "bottom", colorOf(lane));
  }
  // The node's own lane: above the dot unless the branch begins here, below it
  // unless this is where it ends.
  if (!row.opensLane && !first) addSegment(row.lane, "top", DOT_Y - DOT_R, colorOf(row.lane));
  if (!row.closesLane && !last) addSegment(row.lane, DOT_Y + DOT_R, "bottom", colorOf(row.lane));

  // The curve where a branch rejoins the trunk. It is drawn on the row it
  // merges INTO, arriving from above.
  const merges = row.mergesHere ?? [];

  return (
    <div style={{ position: "relative", width: w, flexShrink: 0, alignSelf: "stretch" }} aria-hidden>
      {segments}
      {merges.length > 0 && (
        <svg
          width={w}
          height={DOT_Y}
          style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
        >
          {merges.map((lane) => (
            <path
              key={lane}
              d={`M ${laneX(lane)} 0 L ${laneX(lane)} ${DOT_Y - 12} Q ${laneX(lane)} ${DOT_Y} ${laneX(lane) - LANE_W / 2} ${DOT_Y} L ${laneX(0) + DOT_R} ${DOT_Y}`}
              fill="none"
              stroke={row.color}
              strokeWidth={2}
              opacity={0.75}
            />
          ))}
        </svg>
      )}
      <span
        style={{
          position: "absolute",
          left: laneX(row.lane) - DOT_R - 2,
          top: DOT_Y - DOT_R - 2,
          width: (DOT_R + 2) * 2,
          height: (DOT_R + 2) * 2,
          borderRadius: "50%",
          // A merge is drawn hollow and a plain commit filled, the same way
          // git clients distinguish them.
          background: row.kind === "trunk" ? row.color : token.colorBgContainer,
          border: `2px solid ${row.color}`,
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}
