import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Segmented, Tag, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api, type Grid, type Instance, type RegionPlace } from "../api";
import { useRepoQuery } from "../repoQuery";
import { canonicalEnv, envHex } from "../theme";
import { InstanceDossier, derive, type InstNode } from "./InstanceTopology";
import { InlineNotice } from "./ui";
import { boxOf, geography, inUnitedStates, type Mode } from "./geo/world";
import { usePanZoom } from "./geo/usePanZoom";
import { useElementSize } from "../hooks";

// The estate on a map: where its instances actually are.
//
// The table answers "what is there" and the topology answers "why does this
// hold that value". Neither answers "where in the world is this fleet", which
// on an estate spread across sites is the first question asked when one site is
// in trouble.
//
// A pin comes from the instance's REGION, which detection reads out of its own
// name (backend/internal/region). A region nobody gave coordinates to is not
// guessed at: it is named beside the map, so the gap is visible instead of
// silently absent.
//
// Two things make this a map rather than a diagram of dots. The projection is a
// real one, chosen for what is being looked at (see geo/world.ts): a US estate
// gets the projection American maps are drawn in, with state lines, so a site is
// recognisable without reading its label. And it MOVES - drag, wheel, double
// click, arrow keys - because three sites on one campus are one dot until
// somebody can get closer.
//
// Clicking a pin opens the SAME dossier a topology click opens. An instance has
// to mean the same thing wherever it is clicked, or each view becomes its own
// little product with its own rules.

interface Pin {
  region: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  instances: Instance[];
}

export default function InstancesGeography({
  grid,
  instances,
}: {
  grid: Grid;
  instances: Instance[];
}) {
  const placesQ = useRepoQuery<RegionPlace[]>({
    queryKey: ["regions"],
    queryFn: api.regions,
    staleTime: 5 * 60_000,
  });

  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<InstNode | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  // The stage's own box IS the drawing box - see boxOf. Its size comes from
  // CSS, so the map is whatever shape the layout gives it and fills it exactly.
  const { ref: stageRef, width: stageW, height: stageH } = useElementSize<HTMLDivElement>();
  const { w: W, h: H } = boxOf(stageW || 960, stageH || 420);

  const nodes = useMemo(() => derive(grid, instances).insts, [grid, instances]);
  const nodeOf = (name: string) => nodes.find((n) => n.name === name) ?? null;

  // The places, in ESTATE order. `instances` arrives sorted the way every list
  // of instances is sorted (see backend/internal/region: east coast to west
  // coast, then by name, then by number), so building the map in the order they
  // arrive means the rail beside it reads in the same order as the table and
  // the grid's columns - rather than in a third order of its own.
  const { placed, unplaced, unset, usOnly } = useMemo(() => {
    const located = new Map((placesQ.data ?? []).map((p) => [p.region.toLowerCase(), p]));
    const order: string[] = [];
    const byRegion = new Map<string, Instance[]>();
    const noRegion: Instance[] = [];
    for (const i of instances) {
      const key = (i.region ?? "").trim().toLowerCase();
      if (!key) {
        noRegion.push(i);
        continue;
      }
      if (!byRegion.has(key)) {
        byRegion.set(key, []);
        order.push(key);
      }
      byRegion.get(key)!.push(i);
    }
    const placed: { region: string; lat: number; lon: number; instances: Instance[] }[] = [];
    const unplaced: { region: string; instances: Instance[] }[] = [];
    for (const key of order) {
      const list = byRegion.get(key)!;
      const place = located.get(key);
      if (place) placed.push({ region: place.region, lat: place.lat, lon: place.lon, instances: list });
      else unplaced.push({ region: list[0].region ?? key, instances: list });
    }
    return {
      placed,
      unplaced,
      unset: noRegion,
      usOnly: placed.length > 0 && placed.every((p) => inUnitedStates(p.lat, p.lon)),
    };
  }, [instances, placesQ.data]);

  // Which map to draw. An estate entirely inside the United States gets the US
  // one, because that is the map its owners already have in their heads; the
  // moment one site is elsewhere the world map is the only honest choice, since
  // Albers USA cannot draw a place outside the country at all. The reader can
  // still zoom out to the world - but never INTO a country map that would
  // silently drop half their fleet.
  const effectiveMode: Mode = mode ?? (usOnly ? "us" : "world");
  useEffect(() => {
    if (!usOnly && mode === "us") setMode(null);
  }, [usOnly, mode]);

  const geoQ = useQuery({
    queryKey: ["map", effectiveMode, W, H],
    queryFn: () => geography(effectiveMode, W, H),
    staleTime: Infinity,
    gcTime: Infinity,
    // The previous size's map stays on screen while the new one projects, so
    // resizing the window never blinks the map away.
    placeholderData: (prev) => prev,
  });

  const pins = useMemo<Pin[]>(() => {
    const project = geoQ.data?.project;
    if (!project) return [];
    const out: Pin[] = [];
    for (const p of placed) {
      const xy = project(p.lon, p.lat);
      // The projection is the authority on whether a place can be drawn. On the
      // US map anywhere abroad answers "no", and a pin invented at the edge of
      // the frame would be a lie about where a machine is.
      if (!xy) continue;
      out.push({ ...p, x: xy[0], y: xy[1] });
    }
    return out;
  }, [placed, geoQ.data]);

  const offMap = placed.length - pins.length;

  const { svgRef, transform, handlers, reset, zoomIn, zoomOut, fitTo, wasDragged } = usePanZoom(W, H);

  // Open framed on the estate rather than on the whole country: a fleet in
  // three states should read as three states, not as three specks.
  const [framed, setFramed] = useState<string>("");
  useEffect(() => {
    const key = `${effectiveMode}:${W}x${H}:${pins.map((p) => p.region).join(",")}`;
    if (!pins.length || framed === key) return;
    setFramed(key);
    fitTo({
      minX: Math.min(...pins.map((p) => p.x)),
      maxX: Math.max(...pins.map((p) => p.x)),
      minY: Math.min(...pins.map((p) => p.y)),
      maxY: Math.max(...pins.map((p) => p.y)),
    });
    // fitTo is stable; re-running on every render would fight the user's own
    // panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, effectiveMode, framed, W, H]);

  // A pin takes the environment's colour only when everything under it agrees.
  // One dot covering a production box and a lab box cannot honestly claim to be
  // either, so it stays neutral.
  const pinColor = (p: Pin) => {
    const envs = new Set(p.instances.map((i) => canonicalEnv(i.environment)).filter(Boolean));
    // Nothing under the pin names an environment, so the pin has none to show
    // and takes the brand colour - the same answer it gives when the instances
    // disagree. The grey it used to take was the "unknown environment" tint,
    // which is a claim about the environment rather than an absence of one, and
    // it left the white count on the pin unreadable.
    return envs.size === 1 ? envHex([...envs][0] as string) : "var(--brand)";
  };
  // Pins are sized in SCREEN terms, so zooming in does not inflate them into
  // blobs that cover the very ground the reader zoomed in to see.
  const radius = (p: Pin) => (7 + Math.min(7, p.instances.length * 1.4)) / transform.k;

  const hoveredPin = pins.find((p) => p.region === hovered);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Where this application runs. A pin comes from the instance's region, read from its name
          unless somebody set it. Drag to move, scroll to zoom, click a pin to open the instance.
        </Typography.Text>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {usOnly && (
            <Segmented
              size="small"
              value={effectiveMode}
              onChange={(v) => setMode(v as Mode)}
              options={[
                { value: "us", label: "United States" },
                { value: "world", label: "World" },
              ]}
            />
          )}
          <Tooltip title="Zoom out">
            <Button size="small" onClick={zoomOut} aria-label="Zoom out">-</Button>
          </Tooltip>
          <Tooltip title="Zoom in">
            <Button size="small" onClick={zoomIn} aria-label="Zoom in">+</Button>
          </Tooltip>
          <Button size="small" onClick={() => setFramed("")} disabled={!pins.length}>
            Fit to instances
          </Button>
          <Button size="small" type="text" onClick={reset}>Reset</Button>
        </div>
      </div>

      {instances.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No instances to place." />
      ) : (
        <>
          <div className="cf-geo">
            <div className="cf-geo-stage" ref={stageRef}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="xMidYMid meet"
              className="cf-geo-svg"
              role="img"
              tabIndex={0}
              aria-label={`Instances by region on a ${effectiveMode === "us" ? "United States" : "world"} map. Arrow keys pan, plus and minus zoom.`}
              {...handlers}
            >
              <rect x={0} y={0} width={W} height={H} className="cf-geo-sea" />
              <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
                {geoQ.data && (
                  <>
                    <path d={geoQ.data.land} className="cf-geo-land" />
                    <path d={geoQ.data.borders} className="cf-geo-border" />
                    <path d={geoQ.data.outline} className="cf-geo-coast" />
                  </>
                )}
                {pins.map((p) => {
                  const on = hovered === p.region;
                  const r = radius(p);
                  return (
                    <g
                      key={p.region}
                      className={"cf-geo-pin" + (on ? " is-on" : "")}
                      onMouseEnter={() => setHovered(p.region)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => {
                        // Letting go of a drag on top of a pin is not a click on
                        // the pin.
                        if (wasDragged()) return;
                        if (p.instances.length === 1) setSelected(nodeOf(p.instances[0].name));
                        else setHovered(p.region);
                      }}
                    >
                      <circle cx={p.x} cy={p.y} r={r * 2.4} className="cf-geo-halo" style={{ fill: pinColor(p) }} />
                      <circle cx={p.x} cy={p.y} r={r} className="cf-geo-core" style={{ fill: pinColor(p) }} />
                      <text x={p.x} y={p.y + r * 0.36} className="cf-geo-count" style={{ fontSize: r * 1.15 }}>
                        {p.instances.length}
                      </text>
                      {/* Close in, the pin names itself: at that magnification
                          the reader has stopped recognising states and started
                          asking which of these is which. */}
                      {transform.k >= 3 && (
                        <text
                          x={p.x}
                          y={p.y - r * 1.9}
                          className="cf-geo-label"
                          style={{ fontSize: 12 / transform.k }}
                        >
                          {p.region}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
            </div>

            {hoveredPin && (
              <div className="cf-geo-tip">
                <span className="cf-geo-dot" style={{ background: pinColor(hoveredPin) }} />
                <b>{hoveredPin.region}</b>
                <span>
                  {hoveredPin.instances.length} instance{hoveredPin.instances.length === 1 ? "" : "s"}
                </span>
              </div>
            )}

            {geoQ.isLoading && <div className="cf-geo-veil">Drawing the map…</div>}
            {!geoQ.isLoading && pins.length === 0 && (
              <div className="cf-geo-veil">No instance has a region that can be placed yet.</div>
            )}

            {/* Every pin is also a row, because a map is a poor list: pins
                overlap, a small one is a hard target, and a keyboard cannot
                hover. The rows carry the same colour and open the same
                dossier, in the same order the rest of the product lists an
                estate. */}
            {pins.length > 0 && (
              <div className="cf-geo-rail">
                {pins.map((p) => (
                  <div
                    key={p.region}
                    className={"cf-geo-place" + (hovered === p.region ? " is-on" : "")}
                    onMouseEnter={() => setHovered(p.region)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <div className="cf-geo-place-head">
                      <span className="cf-geo-dot" style={{ background: pinColor(p) }} />
                      {p.region}
                      <span className="cf-geo-place-n">{p.instances.length}</span>
                    </div>
                    {p.instances.map((i) => (
                      <button
                        key={i.name}
                        type="button"
                        className="cf-geo-inst"
                        title={i.description || `${i.name}: instance details`}
                        onClick={() => setSelected(nodeOf(i.name))}
                      >
                        <span className="cf-geo-dot" style={{ background: envHex(i.environment) }} />
                        <span className="mono">{i.name}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {offMap > 0 && (
            <InlineNotice tone="neutral">
              {offMap === 1 ? "One region is" : `${offMap} regions are`} outside this map. Switch to
              the world map to see {offMap === 1 ? "it" : "them"}.
            </InlineNotice>
          )}

          {unplaced.length > 0 && (
            <InlineNotice tone="neutral">
              Not on the map - no coordinates for{" "}
              {unplaced.map((u) => (
                <Tag key={u.region} style={{ marginInlineEnd: 4 }}>
                  {u.region} ×{u.instances.length}
                </Tag>
              ))}
              Give it lat/lon in <span className="mono">.configer/regions.yaml</span>.
            </InlineNotice>
          )}

          {unset.length > 0 && (
            <InlineNotice tone="neutral">
              {unset.length === 1 ? "One instance has" : `${unset.length} instances have`} no region
              yet:{" "}
              {unset.map((i) => (
                <Tag key={i.name} className="mono" style={{ marginInlineEnd: 4 }}>
                  {i.name}
                </Tag>
              ))}
            </InlineNotice>
          )}
        </>
      )}

      <InstanceDossier
        node={selected}
        meta={selected ? instances.find((i) => i.name === selected.name) : undefined}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
