import { useMemo, useState } from "react";
import { Tooltip, App as AntApp } from "antd";
import {
  BranchesOutlined,
  BugOutlined,
  ClockOutlined,
  EditOutlined,
  FileTextOutlined,
  ShieldOutlined,
  ThunderboltOutlined,
  WrenchOutlined,
} from "../icons";
import { relTime } from "./DashboardView";
import UserAvatar from "./UserAvatar";
import type { BranchLane, ChangeRequest, ChangeState, Commit, TimelineEntry } from "../api";

// The Change Flow: what has happened to this application, told as a journey
// rather than as git internals.
//
// The whole design rests on one inversion. A git graph draws branches and hangs
// labels off them; this draws CHANGES, and the branches are only the lanes they
// travel between. So a change is a card, the card sits ON the path it took, and
// the path bends out of the commit it started from and back into the commit
// that accepted it. Nothing here asks the reader to know what a ref is.
//
// The rules, and each one means exactly one thing:
//
//   time      runs left to right, with the axis underneath saying when.
//   a lane    is a branch that stays: main, lab, prod. One colour each, named
//             in a pill at the left where the eye starts.
//   colour    is ONLY branch identity and status. Red is only ever rejected.
//   a card    is one change, white and quiet, carrying a monochrome mark for
//             its type - a type is a word and a glyph, never a colour.
//   a node    says what kind of moment it was by its SHAPE: a filled dot is a
//             commit, a ring is a merge, a crossed circle is a rejection, a
//             star is where the branch is now.
//
// Hovering a card lifts that one change's whole path out of the picture and
// dims the rest, which is how you follow a single story through a busy week.

// --- geometry ---------------------------------------------------------------

const LABEL_W = 132;
const PLOT_PAD_L = 26;
const PLOT_PAD_R = 130;
const PAD_TOP = 22;
const AXIS_H = 52;
/** Vertical distance between lanes. A card plus air has to fit in the gap,
 *  because that is where cards live. */
/** The least room a band gets even with no cards in it. */
const MIN_BAND = 74;
const CARD_W = 178;
const CARD_H = 118;
const CARD_GAP_X = 54;
const CARD_GAP_Y = 20;
/** Minimum and maximum horizontal distance between two consecutive moments.
 *  Real elapsed time decides where in between, so a quiet night does not push
 *  the picture a mile wide and a busy minute is still readable. */
const STEP_MIN = 132;
const STEP_MAX = 260;
const MS_PER_PX = 90_000; // 1.5 minutes of real time per pixel, before clamping
/** Horizontal room a change's curve needs to leave its commit flat and arrive
 *  at its card flat. LEAD is what any change gets; CROSS_LEAD is added for each
 *  lane it crosses on top. Without them a change fell almost vertically out of
 *  its branch, which is the one thing this picture is not allowed to look like. */
const LEAD = 110;
const CROSS_LEAD = 80;

/** Change types, said in a mark and a word. No colour: colour is for branch and
 *  status only, so a reader never has to wonder whether orange means urgent. */
const TYPE_MARK: Record<string, { icon: React.ReactNode; label: string }> = {
  hotfix: { icon: <ThunderboltOutlined />, label: "Hotfix" },
  feature: { icon: <BranchesOutlined />, label: "Feature" },
  bugfix: { icon: <BugOutlined />, label: "Bugfix" },
  security: { icon: <ShieldOutlined />, label: "Security" },
  maintenance: { icon: <WrenchOutlined />, label: "Maintenance" },
  other: { icon: <EditOutlined />, label: "Change request" },
  change: { icon: <EditOutlined />, label: "Change request" },
};
const typeMark = (category?: string) => TYPE_MARK[(category ?? "").toLowerCase()] ?? TYPE_MARK.change;

/** Status, which is the only thing besides a branch that gets a colour - and
 *  red is spent entirely on "this did not happen". */
type FlowStatus = "open" | "merged" | "rejected";
const statusOf = (s: ChangeState): FlowStatus =>
  s === "published" ? "merged" : s === "rejected" ? "rejected" : "open";

const STATUS_WORDS: Record<ChangeState, string> = {
  draft: "Draft - not sent for review",
  under_review: "Out for review",
  approved: "Approved - not published yet",
  published: "Published",
  rejected: "Rejected in review",
};

interface Moment {
  t: number;
  x: number;
}

interface FlowNode {
  sha: string;
  short: string;
  message: string;
  author: string;
  date: string;
  lane: number;
  x: number;
  kind: "commit" | "merge" | "head";
}

interface Flow {
  cr: ChangeRequest;
  status: FlowStatus;
  fromLane: number;
  toLane: number;
  x0: number;
  x1: number;
  cardX: number;
  cardY: number;
}

export default function ChangeGraph({
  snapshots,
  lanes,
  head,
  changes,
  onOpenChange,
}: {
  snapshots: TimelineEntry[];
  lanes: BranchLane[];
  head: string;
  changes: ChangeRequest[];
  onOpenChange: (cr: ChangeRequest) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);

  // One lane per standing branch, in the order the service listed them (the
  // trunk first). Lane colour is identity, and identity only.
  const laneColor = (i: number) => (i === 0 ? "var(--cf-main)" : `var(--cf-lane-${((i - 1) % 4) + 1})`);
  const laneOf = useMemo(() => {
    const m = new Map<string, number>();
    snapshots.forEach((c) => m.set(c.sha, 0));
    lanes.forEach((l, i) => {
      if (l.trunk) return;
      (l.commits ?? []).forEach((c) => m.set(c.sha, i));
    });
    return m;
  }, [snapshots, lanes]);

  // A squashed time scale. Every COMMIT gets its own stop - not every distinct
  // instant - because two commits landed in the same second are still two
  // commits, and a pipeline that publishes three changes inside a minute must
  // not draw them all on top of each other. Stops are then spaced by how much
  // real time passed, clamped, so neither a burst nor a quiet weekend decides
  // how wide the picture is. Time still reads left to right and the axis says
  // exactly when.
  const scale = useMemo(() => {
    // Oldest first, which is also the order equal-timestamp commits must take:
    // the service lists them newest first, so reversing a run of them puts the
    // parent before the child and no line ever points backwards.
    const seen = new Map<string, { t: number; lane: number }>();
    const collect = (c: Commit | TimelineEntry, lane: number) => {
      const t = new Date(c.date).getTime();
      if (!seen.has(c.sha) && Number.isFinite(t)) seen.set(c.sha, { t, lane });
    };
    [...snapshots].reverse().forEach((c) => collect(c, 0));
    lanes.forEach((l, i) => {
      if (!l.trunk) [...(l.commits ?? [])].reverse().forEach((c) => collect(c, i));
    });
    const order = [...seen.keys()];
    const stops = order
      .map((sha, i) => ({ sha, seq: i, ...seen.get(sha)! }))
      .sort((a, b) => a.t - b.t || a.seq - b.seq);

    const widths = stops.map((s, i) =>
      i === 0 ? 0 : Math.min(STEP_MAX, Math.max(STEP_MIN, (s.t - stops[i - 1].t) / MS_PER_PX)),
    );

    // A change needs more room than its timing alone asks for - its card has to
    // fit between the commit it left and the one it landed on, with enough run
    // either side for the curve to get there gracefully. So widen the gaps IT
    // spans: the commits either end really do move apart, which keeps every x
    // honest and leaves the rest of the picture as tight as its own timing.
    const at = new Map(stops.map((s, i) => [s.sha, i]));
    const laneByName = new Map(lanes.map((l, i) => [l.name, i]));
    for (const cr of changes) {
      const from = seen.get(cr.baseSha ?? "")?.lane ?? laneByName.get(cr.targetBranch) ?? 0;
      const to = laneByName.get(cr.targetBranch) ?? from;
      const lead = LEAD + Math.abs(to - from) * CROSS_LEAD;
      const i0 = at.get(cr.baseSha ?? "");
      if (i0 === undefined) continue;
      // One that landed has to fit the whole arc; one still out or rejected has
      // only to get its card clear of the commit it left.
      const merged = at.get(cr.mergeSha ?? "");
      const i1 = merged ?? i0 + 1;
      const need = merged !== undefined ? CARD_W + lead * 2 : CARD_W / 2 + lead;
      if (i1 >= widths.length || i1 <= i0) continue;
      let have = 0;
      for (let i = i0 + 1; i <= i1; i++) have += widths[i];
      if (have >= need) continue;
      const share = (need - have) / (i1 - i0);
      for (let i = i0 + 1; i <= i1; i++) widths[i] += share;
    }

    const moments: Moment[] = [];
    const xOf = new Map<string, number>();
    let x = LABEL_W + PLOT_PAD_L;
    stops.forEach((s, i) => {
      x += widths[i];
      xOf.set(s.sha, x);
      moments.push({ t: s.t, x });
    });
    // Work still out has no commit to sit on, so the axis runs on to the most
    // recent thing that happened at all - otherwise an open change would be
    // pinned to the last publish and look finished.
    const latest = changes.reduce((m, c) => Math.max(m, new Date(c.updatedAt).getTime() || 0), 0);
    const last = moments[moments.length - 1];
    if (last && latest > last.t) {
      moments.push({
        t: latest,
        x: last.x + Math.min(STEP_MAX, Math.max(STEP_MIN, (latest - last.t) / MS_PER_PX)),
      });
    }
    return { moments, xOf };
  }, [snapshots, lanes, changes]);

  const moments = scale.moments;

  /** x for a moment in time, interpolated between the two it falls between.
   *  Only for things with no commit of their own - a commit is looked up by
   *  sha, because several of them can share one instant. */
  const xAt = (iso?: string): number => {
    if (!moments.length) return LABEL_W + PLOT_PAD_L;
    const t = iso ? new Date(iso).getTime() : NaN;
    if (!Number.isFinite(t)) return moments[moments.length - 1].x;
    if (t <= moments[0].t) return moments[0].x;
    for (let i = 1; i < moments.length; i++) {
      if (t <= moments[i].t) {
        const a = moments[i - 1];
        const b = moments[i];
        const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
        return a.x + f * (b.x - a.x);
      }
    }
    return moments[moments.length - 1].x;
  };

  // Every commit, on its own lane at its own moment. The head is a node of its
  // own kind because "where are we now" is the one thing everybody looks for.
  const nodes = useMemo<FlowNode[]>(() => {
    const out: FlowNode[] = [];
    const push = (c: Commit | TimelineEntry, lane: number) => {
      out.push({
        sha: c.sha,
        short: c.short,
        message: c.message,
        author: c.author,
        date: c.date,
        lane,
        x: scale.xOf.get(c.sha) ?? xAt(c.date),
        kind: c.sha === head ? "head" : (c.parents?.length ?? 0) > 1 ? "merge" : "commit",
      });
    };
    snapshots.forEach((c) => push(c, 0));
    lanes.forEach((l, i) => {
      if (l.trunk) return;
      (l.commits ?? []).forEach((c) => push(c, i));
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshots, lanes, head, scale]);

  // Each change as a path with a card in the middle of it. The lane it left and
  // the lane it was going to may differ - a change promoted from lab to main is
  // an ordinary thing, and the picture should show it as one line, not two.
  //
  // Cards live in the BAND between two lanes (or just outside the first and
  // last), and a band grows to hold however many rows of cards it needs. The
  // lanes are then spaced by their bands, so the drawing is exactly as tall as
  // its content and the curves stay shallow.
  const layout = useMemo(() => {
    const laneByName = new Map<string, number>(lanes.map((l, idx) => [l.name, idx]));
    const nodeX = new Map(nodes.map((n) => [n.sha, n.x]));
    const headX = nodes.find((n) => n.kind === "head")?.x;
    const ordered = [...changes]
      .filter((c) => c.state !== "draft" || (c.items?.length ?? 0) > 0)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Bands are the horizontal strips cards live in. Band b is the space ABOVE
    // lane b; the last band is below the last lane. A same-lane change fans
    // above and below its own lane before it stacks, which keeps the curves
    // shallow and reads the way somebody would lay it out by hand.
    const bandCount = lanes.length + 1;
    const rows: [number, number][][][] = Array.from({ length: bandCount }, () => []);
    const placed: {
      cr: ChangeRequest;
      status: FlowStatus;
      fromLane: number;
      toLane: number;
      x0: number;
      x1: number;
      cardX: number;
      band: number;
      row: number;
    }[] = [];

    for (const cr of ordered) {
      const status = statusOf(cr.state);
      const fromLane = laneOf.get(cr.baseSha ?? "") ?? laneByName.get(cr.targetBranch) ?? 0;
      const toLane = laneByName.get(cr.targetBranch) ?? fromLane;
      // A draft has no base commit yet, and it is not floating in space: it is
      // work sitting on top of where the branch is right now, so it leaves the
      // head like anything else would.
      const x0 =
        nodeX.get(cr.baseSha ?? "") ?? (cr.baseSha ? xAt(cr.createdAt) : (headX ?? xAt(cr.createdAt)));
      // A change ends where it landed, not "now": the merge commit is the whole
      // point of the arc, and stretching every finished change to the right
      // edge made the picture read as though nothing had ever concluded.
      const landed = status === "merged" ? nodeX.get(cr.mergeSha ?? "") : undefined;
      const x1 = Math.max(x0 + CARD_W + CARD_GAP_X * 2, landed ?? xAt(cr.updatedAt));
      const cardX = (x0 + x1) / 2 - CARD_W / 2;

      // Where it could go, best first. A change that crosses lanes belongs in
      // the band between them; one that stays put fans out from its own lane.
      const prefer: number[] =
        toLane !== fromLane ? [Math.max(fromLane, toLane)] : [fromLane, fromLane + 1];

      const free = (b: number, r: number) =>
        !(rows[b]?.[r] ?? []).some(
          ([a, z]) => cardX < z + CARD_GAP_X && a < cardX + CARD_W + CARD_GAP_X,
        );

      let band = prefer[0];
      let row = 0;
      outer: for (let r = 0; r < 24; r++) {
        for (const b of prefer) {
          if (b < 0 || b >= bandCount) continue;
          if (free(b, r)) {
            band = b;
            row = r;
            break outer;
          }
        }
      }
      ((rows[band] ??= [])[row] ??= []).push([cardX, cardX + CARD_W]);
      placed.push({ cr, status, fromLane, toLane, x0, x1, cardX, band, row });
    }

    const bandHeight = (b: number) => {
      const n = rows[b]?.length ?? 0;
      return Math.max(MIN_BAND, n * CARD_H + (n + 1) * CARD_GAP_Y);
    };
    // Lane i sits under bands 0..i; band b starts where band b-1 ended.
    const bandStart: number[] = [PAD_TOP];
    for (let b = 0; b < bandCount; b++) bandStart.push(bandStart[b] + bandHeight(b));
    const laneYs = lanes.map((_, i) => bandStart[i + 1]);
    const bottom = bandStart[bandCount];

    const flows: Flow[] = placed.map((d) => ({
      cr: d.cr,
      status: d.status,
      fromLane: d.fromLane,
      toLane: d.toLane,
      x0: d.x0,
      x1: d.x1,
      cardX: d.cardX,
      cardY: bandStart[d.band] + CARD_GAP_Y + d.row * (CARD_H + CARD_GAP_Y),
    }));
    return { flows, laneYs, bottom };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changes, lanes, laneOf, nodes, scale]);

  const flows = layout.flows;
  const laneY = (i: number) => layout.laneYs[Math.max(0, Math.min(i, layout.laneYs.length - 1))] ?? PAD_TOP;

  const lastX = Math.max(
    LABEL_W + PLOT_PAD_L + STEP_MIN,
    ...nodes.map((n) => n.x),
    ...flows.map((f) => Math.max(f.x1, f.cardX + CARD_W)),
  );
  const width = lastX + PLOT_PAD_R;
  const height = layout.bottom + AXIS_H;

  if (!lanes.length || !snapshots.length) return null;

  const dim = (id: number) => hover != null && hover !== id;

  return (
    <div className="cf">
      <Legend lanes={lanes} laneColor={laneColor} />
      <div className="cf-scroll">
        <div className="cf-plot" style={{ width, height }}>
          <svg width={width} height={height} className="cf-svg">
            {/* Lanes. Thick, calm, and behind everything: they are the roads,
                not the traffic. */}
            {lanes.map((l, i) => (
              <g key={l.name} className="cf-lane" style={{ ["--c" as string]: laneColor(i) }}>
                <line
                  x1={LABEL_W}
                  x2={width - PLOT_PAD_R + 60}
                  y1={laneY(i)}
                  y2={laneY(i)}
                />
                <path
                  className="cf-lane-cap"
                  d={`M ${width - PLOT_PAD_R + 60} ${laneY(i)} l -9 -5 v 10 z`}
                />
              </g>
            ))}

            {/* Every change's path: out of its starting commit, through its
                card, and into whatever accepted it. */}
            {flows.map((f) => (
              <FlowPath
                key={f.cr.id}
                f={f}
                y0={laneY(f.fromLane)}
                y1={laneY(f.toLane)}
                dimmed={dim(f.cr.id)}
                lifted={hover === f.cr.id}
                fromColor={laneColor(f.fromLane)}
                toColor={laneColor(f.toLane)}
              />
            ))}

            {nodes.map((n) => (
              <FlowNodeMark
                key={`${n.lane}-${n.sha}`}
                n={n}
                y={laneY(n.lane)}
                color={laneColor(n.lane)}
                dimmed={hover != null}
              />
            ))}

            {/* The axis. It is what makes this a timeline rather than a diagram. */}
            <Axis scale={moments} y={height - AXIS_H + 18} width={width} />
          </svg>

          {/* Lane names, at the left where reading starts. */}
          {lanes.map((l, i) => (
            <Tooltip key={`n-${l.name}`} title={laneWords(l)}>
              <span
                className={`cf-lane-name${l.trunk ? " is-trunk" : ""}`}
                style={{ top: laneY(i), ["--c" as string]: laneColor(i) }}
              >
                <BranchesOutlined style={{ fontSize: 11 }} />
                {l.name}
              </span>
            </Tooltip>
          ))}

          {/* HEAD, level with the trunk, at the end of the road. */}
          <span className="cf-head" style={{ top: laneY(0), left: headX(nodes) + 26 }}>
            HEAD
          </span>

          {flows.map((f) => (
            <FlowCard
              key={f.cr.id}
              f={f}
              y={f.cardY}
              dimmed={dim(f.cr.id)}
              onEnter={() => setHover(f.cr.id)}
              onLeave={() => setHover(null)}
              onOpen={() => onOpenChange(f.cr)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Where the HEAD marker goes: past the newest commit on the trunk. */
function headX(nodes: FlowNode[]): number {
  const trunk = nodes.filter((n) => n.lane === 0);
  return trunk.length ? Math.max(...trunk.map((n) => n.x)) : LABEL_W;
}

/** What a standing branch is doing, in words rather than in numbers. */
function laneWords(l: BranchLane): string {
  if (l.trunk) return `${l.name} - changes are published here`;
  const ahead = l.commits?.length ?? 0;
  if (!ahead && !l.behind) return `${l.name} - level with ${"the main line"}`;
  const bits: string[] = [];
  if (ahead) bits.push(`${ahead} change${ahead === 1 ? "" : "s"} of its own`);
  if (l.behind) bits.push(`${l.behind} behind`);
  return `${l.name} - ${bits.join(", ")}`;
}

/**
 * One change's path. Two Bézier curves and the card between them: out of the
 * commit it started from, docking flat into the card's left edge, then out of
 * the right edge and into whatever accepted it. Docking perpendicular is what
 * makes the card read as part of the road instead of a note pinned beside it.
 */
function FlowPath({
  f,
  y0,
  y1,
  dimmed,
  lifted,
  fromColor,
  toColor,
}: {
  f: Flow;
  y0: number;
  y1: number;
  dimmed: boolean;
  lifted: boolean;
  fromColor: string;
  toColor: string;
}) {
  const cardMidY = f.cardY + CARD_H / 2;
  const inX = f.cardX;
  const outX = f.cardX + CARD_W;
  // Both ends are flat, which is what gives the curve its single smooth S with
  // no visible corner. The control points sit halfway along in x normally, and
  // stretch out towards the far end when the drop is steep - at the limit they
  // reach the opposite endpoint, which is as smooth as a cubic gets before it
  // starts doubling back on itself.
  const ease = (ax: number, ay: number, bx: number, by: number) => {
    const run = bx - ax;
    const c = Math.min(run, Math.max(run / 2, Math.abs(by - ay) * 0.6));
    return `M ${ax} ${ay} C ${ax + c} ${ay} ${bx - c} ${by} ${bx} ${by}`;
  };
  const enter = ease(f.x0, y0, inX, cardMidY);
  // Only a change that LANDED gets a curve back to a lane. One still out, or
  // one that was rejected, ends where it ended - drawing it rejoining anyway
  // was the picture telling a story that had not happened.
  const leave =
    f.status === "merged"
      ? ease(outX, cardMidY, f.x1, y1)
      : `M ${outX} ${cardMidY} L ${outX + (f.status === "rejected" ? 40 : 20)} ${cardMidY}`;

  const cls = `cf-flow is-${f.status}${dimmed ? " is-dim" : ""}${lifted ? " is-lifted" : ""}`;
  return (
    <g className={cls}>
      <path d={enter} fill="none" style={{ stroke: f.status === "rejected" ? "var(--cf-reject)" : fromColor }} />
      <path d={leave} fill="none" style={{ stroke: f.status === "rejected" ? "var(--cf-reject)" : toColor }} />
      {/* Where it ended. A rejection is its own node shape, and the only red
          thing on screen. An open change simply has no end yet. */}
      {f.status === "rejected" && <RejectedNode x={outX + 50} y={cardMidY} />}
      {f.status === "open" && (
        <circle cx={outX + 26} cy={cardMidY} r={4.5} className="cf-open-end" style={{ stroke: toColor }} />
      )}
    </g>
  );
}

/** A commit, a merge, or the head - told apart by shape, never by colour. */
function FlowNodeMark({
  n,
  y,
  color,
  dimmed,
}: {
  n: FlowNode;
  y: number;
  color: string;
  dimmed: boolean;
}) {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(n.sha);
    setCopied(true);
    message.success("Commit id copied");
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <Tooltip
      title={
        <span>
          <span className="mono">{n.short}</span> · {new Date(n.date).toLocaleString()}
          <br />
          {n.message}
          <br />
          <span style={{ opacity: 0.7 }}>{copied ? "copied" : "click to copy the commit id"}</span>
        </span>
      }
    >
      <g
        className={`cf-node is-${n.kind}${dimmed ? " is-dim" : ""}`}
        style={{ ["--c" as string]: color }}
        onClick={copy}
        role="button"
        tabIndex={-1}
      >
        <circle cx={n.x} cy={y} r={13} className="cf-node-hit" />
        {n.kind === "head" ? (
          <Star x={n.x} y={y} />
        ) : n.kind === "merge" ? (
          <>
            <circle cx={n.x} cy={y} r={7} className="cf-ring" />
            <circle cx={n.x} cy={y} r={3} className="cf-ring-core" />
          </>
        ) : (
          <circle cx={n.x} cy={y} r={4.5} className="cf-commit" />
        )}
      </g>
    </Tooltip>
  );
}

/** A rejection: a crossed circle, and the only red on screen. */
function RejectedNode({ x, y }: { x: number; y: number }) {
  return (
    <g className="cf-reject-node">
      <circle cx={x} cy={y} r={8} />
      <line x1={x - 3.5} y1={y - 3.5} x2={x + 3.5} y2={y + 3.5} />
      <line x1={x + 3.5} y1={y - 3.5} x2={x - 3.5} y2={y + 3.5} />
    </g>
  );
}

function Star({ x, y }: { x: number; y: number }) {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 9 : 4.1;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(x + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`);
  }
  return <polygon points={pts.join(" ")} className="cf-star" />;
}

/** The time axis. It is what makes this a timeline rather than a diagram, so
 *  it says WHEN at the precision the span actually needs: seconds for a busy
 *  afternoon, a date once the history runs over days. Labels thin out until
 *  they stop touching, and a repeated label is dropped rather than printed
 *  twice. */
function Axis({ scale, y, width }: { scale: Moment[]; y: number; width: number }) {
  if (!scale.length) return null;
  const span = scale[scale.length - 1].t - scale[0].t;
  const fmt: Intl.DateTimeFormatOptions =
    span < 30 * 60_000
      ? { hour: "numeric", minute: "2-digit", second: "2-digit" }
      : span < 36 * 3_600_000
        ? { hour: "numeric", minute: "2-digit" }
        : { month: "short", day: "numeric", hour: "numeric" };

  const shown: { x: number; label: string }[] = [];
  let lastX = -Infinity;
  let lastLabel = "";
  for (const m of scale) {
    if (m.x - lastX < 96) continue;
    const label = new Date(m.t).toLocaleString([], fmt);
    if (label === lastLabel) continue;
    shown.push({ x: m.x, label });
    lastX = m.x;
    lastLabel = label;
  }
  return (
    <g className="cf-axis">
      <line x1={LABEL_W} x2={width - 40} y1={y} y2={y} />
      {shown.map((t) => (
        <text key={t.x} x={t.x} y={y + 18} textAnchor="middle">
          {t.label}
        </text>
      ))}
    </g>
  );
}

/** One change. White, quiet, and part of the path it sits on. */
function FlowCard({
  f,
  y,
  dimmed,
  onEnter,
  onLeave,
  onOpen,
}: {
  f: Flow;
  y: number;
  dimmed: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onOpen: () => void;
}) {
  const { cr } = f;
  const mark = typeMark(cr.category);
  const files = cr.items?.length ?? 0;
  return (
    <div
      className={`cf-card is-${f.status}${dimmed ? " is-dim" : ""}`}
      style={{ left: f.cardX, top: y, width: CARD_W, height: CARD_H }}
      role="button"
      tabIndex={0}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="cf-card-head">
        <Tooltip title={STATUS_WORDS[cr.state]}>
          <span className="cf-type">
            {f.status === "rejected" ? <RejectMark /> : mark.icon}
            {mark.label}
          </span>
        </Tooltip>
        <span className="cf-crid">{cr.number ? `CR-${cr.number}` : "draft"}</span>
      </div>
      <div className="cf-card-title" title={cr.title}>
        {cr.title === "Draft changes" ? "Unnamed draft" : cr.title}
      </div>
      <div className="cf-card-by">
        <UserAvatar name={cr.author} size={16} />
        <span className="cf-who" title={cr.author}>{cr.author}</span>
        <span className="cf-sep">·</span>
        <Tooltip title={new Date(cr.updatedAt ?? cr.createdAt).toLocaleString()}>
          <span className="cf-when">
            <ClockOutlined style={{ fontSize: 9 }} /> {relTime(cr.updatedAt ?? cr.createdAt)}
          </span>
        </Tooltip>
      </div>
      <div className="cf-card-files">
        <FileTextOutlined style={{ fontSize: 11 }} />
        {files} change{files === 1 ? "" : "s"}
      </div>
    </div>
  );
}

/** The rejected mark on a card: the one place a type slot turns red, because
 *  the change never happened and that outranks what kind it was. */
function RejectMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" className="cf-reject-mark" aria-hidden>
      <circle cx="8" cy="8" r="6.5" />
      <line x1="5.6" y1="5.6" x2="10.4" y2="10.4" />
      <line x1="10.4" y1="5.6" x2="5.6" y2="10.4" />
    </svg>
  );
}

/** The key, stated once, in the same shapes and colours the picture uses. */
function Legend({
  lanes,
  laneColor,
}: {
  lanes: BranchLane[];
  laneColor: (i: number) => string;
}) {
  return (
    <div className="cf-legend">
      {lanes.map((l, i) => (
        <span key={l.name} className="cf-legend-item">
          <i className="cf-legend-line" style={{ background: laneColor(i) }} />
          {l.name}
        </span>
      ))}
      <span className="cf-legend-div" />
      <span className="cf-legend-item">
        <svg width="16" height="16" viewBox="0 0 16 16" className="cf-legend-glyph">
          <circle cx="8" cy="8" r="4" fill="currentColor" />
        </svg>
        commit
      </span>
      <span className="cf-legend-item">
        <svg width="16" height="16" viewBox="0 0 16 16" className="cf-legend-glyph">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="8" cy="8" r="2.4" fill="currentColor" />
        </svg>
        merge
      </span>
      <span className="cf-legend-item is-reject">
        <svg width="16" height="16" viewBox="0 0 16 16" className="cf-legend-glyph">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <line x1="5.6" y1="5.6" x2="10.4" y2="10.4" stroke="currentColor" strokeWidth="1.6" />
          <line x1="10.4" y1="5.6" x2="5.6" y2="10.4" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        rejected
      </span>
      <span className="cf-legend-item">
        <svg width="16" height="16" viewBox="0 0 16 16" className="cf-legend-glyph">
          <polygon
            points="8,1.5 9.8,6 14.5,6 10.7,8.9 12.2,13.5 8,10.7 3.8,13.5 5.3,8.9 1.5,6 6.2,6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </svg>
        now
      </span>
    </div>
  );
}
