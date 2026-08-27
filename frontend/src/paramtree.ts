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
