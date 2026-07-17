import { Tag, Tooltip, Input, InputNumber, Select, Popover, Button, Space, Typography } from "antd";
import { CheckCircleFilled } from "../../icons";
import { useRef, useState } from "react";
import type { Cell, ChangeItem } from "../../api";
import { validateString, fmtValue, type Rules } from "../../rules";

// Cell rendering and the typed inline editors for the parameter grid. Split
// out of ParameterGrid so the grid file stays about layout and data flow.

// Short abbreviations for the layer source badge on each cell, with plain
// explanations surfaced on hover (and in the Legend).
export const scopeAbbrev: Record<string, string> = {
  default: "def",
  base: "base",
  instance: "inst",
};

export const scopeExplain: Record<string, string> = {
  default: "Declared default: applies while no file carries the key",
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
  // No badge for instance values (the norm): a badge marks values inherited
  // from the shared base layer or the declared default.
  if (!cell.set || cell.source === "instance") return null;
  return (
    <Tooltip title={scopeExplain[cell.source]}>
      <span className="source-badge">{scopeAbbrev[cell.source]}</span>
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

export function CellView({ cell, pendingItem }: { cell: Cell; pendingItem?: ChangeItem }) {
  if (cell.state === "na") return <span className="cell-na">n/a</span>;

  // Pending edits: hovering shows exactly what will change.
  const pendingTip = pendingItem
    ? `${fmtValue(pendingItem.old)}  →  ${
        pendingItem.action === "exclude"
          ? "removed from this instance"
          : pendingItem.action === "reset"
            ? "back to inherited"
            : fmtValue(pendingItem.new)
      }   (pending, not yet sent for review)`
    : undefined;

  if (!cell.set) {
    return (
      <Tooltip title={pendingTip ?? "Absent on this instance: no file carries this key here"}>
        <span className={"cell-excluded" + (cell.pending ? " cell-pending" : "")}>∅ absent</span>
      </Tooltip>
    );
  }

  const cls: string[] = [];
  if (cell.state === "deprecated") cls.push("cell-deprecated");
  if (cell.state === "new") cls.push("cell-new");
  if (!cell.valid) cls.push("cell-invalid");
  if (cell.pending) cls.push("cell-pending");

  let display: React.ReactNode;
  if (Array.isArray(cell.value)) {
    display = <ListChips items={cell.value} />;
  } else if (cell.value === undefined || cell.value === null || cell.value === "") {
    display = <span style={{ opacity: 0.3 }}>-</span>;
  } else if (typeof cell.value === "boolean") {
    display = <Tag color={cell.value ? "green" : "default"}>{cell.value ? "on" : "off"}</Tag>;
  } else {
    display = <span className="mono">{String(cell.value)}</span>;
  }

  const inner = (
    <span className={cls.join(" ")}>
      {display}
      <SourceBadge cell={cell} />
    </span>
  );
  const tip = pendingTip ?? (!cell.valid ? cell.message : undefined);
  return tip ? <Tooltip title={tip}>{inner}</Tooltip> : inner;
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
  const [val, setVal] = useState<number | null>(() => {
    const n = Number(initial);
    return Number.isFinite(n) ? n : null;
  });
  const done = useRef(false);
  // Commit whatever is visible in the input (not just React state) so the
  // value the user sees is exactly what is validated and saved.
  const finish = (raw?: string) => {
    if (done.current) return;
    let v = val;
    if (raw != null && raw.trim() !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) v = parsed;
    }
    done.current = true;
    if (v == null) return onCancel();
    if (integer) v = Math.round(v);
    // clamp to the effective min/max so an out-of-range entry cannot commit
    if (rules.min != null && v < rules.min) v = rules.min;
    if (rules.max != null && v > rules.max) v = rules.max;
    if (v === Number(initial)) return onCancel();
    onCommit(v);
  };
  return (
    <InputNumber
      size="small"
      autoFocus
      style={{ width: "100%" }}
      min={rules.min}
      max={rules.max}
      precision={integer ? 0 : undefined}
      value={val}
      onChange={setVal}
      onPressEnter={(e) => finish((e.target as HTMLInputElement).value)}
      onBlur={(e) => finish((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
    />
  );
}

export function StringEditor({
  initial,
  rules,
  onCommit,
  onCancel,
}: {
  initial: unknown;
  rules: Rules;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(String(initial ?? ""));
  const done = useRef(false);
  const err = validateString(val, rules);
  const changed = val !== String(initial ?? "");
  // tryFinish commits when valid+changed; on blur an unchanged or invalid
  // value closes the editor without saving (Enter keeps it open to fix).
  const tryFinish = (raw: string, closing: boolean) => {
    if (done.current) return;
    const isChanged = raw !== String(initial ?? "");
    const invalid = validateString(raw, rules);
    if (isChanged && !invalid) {
      done.current = true;
      onCommit(raw);
    } else if (closing || !isChanged) {
      done.current = true;
      onCancel();
    }
  };
  return (
    <Tooltip open={!!err} title={err} color="#cf1322">
      <Input
        size="small"
        autoFocus
        className="mono"
        value={val}
        status={err ? "error" : undefined}
        suffix={
          changed && !err ? (
            <CheckCircleFilled style={{ color: "#52c41a" }} />
          ) : (
            <span />
          )
        }
        maxLength={rules.maxLength}
        onChange={(e) => setVal(e.target.value)}
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
  const err = tooFew
    ? `At least ${rules.minItems} entr${rules.minItems === 1 ? "y" : "ies"}`
    : tooMany
      ? `At most ${rules.maxItems} entr${rules.maxItems === 1 ? "y" : "ies"}`
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
            {err ?? `${items.length} entr${items.length === 1 ? "y" : "ies"}, one line/element is rendered per entry`}
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
