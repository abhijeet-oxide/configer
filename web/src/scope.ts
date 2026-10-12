import { bindingsOf, type Binding, type Instance, type Parameter, type Scope } from "./api";
import {
  ScopeGlobalOutlined, ScopeEnvironmentOutlined, ScopeZoneOutlined,
  ScopeSiteOutlined, ScopeInstanceOutlined,
} from "./icons";

// How widely an edit lands - the first thing anybody needs to know before they
// change a value, and the one thing a grid of identical numbers cannot say.
//
// Twelve instances showing "example.com" look exactly the same whether that is
// one shared line every system reads or twelve independent copies that happen
// to agree. The difference is the whole difference between fixing a typo and
// changing production twelve times, so it is not left to be inferred from the
// provenance badge on one cell.
//
// A parameter's scope is DECLARED in the catalog, but the repository has the
// last word: a setting declared per-instance whose only home is a shared file
// IS global, whatever the catalog says, because that is what editing it does.
// So the facet below is read from both, and the grid, the scope column, the
// filter and the group editor all read it from here rather than each deciding
// for itself.

export type { Scope };

/** Every scope the product actually means, kept apart.
 *
 *  `zone` and `environment` used to collapse into `site` here, on the reasoning
 *  that the reader only needs to know "a group". They do not: the details panel
 *  offered all three, the toolbar offered one, and a setting somebody carefully
 *  declared zone-scoped came back reading "Site-specific" with no way to filter
 *  for it - so the two halves of the product disagreed about what had been
 *  saved. A group scope has to say WHICH grouping, because that is the whole
 *  content of the declaration: it names the instances an edit reaches. */
export type ScopeFacet = "global" | "site" | "zone" | "environment" | "instance";

/** The group scopes, widest grouping to narrowest, in the one order every list
 *  of them is drawn in. */
export const GROUP_FACETS = ["environment", "zone", "site"] as const;

/** Which instance field a group scope is shared across, or null when the scope
 *  is not a group scope. */
export function groupField(scope: string | undefined): "site" | "zone" | "environment" | null {
  switch ((scope ?? "").toLowerCase()) {
    case "site":
      return "site";
    case "zone":
      return "zone";
    case "environment":
      return "environment";
    default:
      return null;
  }
}

/** Whether this facet groups instances (as opposed to reaching all of them or
 *  exactly one). */
export function isGroupFacet(f: ScopeFacet): f is "site" | "zone" | "environment" {
  return f === "site" || f === "zone" || f === "environment";
}

/** A binding's precedence layer, mirroring model.Binding.EffectiveLayer: an
 *  explicit layer wins, otherwise a templated file is per-instance and a
 *  literal one is shared. */
export function bindingLayer(b: Binding): string {
  if (b.layer) return b.layer;
  return /\{folder\}|\{instance\}/.test(b.file ?? "") ? "instance" : "base";
}

/** Where this parameter's edits land. Declared scope first; failing that, what
 *  its bindings actually do. */
export function effectiveScope(p: Pick<Parameter, "scope" | "bindings">): ScopeFacet {
  const declared = (p.scope ?? "").toLowerCase();
  if (declared === "global") return "global";
  const field = groupField(declared);
  if (field) return field;
  // Nothing declared it shared, but every place it is written is a file every
  // instance reads. Calling that per-instance would be a lie the first edit
  // exposes.
  const bindings = bindingsOf(p as Parameter);
  if (bindings.length > 0 && bindings.every((b) => bindingLayer(b) !== "instance")) return "global";
  return "instance";
}

/** Whether a value for this parameter is edited per instance at all. Anything
 *  else is edited ONCE, for everyone or for a named group - so the grid stops
 *  asking somebody to type the same number into four cells and hope. */
export function editsPerInstance(p: Pick<Parameter, "scope" | "bindings">): boolean {
  return effectiveScope(p) === "instance";
}

interface FacetMeta {
  /** how the filter and the column name it */
  label: string;
  /** the short word a column header or chip uses */
  short: string;
  /** the tag's colour, in Ant Design's vocabulary */
  color: string;
  /** what it means, in one sentence, on hover */
  explain: string;
  /** the instance field it groups by, for the group scopes */
  field?: "site" | "zone" | "environment";
}

// Five scopes, five hues, and they are far enough apart to be told apart at a
// glance down a column of hundreds of rows. Nothing here borrows red, orange or
// gold: those mean "wrong" or "waiting" everywhere else in the product, and a
// setting is not wrong for being shared.
export const SCOPE_META: Record<ScopeFacet, FacetMeta> = {
  global: {
    label: "Global",
    short: "All",
    color: "purple",
    explain: "One shared value: editing it changes every instance at once",
  },
  environment: {
    label: "Environment-specific",
    short: "Environment",
    color: "magenta",
    field: "environment",
    explain: "Shared by every instance in one environment: editing it changes that environment",
  },
  zone: {
    label: "Zone-specific",
    short: "Zone",
    color: "geekblue",
    field: "zone",
    explain: "Shared by every instance in one zone: editing it changes that zone",
  },
  site: {
    label: "Site-specific",
    short: "Site",
    color: "cyan",
    field: "site",
    explain: "Shared by every instance at one site: editing it changes that site",
  },
  instance: {
    label: "Instance-specific",
    short: "Instance",
    color: "blue",
    explain: "Each instance holds its own value: editing it changes that one system",
  },
};

/** Every scope, widest reach to narrowest. The one order they are listed in -
 *  the filter, the scope column's sort, the details panel's picker - because a
 *  list of scopes that reads in a different order in each place is a list
 *  nobody learns. */
export const SCOPE_FACETS: ScopeFacet[] = ["global", "environment", "zone", "site", "instance"];

/** The scope filter's own vocabulary: "all" plus every facet. */
export type ScopeFilter = "all" | ScopeFacet;

/** Which instances an edit to this parameter really reaches, given the instance
 *  the reader is working from. This is what the editor SAYS out loud before a
 *  value is typed - never a count worked out afterwards from what was written.
 *
 *  - global: every instance, whichever one you were looking at.
 *  - a group scope: the instances sharing the focused instance's site (or zone,
 *    or environment). With no focus, every instance that carries the field at
 *    all - an instance with no site belongs to no site group and is left out
 *    rather than quietly swept in.
 *  - instance: the focused instance alone.
 */
export function reachOf(
  param: Pick<Parameter, "scope" | "bindings">,
  instances: Instance[],
  focus?: string | null,
): Instance[] {
  const facet = effectiveScope(param);
  if (facet === "global") return instances;
  const field = SCOPE_META[facet].field;
  if (field) {
    const keyOf = (i: Instance) => (i[field] ?? "").trim();
    const anchor = instances.find((i) => i.name === focus);
    if (anchor) {
      const key = keyOf(anchor);
      return key ? instances.filter((i) => keyOf(i) === key) : [anchor];
    }
    return instances.filter((i) => keyOf(i) !== "");
  }
  const one = instances.find((i) => i.name === focus);
  return one ? [one] : [];
}

/** One group of instances a group-scoped parameter is edited by: the key
 *  ("dallas"), and the systems it reaches. */
export interface ScopeGroup {
  key: string;
  instances: Instance[];
}

/** The groups a set of instances falls into for one group scope, in the order
 *  the instances arrived (which is already the estate order - see
 *  backend/internal/region). Used to say "these three sites" rather than
 *  "23 instances". */
export function groupsOf(
  param: Pick<Parameter, "scope">,
  instances: Instance[],
): ScopeGroup[] {
  return groupsBy(groupField(param.scope), instances);
}

/** groupsOf against a field named directly, for the columns the grid draws when
 *  the reader has picked a scope rather than a parameter. */
export function groupsBy(
  field: "site" | "zone" | "environment" | null,
  instances: Instance[],
): ScopeGroup[] {
  if (!field) return [];
  const out: ScopeGroup[] = [];
  const at = new Map<string, number>();
  for (const i of instances) {
    const key = (i[field] ?? "").trim();
    if (!key) continue;
    const idx = at.get(key);
    if (idx === undefined) {
      at.set(key, out.length);
      out.push({ key, instances: [i] });
    } else {
      out[idx].instances.push(i);
    }
  }
  return out;
}

/** The instances that carry NO value for a group field, and so belong to no
 *  group of that kind. They are named rather than quietly dropped: "four of
 *  your systems have no site" is a fact about the estate somebody has to fix,
 *  not something for a column to hide. */
export function ungrouped(
  field: "site" | "zone" | "environment" | null,
  instances: Instance[],
): Instance[] {
  if (!field) return [];
  return instances.filter((i) => !(i[field] ?? "").trim());
}

/** One sentence naming exactly what a save will touch, in the reader's terms.
 *  A count on its own ("3 selected") is not an answer to "and what happens to
 *  everything else". */
export function reachSummary(
  param: Pick<Parameter, "scope" | "bindings">,
  instances: Instance[],
  focus?: string | null,
): string {
  const facet = effectiveScope(param);
  const n = instances.length;
  if (facet === "global") return `Applies to all ${n} instance${n === 1 ? "" : "s"}`;
  const field = SCOPE_META[facet].field;
  if (field) {
    const reached = reachOf(param, instances, focus);
    const keys = [...new Set(reached.map((i) => (i[field] ?? "").trim()).filter(Boolean))];
    if (keys.length === 0) return `No ${field} set on these instances, so this applies per instance`;
    const many = reached.length;
    return `Applies to ${keys.join(", ")} - ${many} instance${many === 1 ? "" : "s"}`;
  }
  return focus ? `Applies to ${focus} only` : "Applies to the instances you pick";
}

/** What a scope edit of this shape reaches, said in the fewest words that are
 *  still exact. Used on the button that saves it and in the toast afterwards,
 *  so the promise and the receipt use the same sentence. */
export function reachLabel(facet: ScopeFacet, group: string | null, count: number): string {
  const systems = `${count} instance${count === 1 ? "" : "s"}`;
  if (facet === "global") return `all instances (${systems})`;
  const field = SCOPE_META[facet].field;
  if (field && group) return `${field} ${group} (${systems})`;
  return systems;
}

/** The glyph for a scope, in ONE place. Three surfaces drew this map by hand -
 *  the grid's scope column, the group editor, its body - and each of them had to
 *  be found and corrected when the group scopes stopped collapsing into one. A
 *  scope that reads as a different thing in a different panel is not a scope. */
export const SCOPE_ICON: Record<ScopeFacet, typeof ScopeGlobalOutlined> = {
  global: ScopeGlobalOutlined,
  environment: ScopeEnvironmentOutlined,
  zone: ScopeZoneOutlined,
  site: ScopeSiteOutlined,
  instance: ScopeInstanceOutlined,
};
