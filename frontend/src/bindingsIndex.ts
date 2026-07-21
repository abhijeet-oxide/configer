import { ALL_INSTANCES, bindingsOf, expandBinding, type Grid } from "./api";

// bindingsIndex maps each REAL file path (binding templates expanded for one
// instance) to the parameters bound into it. One index serves both
// directions: "is this file managed" (has any entry) and "which parameters
// does this file carry" (Files -> Editor cross-navigation).
//
// With ALL_INSTANCES the templates are expanded for every instance and unioned,
// so the whole-repo file list (the default Files view) still knows which
// parameters live in each instance's file.
export function bindingsIndex(grid: Grid | undefined, instance: string | null): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!grid) return m;
  const targets =
    instance === ALL_INSTANCES || instance === null
      ? grid.instances.length
        ? grid.instances
        : [null]
      : [grid.instances.find((i) => i.name === instance) ?? { name: instance }];
  const add = (file: string, id: string) => {
    if (!file) return;
    const arr = m.get(file) ?? [];
    if (!arr.includes(id)) arr.push(id);
    m.set(file, arr);
  };
  for (const r of grid.rows) {
    for (const b of bindingsOf(r.param)) {
      if (!b.file) continue;
      for (const inst of targets) add(expandBinding(b, inst), r.param.id);
    }
  }
  return m;
}
