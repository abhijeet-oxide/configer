import { useMemo, useState } from "react";
import { Empty, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api, type Grid, type Instance, type RegionPlace } from "../api";
import { useRepoQuery } from "../repoQuery";
import { canonicalEnv, envHex } from "../theme";
import { InstanceDossier, derive, type InstNode } from "./InstanceTopology";
import { InlineNotice } from "./ui";

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
// Clicking a pin opens the SAME dossier a topology click opens. An instance has
// to mean the same thing wherever it is clicked, or each view becomes its own
// little product with its own rules.

// The projection is equirectangular: longitude and latitude map straight onto x
// and y. It distorts area badly toward the poles and is the right choice
// anyway - this is a map for FINDING a site, not measuring one, and it needs no
// projection library to draw or to invert.
const W = 1000;
const H = 500;
const RATIO = 2.6; // width : height of the viewport the map is drawn into
const projectX = (lon: number) => ((lon + 180) / 360) * W;
const projectY = (lat: number) => ((90 - lat) / 180) * H;

interface Pin {
  region: string;
  x: number;
  y: number;
  instances: Instance[];
}

// ring turns one polygon ring into SVG path data, BREAKING it wherever it
// crosses the antimeridian. Drawn naively, a country that spans 180 degrees
// (Russia, Fiji, Antarctica's outline) sends a segment straight back across the
// whole map, which is where the grey streaks came from.
function ring(coords: number[][]): string {
  const parts: string[] = [];
  let cur: string[] = [];
  let prevLon: number | null = null;
  const flush = () => {
    if (cur.length > 2) parts.push(cur.join("") + "Z");
    cur = [];
  };
  for (const [lon, lat] of coords) {
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) flush();
    cur.push(`${cur.length ? "L" : "M"}${projectX(lon).toFixed(1)} ${projectY(lat).toFixed(1)}`);
    prevLon = lon;
  }
  flush();
  return parts.join("");
}

// worldPaths reads the land outline once and projects it. The geometry is
// ~100KB, so it is imported DYNAMICALLY: a view nobody opens must not be paid
// for by everyone who opens the app.
async function worldPaths(): Promise<string[]> {
  const [topo, { feature }] = await Promise.all([
    import("world-atlas/countries-110m.json"),
    import("topojson-client"),
  ]);
  const topology = (topo.default ?? topo) as unknown as Parameters<typeof feature>[0];
  const objects = (topology as unknown as { objects: Record<string, never> }).objects;
  const collection = feature(topology, objects.countries) as unknown as {
    features: { geometry: { type: string; coordinates: unknown } | null }[];
  };

  const out: string[] = [];
  for (const f of collection.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") {
      out.push((g.coordinates as number[][][]).map(ring).join(""));
    } else if (g.type === "MultiPolygon") {
      out.push((g.coordinates as number[][][][]).map((p) => p.map(ring).join("")).join(""));
    }
  }
  return out.filter(Boolean);
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
  // The world does not change, so it is fetched once per session and shared by
  // every application.
  const worldQ = useQuery({
    queryKey: ["world-map"],
    queryFn: worldPaths,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<InstNode | null>(null);
  const [whole, setWhole] = useState(true);

  const nodes = useMemo(() => derive(grid, instances).insts, [grid, instances]);
  const nodeOf = (name: string) => nodes.find((n) => n.name === name) ?? null;

  const { pins, unplaced, unset } = useMemo(() => {
    const byRegion = new Map<string, Instance[]>();
    const noRegion: Instance[] = [];
    for (const i of instances) {
      const key = (i.region ?? "").trim().toLowerCase();
      if (!key) {
        noRegion.push(i);
        continue;
      }
      byRegion.set(key, [...(byRegion.get(key) ?? []), i]);
    }
    const located = new Map((placesQ.data ?? []).map((p) => [p.region.toLowerCase(), p]));
    const pins: Pin[] = [];
    const unplaced: { region: string; instances: Instance[] }[] = [];
    for (const [key, list] of byRegion) {
      const place = located.get(key);
      if (place) {
        pins.push({ region: place.region, x: projectX(place.lon), y: projectY(place.lat), instances: list });
      } else {
        unplaced.push({ region: list[0].region ?? key, instances: list });
      }
    }
    pins.sort((a, b) => b.instances.length - a.instances.length || a.region.localeCompare(b.region));
    unplaced.sort((a, b) => a.region.localeCompare(b.region));
    return { pins, unplaced, unset: noRegion };
  }, [instances, placesQ.data]);

  // Fit the frame to the pins: an estate entirely in one country should read as
  // that country, not as specks on an ocean. The box is then grown to the
  // viewport's own shape, because a mismatched one is letterboxed by the
  // browser - which is what put an empty band down the side of the map.
  const [view, zoom] = useMemo(() => {
    if (whole || pins.length === 0) return [`0 0 ${W} ${W / RATIO}`, 1] as const;
    const xs = pins.map((p) => p.x);
    const ys = pins.map((p) => p.y);
    const pad = 70;
    let minX = Math.min(...xs) - pad;
    let minY = Math.min(...ys) - pad;
    let w = Math.max(...xs) - Math.min(...xs) + pad * 2;
    let h = Math.max(...ys) - Math.min(...ys) + pad * 2;
    // A single site would otherwise zoom to a street corner.
    w = Math.max(w, 300);
    h = Math.max(h, 150);
    if (w / h < RATIO) {
      const need = h * RATIO;
      minX -= (need - w) / 2;
      w = need;
    } else {
      const need = w / RATIO;
      minY -= (need - h) / 2;
      h = need;
    }
    if (w > W) {
      w = W;
      h = W / RATIO;
    }
    minX = Math.min(Math.max(minX, 0), W - w);
    minY = Math.min(Math.max(minY, 0), H - h);
    return [`${minX} ${minY} ${w} ${h}`, W / w] as const;
  }, [pins, whole]);

  // A pin takes the environment's colour only when everything under it agrees.
  // One dot covering a production box and a lab box cannot honestly claim to be
  // either, so it stays neutral.
  const pinColor = (p: Pin) => {
    const envs = new Set(p.instances.map((i) => canonicalEnv(i.environment) ?? ""));
    return envs.size === 1 ? envHex([...envs][0] || undefined) : "var(--brand)";
  };
  // Pins are sized in SCREEN terms, so zooming in does not inflate them.
  const radius = (p: Pin) => (7 + Math.min(7, p.instances.length * 1.4)) / zoom;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Where this application runs. A pin comes from the instance's region, read from its name
          unless somebody set it. Click one to open the instance.
        </Typography.Text>
        {pins.length > 0 && (
          <button type="button" className="cf-geo-zoom" onClick={() => setWhole(!whole)}>
            {whole ? "Fit to instances" : "Zoom out"}
          </button>
        )}
      </div>

      {instances.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No instances to place." />
      ) : (
        <>
          <div className="cf-geo">
            <svg
              viewBox={view}
              preserveAspectRatio="xMidYMid slice"
              className="cf-geo-svg"
              role="img"
              aria-label="Instances by region"
            >
              <rect x={-W} y={-H} width={W * 3} height={H * 3} className="cf-geo-sea" />
              {(worldQ.data ?? []).map((d, i) => (
                <path key={i} d={d} className="cf-geo-land" />
              ))}
              {pins.map((p) => {
                const on = hovered === p.region;
                const r = radius(p);
                return (
                  <g
                    key={p.region}
                    className={"cf-geo-pin" + (on ? " is-on" : "")}
                    onMouseEnter={() => setHovered(p.region)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() =>
                      p.instances.length === 1
                        ? setSelected(nodeOf(p.instances[0].name))
                        : setHovered(p.region)
                    }
                  >
                    <circle cx={p.x} cy={p.y} r={r * 2.4} className="cf-geo-halo" style={{ fill: pinColor(p) }} />
                    <circle cx={p.x} cy={p.y} r={r} className="cf-geo-core" style={{ fill: pinColor(p) }} />
                    <text x={p.x} y={p.y + r * 0.36} className="cf-geo-count" style={{ fontSize: r * 1.15 }}>
                      {p.instances.length}
                    </text>
                  </g>
                );
              })}
            </svg>

            {worldQ.isLoading && <div className="cf-geo-veil">Drawing the map…</div>}
            {!worldQ.isLoading && pins.length === 0 && (
              <div className="cf-geo-veil">No instance has a region that can be placed yet.</div>
            )}

            {/* Every pin is also a row, because a map is a poor list: pins
                overlap, a small one is a hard target, and a keyboard cannot
                hover. The rows carry the same colour and open the same
                dossier. */}
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
