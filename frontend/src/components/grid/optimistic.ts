// Optimistic staging for a cell edit.
//
// A value edit is a DRAFT operation: the service records the item, nothing
// touches Git. There is therefore nothing to wait for before the cell can show
// its new value - yet the grid used to repaint only after the write round trip
// AND a full grid refetch had landed, which is what made an edit read as laggy.
//
// So the caches are updated the moment the edit is issued, and the invalidations
// that follow reconcile with the service's answer in the background. The preview
// mirrors grid.ApplyDraft on the backend, so the optimistic cell and the
// refetched one agree.
import type { QueryClient } from "@tanstack/react-query";
import type { Cell, CellAction, CellSource, ChangeItem, ChangeRequest, Grid } from "../../api";

/** A staged cell edit: the body of PUT /api/values. */
export interface ValueEdit {
  instance: string;
  paramId: string;
  value?: unknown;
  action?: CellAction;
  scope?: "global";
}

type DraftData = { draft: ChangeRequest | null } | undefined;

/** The caches as they were before an optimistic edit, so a rejected write can
 *  put them back exactly. */
export interface EditSnapshot {
  grid: Grid | undefined;
  draft: DraftData;
}

/** stageEdit previews an edit in the grid and draft caches and returns the
 *  snapshot to restore if the write is rejected. */
export async function stageEdit(qc: QueryClient, edit: ValueEdit): Promise<EditSnapshot> {
  // Cancel first: an in-flight refetch would otherwise land on top of the
  // preview carrying pre-edit values.
  await Promise.all([
    qc.cancelQueries({ queryKey: ["grid"] }),
    qc.cancelQueries({ queryKey: ["draft"] }),
  ]);
  const snapshot: EditSnapshot = {
    grid: qc.getQueryData<Grid>(["grid"]),
    draft: qc.getQueryData<DraftData>(["draft"]),
  };
  qc.setQueryData<Grid>(["grid"], (g) => (g ? previewCells(g, edit) : g));
  qc.setQueryData<DraftData>(["draft"], (d) => previewDraft(d, edit, snapshot.grid));
  return snapshot;
}

/** unstageEdit puts both caches back after a rejected write. */
export function unstageEdit(qc: QueryClient, snap: EditSnapshot) {
  qc.setQueryData<Grid>(["grid"], snap.grid);
  qc.setQueryData<DraftData>(["draft"], snap.draft);
}

/** previewCells returns a copy of the grid with the edit applied to the cells it
 *  would change: the one instance's cell, or - for a shared edit - every cell
 *  not already overridden locally. */
function previewCells(g: Grid, edit: ValueEdit): Grid {
  const i = g.rows.findIndex((r) => r.param.id === edit.paramId);
  if (i < 0) return g;
  const row = g.rows[i];
  const set = (edit.action ?? "set") === "set";
  const cells = { ...row.cells };
  const touch = (name: string, source: CellSource) => {
    const c = cells[name];
    if (!c) return;
    // The value was validated client-side before it was sent, so preview it as
    // valid; a service rejection restores the snapshot instead.
    cells[name] = set
      ? { ...c, value: edit.value, set: true, source, pending: true, valid: true, message: undefined }
      : { ...c, value: null, set: false, pending: true, valid: true, message: undefined };
  };
  if (edit.scope === "global") {
    for (const [name, c] of Object.entries(row.cells)) {
      if (c.source !== "instance") touch(name, "base");
    }
  } else {
    touch(edit.instance, "instance");
  }
  const rows = [...g.rows];
  rows[i] = { ...row, cells };
  return { ...g, rows };
}

/** previewDraft adds (or replaces) the edit's item in the cached draft, so the
 *  pending badges, counts and hover before→after read right away.
 *
 *  With no draft open yet there is nothing to patch - the service opens one on
 *  this very write - so the cache is left alone and the item appears when the
 *  refetch lands. The grid preview above already carries the value. */
function previewDraft(d: DraftData, edit: ValueEdit, before: Grid | undefined): DraftData {
  if (!d?.draft) return d;
  const instance = edit.scope === "global" ? "" : edit.instance;
  const items = d.draft.items ?? [];
  const existing = items.find((it) => it.paramId === edit.paramId && it.instance === instance);
  const item: ChangeItem = {
    paramId: edit.paramId,
    instance,
    scope: edit.scope,
    action: edit.action ?? "set",
    // `old` is the COMMITTED baseline: keep the one already recorded for this
    // cell, otherwise take the value showing before this edit.
    old: existing ? existing.old : committedValue(before, edit),
    new: (edit.action ?? "set") === "set" ? edit.value : null,
    updatedAt: new Date().toISOString(),
  };
  const next = existing ? items.map((it) => (it === existing ? item : it)) : [...items, item];
  return { draft: { ...d.draft, items: next } };
}

function committedValue(g: Grid | undefined, edit: ValueEdit): unknown {
  const row = g?.rows.find((r) => r.param.id === edit.paramId);
  if (!row) return null;
  let cell: Cell | undefined = row.cells[edit.instance];
  if (edit.scope === "global" && !cell) {
    cell = Object.values(row.cells).find((c) => c.source !== "instance");
  }
  return cell?.value ?? null;
}
