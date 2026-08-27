import { bindingsOf, type Binding, type Instance, type Parameter, type Scope } from "./api";

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

/** The three answers a reader actually needs: everyone, a group of systems, or
 *  this one system. `zone` and `environment` are groupings like `site` is, and
 *  collapse into it - the question is "a group", the field says which. */
export type ScopeFacet = "global" | "site" | "instance";

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
  if (groupField(declared)) return "site";
  // Nothing declared it shared, but every place it is written is a file every
  // instance reads. Calling that per-instance would be a lie the first edit
  // exposes.
  const bindings = bindingsOf(p as Parameter);
  if (bindings.length > 0 && bindings.every((b) => bindingLayer(b) !== "instance")) return "global";
  return "instance";
}

interface FacetMeta {
  /** how the filter and the column name it */
  label: string;
  /** the tag's colour, in Ant Design's vocabulary */
  color: string;
  /** what it means, in one sentence, on hover */
  explain: string;
}

// Three scopes, three hues, and they are far enough apart to be told apart at a
// glance down a column of hundreds of rows. Nothing here borrows red, orange or
// gold: those mean "wrong" or "waiting" everywhere else in the product, and a
// setting is not wrong for being shared.
export const SCOPE_META: Record<ScopeFacet, FacetMeta> = {
  global: {
    label: "Global",
    color: "purple",
    explain: "One shared value: editing it changes every instance at once",
  },
  site: {
    label: "Site-specific",
    color: "cyan",
    explain: "Shared by the instances of one group: editing it changes that group",
  },
  instance: {
    label: "Instance-specific",
    color: "blue",
    explain: "Each instance holds its own value: editing it changes that one system",
  },
};

/** The scope filter's own vocabulary: "all" plus the three facets. */
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
  const field = groupField(param.scope);
  if (facet === "site" && field) {
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

/** The groups a set of instances falls into for one group scope, in the order
 *  the instances arrived (which is already the estate order - see
 *  backend/internal/region). Used to say "these three sites" rather than
 *  "23 instances". */
export function groupsOf(
  param: Pick<Parameter, "scope">,
  instances: Instance[],
): { key: string; instances: Instance[] }[] {
  const field = groupField(param.scope);
  if (!field) return [];
  const out: { key: string; instances: Instance[] }[] = [];
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
  const field = groupField(param.scope);
  if (facet === "site" && field) {
    const reached = reachOf(param, instances, focus);
    const keys = [...new Set(reached.map((i) => (i[field] ?? "").trim()).filter(Boolean))];
    if (keys.length === 0) return `No ${field} set on these instances, so this applies per instance`;
    const many = reached.length;
    return `Applies to ${keys.join(", ")} - ${many} instance${many === 1 ? "" : "s"}`;
  }
  return focus ? `Applies to ${focus} only` : "Applies to the instances you pick";
}
