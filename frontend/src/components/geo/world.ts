import {
  geoAlbersUsa,
  geoNaturalEarth1,
  geoPath,
  type GeoPermissibleObjects,
  type GeoProjection,
} from "d3-geo";

// The geometry behind the estate map, and the projection that puts a site on it.
//
// This used to be a hand-rolled equirectangular map: longitude straight onto x,
// latitude straight onto y, with a special case to stop Russia streaking across
// the whole picture at the antimeridian. It drew, but it drew the wrong thing.
// An estate that is entirely in the United States - which is most of them -
// came out as a fan of dots across a rectangle where Maine and Seattle are
// nearly the same distance apart as Miami and Anchorage, and with no state
// lines there was nothing on the picture to recognise.
//
// d3-geo does projections properly, so the map can be the RIGHT one for what is
// being looked at:
//
//   United States - geoAlbersUsa: the projection every American map uses, with
//                   Alaska and Hawaii brought in as insets so a fleet in all
//                   fifty states fits one frame at a readable size. State
//                   outlines come with it, which is what makes a site
//                   recognisable at a glance.
//   World         - geoNaturalEarth1: honest continent shapes, no polar
//                   distortion, no antimeridian special case to get wrong.
//
// Both projections are FITTED to the geometry rather than scaled by hand, so
// the map fills its frame exactly and the pins land where the projection says
// they land - the picture and the dots on it can never disagree.

export type Mode = "us" | "world";

/** The size the map is drawn at, quantized. The drawing box is the ELEMENT's
 *  own box rather than a fixed one, so the projection fills the frame exactly
 *  at every window size - a fixed box has one aspect ratio, and the moment the
 *  frame is a different shape the browser letterboxes it and puts a band of
 *  dead space down one side. Quantizing stops a drag of the window edge from
 *  re-projecting the world on every pixel. */
export function boxOf(width: number, height: number): { w: number; h: number } {
  const q = (n: number) => Math.max(Math.round(n / 40) * 40, 160);
  return { w: q(width), h: q(height) };
}

export interface Geography {
  /** filled land */
  land: string;
  /** interior borders (state lines, country lines) drawn as one mesh */
  borders: string;
  /** the outer coastline, drawn over the fill so the edge stays crisp */
  outline: string;
  /** longitude/latitude to a point in the drawing box, or null when the
   *  projection cannot place it - which geoAlbersUsa says honestly about
   *  anywhere outside the United States. */
  project: (lon: number, lat: number) => [number, number] | null;
}

type Topology = Parameters<typeof import("topojson-client").feature>[0];

/** Load and project one mode's geometry. The topojson files are ~110KB each, so
 *  they are imported DYNAMICALLY: a view nobody opens must not be paid for by
 *  everybody who opens the app. */
export async function geography(mode: Mode, w: number, h: number): Promise<Geography> {
  const { feature, mesh } = await import("topojson-client");

  const topo = (
    mode === "us"
      ? ((await import("us-atlas/states-10m.json")) as unknown)
      : ((await import("world-atlas/countries-110m.json")) as unknown)
  ) as { default?: unknown };
  const topology = ((topo as { default?: unknown }).default ?? topo) as Topology;
  const objects = (topology as unknown as { objects: Record<string, never> }).objects;

  const key = mode === "us" ? "states" : "countries";
  const shapes = feature(topology, objects[key]) as unknown as GeoPermissibleObjects;
  // The outline is the nation for the US file and the union of every country
  // for the world one - either way it is the mesh with no interior filter.
  const outlineGeom = mesh(topology, objects[key], (a, b) => a === b) as unknown as GeoPermissibleObjects;
  const bordersGeom = mesh(topology, objects[key], (a, b) => a !== b) as unknown as GeoPermissibleObjects;

  const pad = 10;
  const projection: GeoProjection = (mode === "us" ? geoAlbersUsa() : geoNaturalEarth1()).fitExtent(
    [
      [pad, pad],
      [w - pad, h - pad],
    ],
    shapes,
  );
  const path = geoPath(projection);

  return {
    land: path(shapes) ?? "",
    borders: path(bordersGeom) ?? "",
    outline: path(outlineGeom) ?? "",
    project: (lon, lat) => {
      const p = projection([lon, lat]);
      return p ? [p[0], p[1]] : null;
    },
  };
}

/** Whether a coordinate is somewhere geoAlbersUsa can draw. The projection
 *  itself is the authority - it returns nothing for a point it cannot place -
 *  but the mode has to be chosen BEFORE the geometry loads, so this answers the
 *  same question from a bounding box: the lower 48 plus Alaska and Hawaii. */
export function inUnitedStates(lat: number, lon: number): boolean {
  if (lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66) return true; // lower 48
  if (lat >= 51 && lat <= 72 && lon >= -170 && lon <= -129) return true; // Alaska
  if (lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154) return true; // Hawaii
  return false;
}
