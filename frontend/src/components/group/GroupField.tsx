import { Input, InputNumber, Select, Switch, Tooltip, Typography } from "antd";
import { memo } from "react";
import { LockOutlined } from "../../icons";
import type { Parameter } from "../../api";
import {
  validateNumber,
  validateString,
  validateTyped,
  validateUnitChange,
  type Rules,
} from "../../rules";

// One form field in the group editor.
//
// This is deliberately NOT the grid's cell editor. A cell editor opens on a
// click, commits on Enter or blur and vanishes: it is a keystroke in a
// spreadsheet. A form field is visible the whole time, holds what was typed
// while somebody fills in the field below it, and commits when the form is
// saved. Sharing one component between the two would mean one of them behaved
// like the other, and both behaviours are right where they are.
//
// What IS shared is the rules: every message here comes from rules.ts, the same
// mirror of the backend's validation the grid uses, so a value refused in the
// form is refused in the same words in the grid and by the server.

/** Why a field cannot be edited, or null when it can. */
export function lockedReason(
  param: Parameter,
  cell: { editable?: boolean; templated?: boolean; state?: string } | undefined,
  canEdit: boolean,
): string | null {
  if (!canEdit) return "You have read access to this application";
  if (param.validation?.readOnly) return "The model reports this value rather than taking it";
  if (cell?.templated) return "This value is a template, computed when the chart renders - edit it in Files";
  if (cell?.state === "na") return "Not introduced at this instance's software version";
  if (cell?.state === "deprecated") return "Deprecated at this instance's software version";
  if (cell && cell.editable === false) return "This value cannot be edited here";
  return null;
}

/** The message a value earns, or null when it is fine. `committed` is the value
 *  on disk, which is the only thing that can say a CPU or memory unit went
 *  missing - a thousand-fold change wearing the clothes of a small one. */
export function fieldError(
  param: Parameter,
  rules: Rules,
  value: unknown,
  committed: unknown,
): string | null {
  if (value === undefined) return null;
  if (param.type === "boolean") return null;
  if (param.type === "list") {
    const items = Array.isArray(value) ? value.map(String) : [];
    if (rules.minItems != null && items.length < rules.minItems)
      return `At least ${rules.minItems} entr${rules.minItems === 1 ? "y" : "ies"}`;
    if (rules.maxItems != null && items.length > rules.maxItems)
      return `At most ${rules.maxItems} entr${rules.maxItems === 1 ? "y" : "ies"}`;
    for (const it of items) {
      const msg = validateTyped(it, rules.formatType);
      if (msg) return `"${it}": ${msg}`;
    }
    return null;
  }
  const s = value === null || value === undefined ? "" : String(value);
  if (rules.required && s.trim() === "") return "This value is required";
  if (param.type === "integer" || param.type === "number") {
    return validateNumber(s, rules, param.type === "integer");
  }
  return validateString(s, rules) ?? validateUnitChange(s, committed, rules.formatType);
}

/** Long enough that a one-line input is the wrong room for it. Mirrors the
 *  grid's own threshold. */
const BIG = 60;

function GroupField({
  param,
  rules,
  value,
  committed,
  placeholder,
  locked,
  status,
  fieldKey,
  onChange: onChangeRaw,
}: {
  param: Parameter;
  rules: Rules;
  /** what is in the field now: the edited value, or `committed` untouched */
  value: unknown;
  /** the value on disk, for the unit check and for "what am I changing from" */
  committed: unknown;
  /** shown instead of a value when the selected instances disagree */
  placeholder?: string;
  /** why it is read-only, or null */
  locked: string | null;
  /** "error" paints the field when the server refused this exact edit */
  status?: "" | "error";
  /** which field this is, handed back on change. It travels in the callback so
   *  the parent can keep ONE stable handler for every field - an arrow created
   *  per field per render defeats the memo below, and on a form of hundreds
   *  that is every field re-rendering on every keystroke. */
  fieldKey: string;
  onChange: (key: string, v: unknown) => void;
}) {
  const onChange = (v: unknown) => onChangeRaw(fieldKey, v);
  const err = fieldError(param, rules, value, committed);
  const common = {
    size: "small" as const,
    disabled: !!locked,
    status: (err || status ? "error" : "") as "" | "error",
    style: { width: "100%" },
  };

  const field = (() => {
    if (param.type === "boolean") {
      return (
        <Switch
          size="small"
          disabled={!!locked}
          checked={value === true || value === "true"}
          onChange={(v) => onChange(v)}
        />
      );
    }
    if (param.type === "enum" || (rules.enum && rules.enum.length > 0)) {
      return (
        <Select
          {...common}
          showSearch
          allowClear
          placeholder={placeholder}
          value={value === undefined || value === null || value === "" ? undefined : String(value)}
          options={(rules.enum ?? []).map((o) => ({ value: o, label: o }))}
          onChange={(v) => onChange(v ?? "")}
        />
      );
    }
    if (param.type === "list") {
      return (
        <Select
          {...common}
          mode="tags"
          allowClear
          // No dropdown to choose from: a list is whatever the reader types,
          // one entry at a time, and an empty menu hanging under the field is
          // an invitation to nothing.
          open={false}
          suffixIcon={null}
          placeholder={placeholder ?? "Type an entry and press Enter"}
          value={Array.isArray(value) ? value.map(String) : []}
          onChange={(v) => onChange(v)}
        />
      );
    }
    if (param.type === "integer" || param.type === "number") {
      return (
        <InputNumber
          {...common}
          placeholder={placeholder}
          min={rules.min}
          max={rules.max}
          step={param.type === "integer" ? 1 : undefined}
          value={value === undefined || value === null || value === "" ? null : Number(value)}
          onChange={(v) => onChange(v)}
        />
      );
    }
    const text = value === undefined || value === null ? "" : String(value);
    if (text.length > BIG) {
      return (
        <Input.TextArea
          {...common}
          autoSize={{ minRows: 2, maxRows: 8 }}
          placeholder={placeholder}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    return (
      <Input
        {...common}
        placeholder={placeholder}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  })();

  return (
    <div>
      {locked ? (
        <Tooltip title={locked}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <LockOutlined style={{ opacity: 0.45, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>{field}</div>
          </div>
        </Tooltip>
      ) : (
        field
      )}
      {err && (
        <Typography.Text type="danger" style={{ fontSize: 11, display: "block", marginTop: 2 }}>
          {err}
        </Typography.Text>
      )}
    </div>
  );
}

// Only the field whose value moved re-renders. Every prop above is either a
// primitive or an object the parent memoizes, so the comparison is honest -
// which is what lets a form of seven hundred fields stay typeable.
export default memo(GroupField);
