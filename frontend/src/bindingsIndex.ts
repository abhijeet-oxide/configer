import { bindingsOf, expandBinding, type Grid } from "./api";

// bindingsIndex maps each REAL file path (binding templates expanded for one
// instance) to the parameters bound into it. One index serves both
// directions: "is this file managed" (has any entry) and "which parameters
// does this file carry" (Files -> Editor cross-navigation).
export function bindingsIndex(grid: Grid | undefined, instance: string | null): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!grid) return m;
  const inst = grid.instances.find((i) => i.name === instance) ?? (instance ? { name: instance } : null);
  for (const r of grid.rows) {
    for (const b of bindingsOf(r.param)) {
      if (!b.file) continue;
      const f = expandBinding(b, inst);
      const arr = m.get(f) ?? [];
      if (!arr.includes(r.param.id)) arr.push(r.param.id);
      m.set(f, arr);
    }
  }
  return m;
}
