// describeChange turns one draft ChangeItem into a plain-language summary the
// review surfaces can render the same way: a short category tag, its tone, a
// one-line "what changed", and before/after values only where they make sense
// (a value edit). Structural changes (add/retire/update an instance, a direct
// file edit) get a real sentence instead of being forced into before/after
// columns - which is what made "Add instance test (clone of ...)" read as a
// value going from the source name to a label.
import { addedParamName, realignPayload, type ChangeItem } from "./api";
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
  /** a structural change that moves several named fields at once (instance
   *  metadata). "Metadata updated" tells an approver nothing they can act on;
   *  these are the fields, each with what it holds now and what it becomes. */
  fields?: { label: string; before: string; after: string }[];
}

/** Instance metadata fields, in the order they read, with the words the UI
 *  uses for them elsewhere. */
const INSTANCE_FIELDS: { key: string; label: string }[] = [
  { key: "environment", label: "Environment" },
  { key: "region", label: "Region" },
  { key: "zone", label: "Zone" },
  { key: "site", label: "Site" },
  { key: "softwareVersion", label: "Software version" },
  { key: "description", label: "Description" },
  { key: "versionName", label: "Version name" },
  { key: "status", label: "Status" },
  { key: "labels", label: "Labels" },
];

// instanceFields pairs the patch (what the edit sets) with the instance's
// values at the time it was staged (what it holds today), so a reviewer sees
// the move rather than the destination.
function instanceFields(oldV: unknown, newV: unknown): ChangeDesc["fields"] {
  const before = (oldV ?? {}) as Record<string, unknown>;
  const after = (newV ?? {}) as Record<string, unknown>;
  const out: NonNullable<ChangeDesc["fields"]> = [];
  for (const f of INSTANCE_FIELDS) {
    if (!(f.key in after) || after[f.key] == null) continue;
    const b = fmtValue(plain(before[f.key]));
    const a = fmtValue(plain(after[f.key]));
    if (b === a) continue;
    out.push({ label: f.label, before: b, after: a });
  }
  return out.length ? out : undefined;
}

// plain renders a labels map as key=value pairs so it compares as one string.
function plain(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}=${val}`)
      .join(", ");
  }
  return v;
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
  if (action === "unmanage-parameter") {
    const name = typeof it.new === "string" && it.new ? it.new : it.paramId;
    return {
      tag: "Unmanage",
      tone: "danger",
      kind: "instance",
      subject: name,
      what: "Configer stops managing it; the value stays in every file",
    };
  }
  if (action === "add-parameter") {
    const pm = it.new as { bindings?: { file?: string }[] } | undefined;
    const where = pm?.bindings?.[0]?.file ?? it.file;
    return {
      tag: "New parameter",
      tone: "ok",
      kind: "instance",
      subject: addedParamName(it),
      what: where ? `now managed, from ${where}` : "now managed",
    };
  }
  if (action === "realign-bindings") {
    const p = realignPayload(it);
    const moves = p.moves?.length ?? 0;
    const dropped = p.dropped?.length ?? 0;
    const parts: string[] = [];
    // Said in the terms the reader is in: entries in these files are numbered,
    // so adding or removing one in the middle shifts the numbering of every
    // entry under it. "N parameters follow the entries they name" was the
    // mechanism, not the meaning - true, and no help to anybody deciding
    // whether to approve. What they need is: nothing changed value.
    if (moves)
      parts.push(
        `${moves} existing parameter${moves === 1 ? " is" : "s are"} renumbered to keep pointing at the same value`,
      );
    if (dropped)
      parts.push(`${dropped} stop${dropped === 1 ? "s" : ""} being managed - the value is no longer in the file`);
    return {
      tag: "Renumbered",
      tone: dropped ? "review" : "neutral",
      kind: "file",
      subject: it.file ?? "the catalog",
      what: parts.join("; ") || "entries realigned",
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
    const fields = instanceFields(it.old, it.new);
    return {
      tag: "Instance settings",
      tone: "review",
      kind: "instance",
      subject: it.instance,
      what: fields
        ? `${fields.length} setting${fields.length === 1 ? "" : "s"} changed`
        : "metadata updated (environment, region or version)",
      fields,
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
