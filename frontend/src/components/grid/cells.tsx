import { Tag, Tooltip, Input, InputNumber, Select, Popover, Button, Space, Typography, Modal } from "antd";
import { CheckCircleFilled, FullscreenOutlined } from "../../icons";
import { useRef, useState } from "react";
import type { Cell, ChangeItem } from "../../api";
import {
  validateNumber,
  validateString,
  validateTyped,
  validateUnitChange,
  fmtValue,
  type Rules,
} from "../../rules";
import { semantic } from "../../theme";
import { diffValues, type DiffPart } from "../../valuediff";
import ValueDiff, { InlineValueDiff } from "../ui/ValueDiff";

// Cell rendering and the typed inline editors for the parameter grid. Split
// out of ParameterGrid so the grid file stays about layout and data flow.

// Short abbreviations for the layer source badge on each cell, with plain
// explanations surfaced on hover (and in the Legend).
export const scopeAbbrev: Record<string, string> = {
  default: "def",
  derived: "calc",
  base: "base",
  instance: "inst",
};

export const scopeExplain: Record<string, string> = {
  default: "Declared default: applies while no file carries the key",
  derived: "Computed from another parameter; overridden by any file value",
  base: "From a shared file every instance reads; one edit applies to all",
  instance: "Set in this instance's own files",
};

// Tag colors for the declared parameter scope column.
export const scopeColor: Record<string, string> = {
  global: "purple",
  instance: "default",
  default: "default",
};

export function SourceBadge({ cell }: { cell: Cell }) {
  // No badge for instance values (the norm): a chip marks values inherited
  // from the shared base layer or the declared default. A leading colored dot
  // carries the meaning so the matrix's inheritance shape reads at a glance;
  // the short label stays for anyone reading a single cell.
  if (!cell.set || cell.source === "instance") return null;
  return (
    <Tooltip title={scopeExplain[cell.source]}>
      <span className={`prov-chip prov-${cell.source}`}>
        <span className="prov-dot" />
        {scopeAbbrev[cell.source]}
      </span>
    </Tooltip>
  );
}

export function ListChips({ items }: { items: unknown[] }) {
  const shown = items.slice(0, 3);
  return (
    <span>
      {shown.map((it, i) => (
        <Tag key={i} style={{ marginInlineEnd: 2, fontSize: 11 }} className="mono">
          {String(it)}
        </Tag>
      ))}
      {items.length > 3 && (
        <Tooltip title={items.map(String).join(", ")}>
          <Tag style={{ fontSize: 11 }}>+{items.length - 3}</Tag>
        </Tooltip>
      )}
      {items.length === 0 && <span style={{ opacity: 0.4 }}>[ ]</span>}
    </span>
  );
}

// clip keeps a plain-text hover to a size somebody can actually read.
function clip(s: string, max = 90): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// StagedTip is what hovering a staged cell says: the value the files hold now,
// the value this draft gives them, and that neither is live yet. The pair is
// rendered as a real diff (removed struck in red, added marked green) because
// this is where the reader comes to ask "what exactly did I change here?" - so
// the grid itself can stay quiet and show one value.
function StagedTip({ it, editable }: { it: ChangeItem; editable?: boolean }) {
  const parts = it.action === "set" ? diffPair(it.old, it.new) : null;
  return (
    <div className="cell-tip">
      {parts ? (
        <>
          <div className="cell-tip-row">
            <span className="cell-tip-k">Now</span>
            <InlineValueDiff parts={parts} side="before" condensed={false} />
          </div>
          <div className="cell-tip-row">
            <span className="cell-tip-k">Becomes</span>
            <InlineValueDiff parts={parts} side="after" condensed={false} />
          </div>
        </>
      ) : (
        <div className="cell-tip-row">
          <span className="cell-tip-k">{clip(fmtValue(it.old))}</span>
          <span>
            →{" "}
            {it.action === "exclude"
              ? "removed from this instance"
              : it.action === "reset"
                ? "back to inherited"
                : clip(fmtValue(it.new))}
          </span>
        </div>
      )}
      <div className="cell-tip-note">
        Pending, not yet sent for review{editable ? " · double-click to change it again" : ""}
      </div>
    </div>
  );
}

export function CellView({
  cell,
  pendingItem,
  editable,
  beforeAfter,
}: {
  cell: Cell;
  pendingItem?: ChangeItem;
  /** the cell can still be opened for editing (drives the hover hint) */
  editable?: boolean;
  /** show a staged cell as "old -> new" in the grid itself (view option) */
  beforeAfter?: boolean;
}) {
  if (cell.state === "na") return <span className="cell-na">n/a</span>;

  // Pending edits: hovering shows exactly what will change - and that the cell
  // is still an ordinary editable value. A staged cell used to lose the
  // "double-click to edit" hint entirely, which (with the old chip styling)
  // read as "this is finished now, undo is all you get".
  const pendingTip = pendingItem ? <StagedTip it={pendingItem} editable={editable} /> : undefined;

  if (!cell.set) {
    return (
      <Tooltip title={pendingTip ?? "Absent on this instance: no file carries this key here"}>
        <span className={"cell-excluded" + (cell.pending ? " cell-pending" : "")}>∅ absent</span>
      </Tooltip>
    );
  }

  const cls: string[] = ["cell-inner"];
  if (cell.state === "deprecated") cls.push("cell-deprecated");
  if (cell.state === "new") cls.push("cell-new");
  if (!cell.valid) cls.push("cell-invalid");
  if (cell.pending) cls.push("cell-pending");

  // A staged cell shows the value the configuration WILL have - one value, in
  // the pending amber - with the characters that actually changed marked green
  // inside it. That is the whole difference the reader needs at a glance ("733,
  // and it is the middle digit that moved"); what it used to be is on hover.
  // Showing both values in every changed cell was the first attempt: correct,
  // and unreadable at a hundred edits, because it doubles the text in a column
  // sized for one value. It is still available - see the "Before and after in
  // changed cells" view option - for anyone reading a diff rather than a state.
  const diff =
    pendingItem && pendingItem.action === "set" && cell.set && !Array.isArray(cell.value)
      ? diffPair(pendingItem.old, cell.value)
      : null;

  let display: React.ReactNode;
  if (diff && beforeAfter) {
    display = (
      <span className="cell-diff">
        <InlineValueDiff parts={diff} side="before" />
        <span className="vd-arrow" aria-hidden>
          →
        </span>
        <InlineValueDiff parts={diff} side="after" />
      </span>
    );
  } else if (diff) {
    display = (
      <span className="mono cell-value">
        <InlineValueDiff parts={diff} side="after" condensed={false} />
      </span>
    );
  } else if (Array.isArray(cell.value)) {
    display = <ListChips items={cell.value} />;
  } else if (cell.value === undefined || cell.value === null || cell.value === "") {
    display = <span style={{ opacity: 0.3 }}>-</span>;
  } else if (typeof cell.value === "boolean") {
    display = <Tag color={cell.value ? "green" : "default"}>{cell.value ? "on" : "off"}</Tag>;
  } else {
    display = <span className="mono cell-value">{String(cell.value)}</span>;
  }

  const tip = pendingTip ?? (!cell.valid ? cell.message : undefined);
  // A value wider than its column truncates (see .cell-value), so a long one
  // keeps the whole of itself on hover. Only a long one: a native title on every
  // cell would shadow the grid's own "double-click to edit" hint for no gain.
  const full = typeof cell.value === "string" ? cell.value : undefined;
  const inner = (
    <span className={cls.join(" ")} title={!tip && full && full.length > 28 ? full : undefined}>
      {display}
      <SourceBadge cell={cell} />
    </span>
  );
  return tip ? (
    // Wide enough for two values, one per line: the default 250px wrapped a
    // hostname into four lines and the pair stopped reading as a pair.
    <Tooltip title={tip} overlayStyle={{ maxWidth: 460 }}>
      {inner}
    </Tooltip>
  ) : (
    inner
  );
}

// diffPair renders a before/after pair as diff parts, or null when nothing
// actually moved (a re-set to the same value is not a change to draw).
function diffPair(before: unknown, after: unknown): DiffPart[] | null {
  const b = fmtValue(before);
  const a = fmtValue(after);
  if (b === a) return null;
  return diffValues(b === "-" ? "" : b, a === "-" ? "" : a);
}

// --- Typed inline editors -------------------------------------------------
// Spreadsheet semantics: Enter commits, clicking away (blur) ALSO commits when
// the value is valid and changed (never silently discard someone's typing),
// Escape cancels explicitly, and an invalid value blocks the commit with a
// visible warning. The `done` ref guards the Enter-then-blur double fire.

export function NumberEditor({
  initial,
  rules,
  integer,
  onCommit,
  onCancel,
}: {
  initial: unknown;
  rules: Rules;
  integer: boolean;
  onCommit: (v: number) => void;
  onCancel: () => void;
}) {
  const start = initialNumber(initial);
  const [val, setVal] = useState<number | null>(start);
  const done = useRef(false);
  const err = validateNumber(val ?? "", rules, integer);
  // tryFinish commits when valid+changed. An out-of-range or fractional entry
  // is never rewritten to fit: Enter keeps the editor open with the rule
  // showing, and closing (blur) discards it, exactly like the string editor.
  const tryFinish = (raw: string | undefined, closing: boolean) => {
    if (done.current) return;
    // Commit whatever is visible in the input (not just React state) so the
    // value the user sees is exactly what is validated and saved.
    let v = val;
    if (raw != null) {
      const t = raw.trim();
      v = t === "" ? null : Number.isFinite(Number(t)) ? Number(t) : val;
    }
    if (v == null || v === start) {
      done.current = true;
      return onCancel();
    }
    if (validateNumber(v, rules, integer)) {
      if (closing) {
        done.current = true;
        onCancel();
      }
      return; // invalid: nothing is staged, the message stays on screen
    }
    done.current = true;
    onCommit(v);
  };
  return (
    <Tooltip open={!!err} title={err} color={semantic.danger}>
      <InputNumber
        size="small"
        autoFocus
        style={{ width: "100%" }}
        status={err ? "error" : undefined}
        // No min/max/precision props on purpose: those make the input silently
        // rewrite an out-of-range or fractional entry to the nearest allowed
        // value, which reads as the editor changing what was typed. The same
        // limits are enforced by validateNumber, which explains the rule.
        value={val}
        onChange={setVal}
        onPressEnter={(e) => tryFinish((e.target as HTMLInputElement).value, false)}
        onBlur={(e) => tryFinish(e.target.value, true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            done.current = true;
            onCancel();
          }
        }}
      />
    </Tooltip>
  );
}

// initialNumber is a cell's committed value as a number, or null when the cell
// carries nothing numeric (absent, empty, or a non-numeric value).
function initialNumber(initial: unknown): number | null {
  if (initial == null || initial === "") return null;
  const n = Number(initial);
  return Number.isFinite(n) ? n : null;
}

/** A value past this length (or carrying a newline) cannot be read, let alone
 *  edited, in a grid cell. It opens in a proper editor instead. */
export const BIG_VALUE = 60;

export function isBigValue(v: unknown): boolean {
  const s = String(v ?? "");
  return s.length > BIG_VALUE || s.includes("\n");
}

export function StringEditor({
  initial,
  rules,
  onCommit,
  onCancel,
  paramName,
}: {
  initial: unknown;
  rules: Rules;
  onCommit: (v: string) => void;
  onCancel: () => void;
  /** named in the expanded editor's title so it is clear what is being edited */
  paramName?: string;
}) {
  const [val, setVal] = useState(String(initial ?? ""));
  // A value that cannot fit in a cell opens expanded straight away: making
  // someone squint at 40 visible characters of a 2,000-character MariaDB block
  // and then discover the expand button is a worse first move than just
  // opening the room they need.
  const [expanded, setExpanded] = useState(() => isBigValue(initial));
  const done = useRef(false);
  // A dropped CPU/memory unit is only visible against the value being replaced,
  // so the check needs the committed value the editor opened on.
  const check = (v: string) => validateString(v, rules) ?? validateUnitChange(v, initial, rules.formatType);
  const err = check(val);
  const changed = val !== String(initial ?? "");
  // tryFinish commits when valid+changed; on blur an unchanged or invalid
  // value closes the editor without saving (Enter keeps it open to fix).
  const tryFinish = (raw: string, closing: boolean) => {
    if (done.current) return;
    const isChanged = raw !== String(initial ?? "");
    const invalid = check(raw);
    if (isChanged && !invalid) {
      done.current = true;
      onCommit(raw);
    } else if (closing || !isChanged) {
      done.current = true;
      onCancel();
    }
  };

  if (expanded) {
    return (
      <BigStringEditor
        initial={initial}
        value={val}
        onChange={setVal}
        rules={rules}
        paramName={paramName}
        onCommit={(v) => {
          done.current = true;
          onCommit(v);
        }}
        onCancel={() => {
          done.current = true;
          onCancel();
        }}
      />
    );
  }

  return (
    <Tooltip open={!!err} title={err} color={semantic.danger}>
      <Input
        size="small"
        autoFocus
        className="mono"
        value={val}
        status={err ? "error" : undefined}
        suffix={
          <Space size={2}>
            {changed && !err && <CheckCircleFilled style={{ color: semantic.ok }} />}
            <Tooltip title="Open in a bigger editor">
              <Button
                size="small"
                type="text"
                className="cell-expand"
                aria-label="Open this value in a bigger editor"
                icon={<FullscreenOutlined style={{ fontSize: 11 }} />}
                // Mouse-down, not click: blur fires first on click and would
                // close the inline editor before the expand ever ran.
                onMouseDown={(e) => {
                  e.preventDefault();
                  setExpanded(true);
                }}
              />
            </Tooltip>
          </Space>
        }
        maxLength={rules.maxLength}
        onChange={(e) => setVal(e.target.value)}
        onPressEnter={(e) => tryFinish((e.target as HTMLInputElement).value, false)}
        onBlur={(e) => {
          if (expanded) return;
          tryFinish(e.target.value, true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            done.current = true;
            onCancel();
          }
        }}
      />
    </Tooltip>
  );
}

// BigStringEditor is the room a long value needs: a full-width monospace text
// area that wraps, a live character count against any maxLength, the validation
// message in full rather than as a tooltip on a 40px input, and an explicit
// Save. It also shows what will change, because a value long enough to need
// this editor is long enough that "did I edit the right occurrence?" is a real
// question before saving rather than after.
function BigStringEditor({
  initial,
  value,
  onChange,
  rules,
  paramName,
  onCommit,
  onCancel,
}: {
  initial: unknown;
  value: string;
  onChange: (v: string) => void;
  rules: Rules;
  paramName?: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const before = String(initial ?? "");
  const err = validateString(value, rules) ?? validateUnitChange(value, initial, rules.formatType);
  const changed = value !== before;
  return (
    <Modal
      open
      title={paramName ? `Edit ${paramName}` : "Edit value"}
      width={820}
      onCancel={onCancel}
      okText="Save"
      okButtonProps={{ disabled: !!err || !changed }}
      onOk={() => onCommit(value)}
      // The grid underneath keeps its own keyboard handling; a modal that
      // closes on a stray Escape would throw away a long edit.
      maskClosable={false}
    >
      <Input.TextArea
        autoFocus
        className="mono"
        value={value}
        status={err ? "error" : undefined}
        autoSize={{ minRows: 8, maxRows: 20 }}
        maxLength={rules.maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="big-edit-foot">
        <Typography.Text type={err ? "danger" : "secondary"} style={{ fontSize: 12 }}>
          {err ?? `${value.length} characters${rules.maxLength ? ` of ${rules.maxLength}` : ""}`}
        </Typography.Text>
      </div>
      {changed && !err && (
        <div className="big-edit-diff">
          <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: 0.4 }}>
            WHAT YOU CHANGED
          </Typography.Text>
          <ValueDiff before={before} after={value} label={paramName} />
        </div>
      )}
    </Modal>
  );
}

export function EnumEditor({
  initial,
  options,
  onCommit,
  onCancel,
}: {
  initial: unknown;
  options: string[];
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  return (
    <Select
      size="small"
      autoFocus
      defaultOpen
      style={{ width: "100%" }}
      value={String(initial ?? "")}
      options={options.map((o) => ({ value: o, label: o }))}
      onSelect={(v) => onCommit(v)}
      onBlur={onCancel}
    />
  );
}

// ListEditor edits a list-typed cell in a small popover: chips with add /
// remove / reorder-by-retype, explicit Save so partial edits never commit.
export function ListEditor({
  initial,
  rules,
  onCommit,
  onCancel,
}: {
  initial: unknown;
  rules: Rules;
  onCommit: (v: string[]) => void;
  onCancel: () => void;
}) {
  const [items, setItems] = useState<string[]>(
    Array.isArray(initial) ? initial.map(String) : [],
  );
  const tooFew = rules.minItems != null && items.length < rules.minItems;
  const tooMany = rules.maxItems != null && items.length > rules.maxItems;
  // Per-entry format check against the list's element type (list<ipv4>, …):
  // the first bad entry names itself so it is obvious which one to fix.
  const badEntry = rules.formatType
    ? items.map((it) => ({ it, msg: validateTyped(it, rules.formatType) })).find((x) => x.msg)
    : undefined;
  const err = tooFew
    ? `At least ${rules.minItems} entr${rules.minItems === 1 ? "y" : "ies"}`
    : tooMany
      ? `At most ${rules.maxItems} entr${rules.maxItems === 1 ? "y" : "ies"}`
      : badEntry
        ? `"${badEntry.it}": ${badEntry.msg}`
        : null;
  return (
    <Popover
      open
      title="Edit list entries"
      content={
        <div style={{ width: 280, display: "flex", flexDirection: "column", gap: 8 }}>
          <Select
            mode="tags"
            size="small"
            autoFocus
            open={false}
            style={{ width: "100%" }}
            value={items}
            onChange={(v: string[]) => setItems(v)}
            placeholder="Type a value, press Enter to add"
            tokenSeparators={[","]}
            suffixIcon={null}
          />
          <Typography.Text type={err ? "danger" : "secondary"} style={{ fontSize: 11 }}>
            {err ??
              `${items.length} entr${items.length === 1 ? "y" : "ies"}${rules.formatType ? ` · each a ${rules.formatType}` : ", one line/element per entry"}`}
          </Typography.Text>
          <Space>
            <Button size="small" type="primary" disabled={!!err} onClick={() => onCommit(items)}>
              Save
            </Button>
            <Button size="small" onClick={onCancel}>Cancel</Button>
          </Space>
        </div>
      }
    >
      <span className="mono" style={{ opacity: 0.6 }}>editing…</span>
    </Popover>
  );
}
