import { fmtValue, type Rules } from "../../rules";
import type { Cell, Row } from "../../api";
import type { ScopeFacet } from "../../scope";

// The shapes the group editor works in, and the lookups it does per field.
//
// They live here rather than in the dialog because the BODY is a separate
// component now (GroupBody): a branch can hold seven hundred settings, and
// rendering seven hundred form controls at once is a second of blocked main
// thread, so only the ones on screen are rendered. That split needs a vocabulary
// both halves share.

/** One editing target: a column of the form, and the instances a value typed
 *  into it will really be written to. */
export interface Col {
  key: string;
  label: string;
  sub?: string;
  /** the instances this column writes to - the whole point of the column */
  instances: string[];
}

export interface Member {
  row: Row;
  trail: string[];
  label: string;
  facet: ScopeFacet;
}

/** A section of the form: the settings at one scope, and the columns they are
 *  edited in. */
export interface Section {
  facet: ScopeFacet;
  members: Member[];
  cols: Col[];
  /** the sentence above the fields, saying what a change here reaches */
  reach: string;
}

/** What a field needs to know about the value under it, worked out ONCE for the
 *  whole form rather than three times per render per field. */
export interface Committed {
  /** the value the column's instances agree on, or undefined when they do not */
  value: unknown;
  /** they do not agree */
  mixed: boolean;
  /** the cell the lock state is read from */
  cell: Cell | undefined;
}

/** The value a column currently shows: the one its instances agree on, or a
 *  marker that they do not. A field that silently showed the first instance's
 *  value would make "apply to all" quietly overwrite the others with it. */
export function committedFor(row: Row, col: Col): Committed {
  let cell: Cell | undefined;
  let first: string | undefined;
  let mixed = false;
  for (const n of col.instances) {
    const c = row.cells[n];
    if (cell === undefined && c) cell = c;
    const s = fmtValue(c?.value);
    if (first === undefined) first = s;
    else if (s !== first) mixed = true;
  }
  if (col.instances.length === 0) return { value: undefined, mixed: false, cell: undefined };
  return { value: mixed ? undefined : row.cells[col.instances[0]]?.value, mixed, cell };
}

/** Every (field, column) pair's committed value, keyed the way the edits are.
 *  One pass over the sections instead of a lookup inside every render of every
 *  field - which on a form of hundreds is hundreds of scans per keystroke. */
export function committedIndex(sections: Section[]): Map<string, Committed> {
  const m = new Map<string, Committed>();
  for (const sec of sections) {
    for (const col of sec.cols) {
      for (const mem of sec.members) {
        m.set(`${mem.row.param.id}|${col.key}`, committedFor(mem.row, col));
      }
    }
  }
  return m;
}

/** Which (member, column) a field key belongs to, so a save can walk the EDITS
 *  rather than walking every field looking for the few that moved. */
export function fieldIndex(sections: Section[]): Map<string, { member: Member; col: Col }> {
  const m = new Map<string, { member: Member; col: Col }>();
  for (const sec of sections) {
    for (const col of sec.cols) {
      for (const mem of sec.members) m.set(`${mem.row.param.id}|${col.key}`, { member: mem, col });
    }
  }
  return m;
}

/** The form's fieldsets: the members grouped by the route ABOVE their own leaf,
 *  in the order they arrived.
 *
 *  A branch several levels deep otherwise repeats its route in every label -
 *  "capacity-profile-config[1].amr-wb", "capacity-profile-config[1].g711" - each
 *  truncated to make room for the one word that differs, which is the word that
 *  got cut. Said once as a heading, the fields underneath can be called what
 *  they are. A group whose members are all direct children has ONE fieldset with
 *  no heading, because there is no route to say. */
export function fieldsets(members: Member[]): { key: string; members: Member[] }[] {
  const out: { key: string; members: Member[] }[] = [];
  const at = new Map<string, number>();
  for (const m of members) {
    const key = m.trail.slice(0, -1).join(".");
    const idx = at.get(key);
    if (idx === undefined) {
      at.set(key, out.length);
      out.push({ key, members: [m] });
    } else {
      out[idx].members.push(m);
    }
  }
  return out;
}

/** How wide a column needs to be for this fieldset's longest label to read in
 *  full. A fixed column width is why four long names got jammed into four
 *  narrow columns and every one of them was cut - the grid never knew the
 *  labels needed more room than a short boolean's did. Sized to the longest
 *  member, a small fieldset of long names naturally settles into fewer, wider
 *  columns (four settings as 2x2 rather than 4x1) while a fieldset of short
 *  ones still fills the row. */
export function fieldColWidth(members: Member[]): number {
  const longest = members.reduce((n, m) => Math.max(n, m.trail[m.trail.length - 1].length), 0);
  return Math.min(460, Math.max(220, longest * 8 + 70));
}

/** Whether a field needs the whole row rather than a column of the form: a list
 *  of entries and a paragraph of text are unreadable in a third of a dialog. */
export function isWide(type: string, value: unknown): boolean {
  if (type === "list") return true;
  const s = value === null || value === undefined ? "" : String(value);
  return s.length > 60;
}

/** Rules are derived from the parameter plus the preset library, which does not
 *  change while a dialog is open. Computed once per parameter instead of once
 *  per render of every field. */
export function rulesIndex(
  members: Member[],
  effective: (p: Member["row"]["param"]) => Rules,
): Map<string, Rules> {
  const m = new Map<string, Rules>();
  for (const mem of members) m.set(mem.row.param.id, effective(mem.row.param));
  return m;
}
