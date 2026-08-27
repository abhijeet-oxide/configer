import { nameSegments, type Parameter } from "./api";

// Where a parameter sits in the NAME tree the left panel draws.
//
// A group key is the dotted prefix that panel built - and it built it by
// joining the parameter's own name STEPS, never by splitting the name on every
// dot. That distinction is load-bearing here for the same reason it is there: a
// key that itself contains a dot ("query.dependencies") is ONE step, so
// splitting a group key on "." to count its depth lands between two halves of a
// single key and matches the wrong rows.
//
// So a group is matched by rebuilding the same prefixes and comparing whole
// strings, which is exact whatever the keys contain.

/** The steps of `param`'s name BELOW the group, or null when it is not in that
 *  group at all. An empty array is impossible: a group is a non-leaf level, so
 *  anything inside it has at least its own leaf left over. */
export function groupTrail(
  param: Pick<Parameter, "name" | "nameSegments">,
  groupKey: string,
): string[] | null {
  const parts = nameSegments(param);
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}.${parts[i]}` : parts[i];
    if (acc === groupKey) return parts.slice(i + 1);
  }
  return null;
}

/** Whether the parameter lives anywhere under the group. */
export function inGroup(
  param: Pick<Parameter, "name" | "nameSegments">,
  groupKey: string,
): boolean {
  return groupTrail(param, groupKey) !== null;
}

/** How the group names itself: its last step, which is what the tree shows and
 *  what the reader clicked on. */
export function groupLeaf(groupKey: string): string {
  const parts = groupKey.split(".");
  return parts[parts.length - 1] || groupKey;
}

/** A parameter's label INSIDE a group: the steps below the group joined back
 *  up, so a nested setting reads "tls.enabled" rather than repeating the whole
 *  route the dialog's title already says. */
export function trailLabel(trail: string[]): string {
  return trail.join(".");
}

// ---------------------------------------------------------------------------
// The name tree itself, and the ONE order everything reads it in.
//
// The panel is a TRIE, so it hoists: every row of a group is drawn under that
// group, wherever the group first appears. A flat list cannot do that, so the
// two agree only when each group's rows happen to sit together in the catalog -
// and a setting written into two files does not, because the merge keeps the
// position of the first file and the (shorter) name of the other. The tree
// filed it under that name; the table left it where it was found; the last leaf
// of the tree was nowhere near the last row of the table, and clicking a row
// below it jumped to the middle of the tree.
//
// So the tree's own walk IS the order. Both the panel and the grid read it from
// here, through the same nameEntries, which is what stops them drifting again.

/** A leaf of the name tree: one parameter, at the node its name ends in. */
export interface NameLeaf {
  id: string;
  name: string;
  leaf: string;
  order: number; // position in the catalog, i.e. in the files
}

/** A node in the parameter-name trie. */
export interface NameNode {
  seg: string;
  prefix: string; // full dotted prefix, e.g. "admin.rebuildslave"
  depth: number; // how many steps deep, which is also how many path steps it spans
  count: number; // parameters in this subtree
  order: number; // the earliest catalog position under this node
  params: NameLeaf[];
  children: Map<string, NameNode>;
  // A parameter from anywhere under this node, so the node can answer "which
  // file, and where in it" without the tree carrying bindings of its own.
  sample?: Parameter;
}

/** What a node holds, sub-groups and own leaves together. */
export type NameEntry =
  | { kind: "group"; order: number; node: NameNode }
  | { kind: "param"; order: number; param: NameLeaf };

/** Builds the trie from the catalog, in catalog order. */
export function buildNameTree(params: Parameter[]): NameNode {
  const root: NameNode = { seg: "", prefix: "", depth: 0, count: 0, order: 0, params: [], children: new Map() };
  params.forEach((param, order) => {
    const parts = nameSegments(param);
    const leaf = parts[parts.length - 1];
    let level = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      prefix = prefix ? `${prefix}.${seg}` : seg;
      let node = level.children.get(seg);
      if (!node) {
        node = { seg, prefix, depth: i + 1, count: 0, order, params: [], children: new Map() };
        level.children.set(seg, node);
      }
      node.count++;
      if (!node.sample) node.sample = param;
      level = node;
    }
    level.params.push({ id: param.id, name: param.name, leaf, order });
  });
  return root;
}

/** A node's children and its own leaves, in the order they are drawn: by where
 *  each first appears in the files. */
export function nameEntries(node: NameNode): NameEntry[] {
  const out: NameEntry[] = [];
  for (const c of node.children.values()) out.push({ kind: "group", order: c.order, node: c });
  for (const p of node.params) out.push({ kind: "param", order: p.order, param: p });
  out.sort((a, b) => a.order - b.order);
  return out;
}

/** Parameter id -> its position in a full walk of the tree, top to bottom. This
 *  is the canonical row order: the last leaf in the panel is the last row in
 *  the grid, and every row is where the panel says it is. */
export function nameTreeOrder(root: NameNode): Map<string, number> {
  const order = new Map<string, number>();
  const walk = (n: NameNode) => {
    for (const e of nameEntries(n)) {
      if (e.kind === "param") order.set(e.param.id, order.size);
      else walk(e.node);
    }
  };
  walk(root);
  return order;
}
