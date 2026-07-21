// describeChange turns one draft ChangeItem into a plain-language summary the
// review surfaces can render the same way: a short category tag, its tone, a
// one-line "what changed", and before/after values only where they make sense
// (a value edit). Structural changes (add/retire/update an instance, a direct
// file edit) get a real sentence instead of being forced into before/after
// columns - which is what made "Add instance test (clone of ...)" read as a
// value going from the source name to a label.
import type { ChangeItem } from "./api";
import { fmtValue } from "./rules";

export type ChangeTone = "review" | "ok" | "pending" | "danger" | "neutral";

/** Which shape the row is, so a table can render its subject correctly:
 *  a value edit names a parameter (+ instance); a structural change names an
 *  instance or a file and carries no separate instance column. */
export type ChangeKind = "value" | "instance" | "file";

export interface ChangeDesc {
  /** short category label, e.g. "Value", "New instance" */
  tag: string;
  tone: ChangeTone;
  kind: ChangeKind;
  /** the primary subject on its own: a parameter id, an instance, or a file. */
  subject: string;
  /** what happens to it, in words */
  what: string;
  /** only for value-shaped edits, so callers can show before -> after */
  before?: string;
  after?: string;
}

export function describeChange(it: ChangeItem): ChangeDesc {
  const action = it.action ?? "set";

  if (action === "add-instance") {
    const src = typeof it.old === "string" && it.old ? it.old : "";
    return {
      tag: "New instance",
      tone: "ok",
      kind: "instance",
      subject: it.instance,
      what: src ? `cloned from ${src}` : "empty (no values copied)",
    };
  }
  if (action === "remove-instance") {
    return {
      tag: "Retire instance",
      tone: "danger",
      kind: "instance",
      subject: it.instance,
      what: "folder and registry entry removed",
    };
  }
  if (action === "update-instance") {
    return {
      tag: "Instance settings",
      tone: "review",
      kind: "instance",
      subject: it.instance,
      what: "metadata updated (environment, region or version)",
    };
  }
  if (action === "edit-file") {
    return {
      tag: "File",
      tone: "review",
      kind: "file",
      subject: it.file ?? "a file",
      what: "edited directly",
    };
  }
  if (action === "reset") {
    return {
      tag: "Reset",
      tone: "pending",
      kind: "value",
      subject: it.paramId,
      what: "back to the inherited value",
      before: fmtValue(it.old),
    };
  }
  if (action === "exclude") {
    return {
      tag: "Removed",
      tone: "danger",
      kind: "value",
      subject: it.paramId,
      what: "removed from this instance",
      before: fmtValue(it.old),
    };
  }
  // Plain value edit (set). A previously-empty value reads as "Added".
  const added = it.old === null || it.old === undefined || it.old === "";
  return {
    tag: added ? "Added" : "Value",
    tone: added ? "ok" : "review",
    kind: "value",
    subject: it.paramId,
    what: added ? "set for the first time" : "changed",
    before: fmtValue(it.old),
    after: fmtValue(it.new),
  };
}
