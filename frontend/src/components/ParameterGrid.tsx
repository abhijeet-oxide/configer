import {
  Table,
  Tag,
  Tooltip,
  Space,
  Button,
  Typography,
  Switch,
  Input,
  InputNumber,
  Select,
  Popover,
  Dropdown,
  Checkbox,
  Segmented,
  Modal,
  App as AntApp,
  theme as antdTheme,
  type GetRef,
} from "antd";
import {
  FilterOutlined,
  SettingOutlined,
  LockOutlined,
  CloseCircleFilled,
  CheckCircleFilled,
  PlusOutlined,
  QuestionCircleOutlined,
  SearchOutlined,
  GlobalOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  UpOutlined,
  DownOutlined,
} from "@ant-design/icons";
import AddParameterModal from "./AddParameterModal";
import SubmitChangesButton from "./SubmitChangesButton";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Cell,
  type ChangeItem,
  type Grid,
  type Instance,
  type Parameter,
  type PresetRule,
  type Row,
} from "../api";
import { effectiveRules, validateString, fmtValue, type Rules } from "../rules";
import { enqueueEdit, OfflineError } from "../offline";
import { useElementSize } from "../hooks";
import { useUI } from "../store";

// Short abbreviations for the scope source badge on each cell, with plain
// explanations surfaced on hover (and in the Legend).
const scopeAbbrev: Record<string, string> = {
  default: "def",
  global: "glb",
  environment: "env",
  site: "site",
  zone: "zone",
  instance: "inst",
};

const scopeExplain: Record<string, string> = {
    default: "Built-in default value: applies unless something more specific is set",
  global: "Set once for ALL instances",
  environment: "Set for every instance in this environment",
  site: "Set for every instance at this site",
  zone: "Set for every instance in this zone",
  instance: "Set specifically on this instance",
};

const envColor: Record<string, string> = {
  production: "#f5222d",
  staging: "#fa8c16",
  development: "#52c41a",
};

// Tag colors for the declared parameter scope column.
const scopeColor: Record<string, string> = {
  global: "purple",
  environment: "blue",
  site: "cyan",
  zone: "geekblue",
  instance: "default",
  default: "default",
};

function SourceBadge({ cell }: { cell: Cell }) {
  // No badge for instance values (the norm) nor for global ones: the Scope
  // column already says "global", repeating it on every cell is noise.
  if (!cell.set || cell.source === "instance" || cell.source === "global") return null;
  return (
    <Tooltip title={scopeExplain[cell.source]}>
      <span className="source-badge">{scopeAbbrev[cell.source]}</span>
    </Tooltip>
  );
}

function ListChips({ items }: { items: unknown[] }) {
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

function CellView({ cell, pendingItem }: { cell: Cell; pendingItem?: ChangeItem }) {
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

  if (cell.excluded) {
    return (
    <Tooltip title={pendingTip ?? "Excluded on this instance: nothing is rendered in its generated files"}>
        <span className={"cell-excluded" + (cell.pending ? " cell-pending" : "")}>∅ excluded</span>
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

function NumberEditor({
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

function StringEditor({
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

function EnumEditor({
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
function ListEditor({
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

function EditableCell({
  cell,
  param,
  instance,
  allInstances,
  presets,
  pendingItem,
  editing,
  onStartEdit,
  onCancel,
  onCommit,
  onAction,
  onCopyTo,
  onUndo,
}: {
  cell: Cell | undefined;
  param: Parameter;
  instance: string;
  allInstances: string[];
  presets?: PresetRule[];
  pendingItem?: ChangeItem;
  editing: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onCommit: (v: unknown) => void;
  onAction: (action: "reset" | "exclude") => void;
  onCopyTo: (target: string) => void;
  onUndo: () => void;
}) {
  if (!cell) return <span style={{ opacity: 0.3 }}>-</span>;
  const rules = effectiveRules(param, presets);

  if (editing) {
    if (param.type === "list") {
      return <ListEditor initial={cell.value} rules={rules} onCommit={onCommit} onCancel={onCancel} />;
    }
    if (param.type === "integer" || param.type === "number") {
      return (
        <NumberEditor
          initial={cell.value}
          rules={rules}
          integer={param.type === "integer"}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      );
    }
    if (param.type === "enum" && rules.enum?.length) {
      return <EnumEditor initial={cell.value} options={rules.enum} onCommit={onCommit} onCancel={onCancel} />;
    }
    return <StringEditor initial={cell.value} rules={rules} onCommit={onCommit} onCancel={onCancel} />;
  }

  // Right-click menu: structural actions beyond plain value edits.
  const menuItems = [
    ...(cell.pending ? [{ key: "undo", label: "Undo pending change" }] : []),
    ...(cell.editable ? [{ key: "edit", label: "Edit value" }] : []),
    ...(cell.editable && cell.source === "instance" && !cell.excluded
      ? [{ key: "reset", label: "Reset to inherited (remove override)" }]
      : []),
    ...(cell.editable && !cell.excluded
      ? [{ key: "exclude", label: "Exclude from this instance (render nothing)" }]
      : []),
    ...(cell.excluded ? [{ key: "reset", label: "Include again (remove exclusion)" }] : []),
    ...(cell.set && !cell.excluded && allInstances.length > 1
      ? [{
          key: "copy",
          label: "Copy value to…",
          children: allInstances
            .filter((n) => n !== instance)
            .map((n) => ({ key: `copy:${n}`, label: n })),
        }]
      : []),
  ];

  const body =
    param.type === "boolean" && cell.editable && !cell.excluded ? (
      <span onClick={(e) => e.stopPropagation()} className={cell.state === "new" ? "cell-new" : undefined}>
        <Switch size="small" checked={!!cell.value} onChange={(v) => onCommit(v)} />
        <SourceBadge cell={cell} />
      </span>
    ) : (
      <div
        style={{ minHeight: 20, cursor: cell.editable ? "text" : undefined }}
        title={cell.editable && !cell.pending ? "Double-click to edit · right-click for actions" : undefined}
        onDoubleClick={cell.editable ? onStartEdit : undefined}
      >
        <CellView cell={cell} pendingItem={pendingItem} />
      </div>
    );

  if (!menuItems.length) return body;
  return (
    <Dropdown
      trigger={["contextMenu"]}
      menu={{
        items: menuItems,
        onClick: ({ key }) => {
          if (key === "undo") onUndo();
          else if (key === "edit") onStartEdit();
          else if (key === "reset") onAction("reset");
          else if (key === "exclude") onAction("exclude");
          else if (key.startsWith("copy:")) onCopyTo(key.slice(5));
        },
      }}
    >
      {body}
    </Dropdown>
  );
}

// --- Search ----------------------------------------------------------------
// Deep match: name, display name, description, category, id, source file/path
// and every instance value. Case-insensitive substring. The scope narrows the
// match to a single facet so a user can, e.g., search only descriptions.
type SearchScope = "all" | "param" | "desc" | "value";

function matchesValue(r: Row, q: string): boolean {
  for (const c of Object.values(r.cells)) {
    if (c.value != null && String(c.value).toLowerCase().includes(q)) return true;
  }
  return false;
}

function rowMatches(r: Row, q: string, scope: SearchScope = "all"): boolean {
  const p = r.param;
  if (scope === "param") {
    return [p.name, p.displayName, p.id].filter(Boolean).join(" ").toLowerCase().includes(q);
  }
  if (scope === "desc") {
    return [p.description, p.displayName].filter(Boolean).join(" ").toLowerCase().includes(q);
  }
  if (scope === "value") return matchesValue(r, q);
  const hay = [p.name, p.displayName, p.description, p.category, p.id, p.source.file, p.source.path]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q) || matchesValue(r, q);
}

// hl wraps every case-insensitive occurrence of q in text with a highlight mark,
// so the user sees exactly where a search matched.
function hl(text: string | undefined, q: string): React.ReactNode {
  if (!text) return text ?? null;
  if (!q) return text;
  const lower = text.toLowerCase();
  if (!lower.includes(q)) return text;
  const parts: React.ReactNode[] = [];
  let idx = 0;
  let k = 0;
  for (;;) {
    const j = lower.indexOf(q, idx);
    if (j < 0) {
      parts.push(text.slice(idx));
      break;
    }
    if (j > idx) parts.push(text.slice(idx, j));
    parts.push(
      <mark key={k++} style={{ background: "rgba(250,204,21,0.5)", color: "inherit", padding: "0 1px", borderRadius: 2 }}>
        {text.slice(j, j + q.length)}
      </mark>,
    );
    idx = j + q.length;
  }
  return <>{parts}</>;
}

function instanceHeader(inst: Instance) {
  return (
    <div style={{ lineHeight: 1.25 }}>
      <Space size={5}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            display: "inline-block",
            background: envColor[inst.environment ?? ""] ?? "#8c8c8c",
          }}
        />
        <span>{inst.name}</span>
      </Space>
      <div style={{ fontSize: 10, fontWeight: 400, opacity: 0.65 }}>
        {inst.softwareVersion}
        {inst.region ? ` · ${inst.region}` : ""}
      </div>
    </div>
  );
}

export default function ParameterGrid({ grid }: { grid: Grid }) {
  const { categoryKey, selectedParamId, selectParam, selectedInstance, selectInstance, search, setSearch, filters, setFilters, prefs, setPrefs, jump, setJump, editorFocus, setEditorFocus } =
    useUI();
  const { message } = AntApp.useApp();
  const { token } = antdTheme.useToken();
  const qc = useQueryClient();
  const presetsQ = useQuery({ queryKey: ["presets"], queryFn: api.presets });
  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft });
  // key: `${paramId}|${instance}` of the cell currently in edit mode
  const [editing, setEditing] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // in-view search (the toolbar box), ANDed with the global ⌘K search
  const [localQ, setLocalQ] = useState("");
  // which facet the search box narrows to (all / parameter / description / value)
  const [searchScope, setSearchScope] = useState<SearchScope>("all");
  // match navigation cursor (next/prev through the matching rows)
  const [matchCursor, setMatchCursor] = useState(0);
  // pending "this is a global setting" question for a just-committed value
  const [globalAsk, setGlobalAsk] = useState<{ param: Parameter; instance: string; value: unknown } | null>(null);
  // one-shot flash highlight after a jump from the left-hand trees
  const [flash, setFlash] = useState<{ kind: "param" | "instance"; id: string } | null>(null);
  const tableRef = useRef<GetRef<typeof Table>>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // pending draft items indexed by cell, for hover before→after and undo;
  // a global item is stored under `${paramId}|` (empty instance)
  const pendingMap = useMemo(() => {
    const m = new Map<string, ChangeItem>();
    for (const it of draftQ.data?.draft?.items ?? []) {
      m.set(`${it.paramId}|${it.instance}`, it);
    }
    return m;
  }, [draftQ.data]);

  const revert = useMutation({
    mutationFn: (p: { paramId: string; instance: string }) => api.revertValue(p.paramId, p.instance),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
      qc.invalidateQueries({ queryKey: ["render"] });
    },
  });
  // body: the area the virtualized table body may occupy (auto-fits height/width)
  const { ref: bodyRef, width: bodyW, height: bodyH } = useElementSize<HTMLDivElement>();

  const save = useMutation({
    mutationFn: (p: { instance: string; paramId: string; value?: unknown; action?: "set" | "reset" | "exclude"; scope?: "global" }) =>
      api.setValue(p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
      qc.invalidateQueries({ queryKey: ["render"] });
    },
    onError: (e: Error, vars) => {
      if (e instanceof OfflineError) {
        // Service unreachable: keep the edit on this device; it syncs
        // automatically when the connection returns.
        enqueueEdit(vars);
        message.info("Saved on this device; it will sync when the service is reachable again.");
        return;
      }
      message.error(`Rejected: ${e.message}`);
    },
  });

  const q = search.trim().toLowerCase();
  const lq = localQ.trim().toLowerCase();
  const rows = useMemo(() => {
    return grid.rows.filter((r) => {
      if (categoryKey && r.param.category !== categoryKey && !r.param.category.startsWith(categoryKey + "/"))
        return false;
      if (q && !rowMatches(r, q, searchScope)) return false;
      if (lq && !rowMatches(r, lq, searchScope)) return false;
      const cells = Object.values(r.cells);
      if (filters.invalidOnly && !cells.some((c) => !c.valid)) return false;
      if (filters.overriddenOnly && !cells.some((c) => c.set && c.source === "instance")) return false;
      if (filters.hideNA && cells.every((c) => c.state === "na")) return false;
      return true;
    });
  }, [grid.rows, categoryKey, q, lq, filters, searchScope]);

  // Auto-fit: each instance column gets at least what its longest visible
  // value needs (so "staging.example.internal" never truncates), and any
  // remaining container width is distributed evenly so wide screens fill up.
  // Metadata columns are kept tight so the instance columns (the point of the
  // grid) get the width budget. Type/Scope hold short tags; Description is a
  // supporting hint (the full text is always in the details panel), so it stays
  // narrow and truncates.
  const PARAM_W = 206;
  const TYPE_W = prefs.showTypeCol ? 82 : 0; // fits "Type" + sort/filter icons
  const SCOPE_W = prefs.showScopeCol ? 96 : 0; // fits "Scope" + sort/filter icons
  const DESC_W = prefs.showDescCol ? 140 : 0;
  const instWidths = useMemo(() => {
    const px = (s: string) => Math.round(s.length * 7.4) + 46; // approx mono glyphs + padding/badge
    const need: Record<string, number> = {};
    // Size from ALL rows, not the filtered set, so column widths are stable:
    // searching or filtering never re-lays-out the columns (which used to drift
    // the header out of alignment with the body in the virtual table).
    for (const inst of grid.instances) {
      let w = px(inst.name) + 16; // header text + env dot
      for (const r of grid.rows) {
        const c = r.cells[inst.name];
        if (!c || c.value == null || Array.isArray(c.value)) continue;
        const s = String(c.value);
        if (s) w = Math.max(w, px(s));
      }
      need[inst.name] = Math.min(Math.max(w, 130), 360);
    }
    const fixed = PARAM_W + TYPE_W + SCOPE_W + DESC_W;
    const sum = Object.values(need).reduce((a, b) => a + b, 0);
    const extra = bodyW - fixed - sum;
    if (extra > 0 && grid.instances.length > 0) {
      const per = Math.floor(extra / grid.instances.length);
      for (const k of Object.keys(need)) need[k] += per;
    }
    return need;
  }, [grid.instances, grid.rows, bodyW, TYPE_W, SCOPE_W, DESC_W]);

  // routeCommit: a value for a global-scope parameter that is still fed by
  // the global/default chain asks the user what they mean before staging.
  const routeCommit = (param: Parameter, instName: string, cell: Cell | undefined, value: unknown) => {
    if (
      param.scope === "global" &&
      cell &&
      !cell.excluded &&
      (cell.source === "global" || cell.source === "default")
    ) {
      setGlobalAsk({ param, instance: instName, value });
      return;
    }
    save.mutate({ instance: instName, paramId: param.id, value });
  };

  // Jump requests from the left-hand trees: scroll to the row / column and
  // flash it. Consumed once per request (jump.n), retried when rows update
  // (e.g. the category filter changed in the same click).
  const consumedJump = useRef(0);
  useEffect(() => {
    if (!jump || consumedJump.current === jump.n) return;
    if (jump.kind === "param") {
      const idx = rows.findIndex((r) => r.param.id === jump.id);
      if (idx < 0) return; // rows not filtered to it yet; retry on next update
      consumedJump.current = jump.n;
      tableRef.current?.scrollTo({ index: Math.max(idx - 2, 0) });
      selectParam(jump.id);
    } else {
      consumedJump.current = jump.n;
      let left = 0;
      for (const inst of grid.instances) {
        if (inst.name === jump.id) break;
        left += instWidths[inst.name] ?? 150;
      }
      // antd's virtual table scrolls horizontally via wheel deltas (the body is
      // transform-positioned, so setting scrollLeft does nothing and desyncs the
      // header). Dispatching a wheel with the right deltaX moves the body AND
      // keeps the sticky header aligned. The header's scrollLeft mirrors the
      // current horizontal position, so we delta from there to the target.
      const root = rootRef.current;
      const target = Math.max(left - 40, 0);
      if (root) {
        const holder = root.querySelector<HTMLElement>(".ant-table-tbody-virtual-holder");
        const header = root.querySelector<HTMLElement>(".ant-table-header");
        if (holder && header) {
          const delta = target - header.scrollLeft;
          if (delta !== 0) {
            holder.dispatchEvent(new WheelEvent("wheel", { deltaX: delta, bubbles: true, cancelable: true }));
          }
        }
      }
    }
    setFlash({ kind: jump.kind, id: jump.id });
    const t = setTimeout(() => setFlash(null), 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, rows]);

  // Active highlight term (in-grid box wins over the global search), gated by
  // the search scope so, e.g., a description-scoped search never lights up the
  // parameter name column.
  const hlq = lq || q;
  const hlParam = searchScope === "all" || searchScope === "param" ? hlq : "";
  const hlDesc = searchScope === "all" || searchScope === "desc" ? hlq : "";

  const columns: ColumnsType<Row> = useMemo(() => {
    const types = [...new Set(grid.rows.map((r) => r.param.type))].sort();
    const scopes = [...new Set(grid.rows.map((r) => r.param.scope))].sort();
    const base: ColumnsType<Row> = [
      {
        title: "Parameter",
        dataIndex: ["param", "name"],
        key: "param",
        fixed: "left",
        width: PARAM_W,
        sorter: (a, b) => a.param.name.localeCompare(b.param.name),
        render: (_v, r) => (
          <Space size={4}>
            {r.param.secret && <LockOutlined style={{ color: "#faad14" }} />}
            <span>{hl(r.param.name, hlParam)}</span>
            {!r.param.source.file && (
              <Tooltip title="Design phase: not attached to a configuration file yet. Values work as usual and start rendering once attached (details panel).">
                <Tag color="purple" style={{ fontSize: 10, lineHeight: "16px", marginInlineStart: 2 }}>
                  design
                </Tag>
              </Tooltip>
            )}
          </Space>
        ),
      },
    ];
    if (prefs.showTypeCol) {
      base.push({
        title: "Type",
        key: "type",
        width: TYPE_W,
        sorter: (a, b) => a.param.type.localeCompare(b.param.type),
        filters: types.map((t) => ({ text: t, value: t })),
        onFilter: (v, r) => r.param.type === v,
        render: (_v, r) => <Tag>{r.param.type}</Tag>,
      });
    }
    if (prefs.showScopeCol) {
      base.push({
        title: "Scope",
        key: "scope",
        width: SCOPE_W,
        sorter: (a, b) => a.param.scope.localeCompare(b.param.scope),
        filters: scopes.map((s) => ({ text: s, value: s })),
        onFilter: (v, r) => r.param.scope === v,
        render: (_v, r) => (
          <Tooltip title={scopeExplain[r.param.scope]}>
            <Tag color={scopeColor[r.param.scope]} style={{ marginInlineEnd: 0 }}>
              {r.param.scope === "global" && <GlobalOutlined style={{ marginInlineEnd: 4 }} />}
              {r.param.scope}
            </Tag>
          </Tooltip>
        ),
      });
    }
    if (prefs.showDescCol) {
      base.push({
        title: "Description",
        key: "desc",
        width: DESC_W,
        ellipsis: true,
        render: (_v, r) => (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {hl(r.param.displayName || r.param.description, hlDesc)}
          </Typography.Text>
        ),
      });
    }
    const instanceNames = grid.instances.map((i) => i.name);
    const instCols: ColumnsType<Row> = grid.instances.map((inst) => ({
      title: instanceHeader(inst),
      key: inst.name,
      width: instWidths[inst.name] ?? 150,
      // Excel-like value filter per instance column: distinct effective
      // values, searchable when long.
      filters: [...new Set(grid.rows.map((r) => fmtValue(r.cells[inst.name]?.value)))]
        .sort()
        .slice(0, 60)
        .map((v) => ({ text: v === "" ? "(empty)" : v, value: v })),
      filterSearch: true,
      onFilter: (v, r) => fmtValue(r.cells[inst.name]?.value) === v,
      // Clicking a header (or a system in the left tree) highlights the
      // whole column; clicking it again clears the highlight.
      onHeaderCell: () => ({
        className:
          (inst.environment ? `th-env-${inst.environment}` : "") +
          (flash?.kind === "instance" && flash.id === inst.name ? " th-flash" : "") +
          (selectedInstance === inst.name ? " col-selected-h" : ""),
        onClick: () => selectInstance(selectedInstance === inst.name ? null : inst.name),
        style: { cursor: "pointer" },
      }),
      onCell: () => ({
        className: selectedInstance === inst.name ? "col-selected" : "",
      }),
      render: (_v, r) => {
        const key = `${r.param.id}|${inst.name}`;
        const cell = r.cells[inst.name];
        // a pending global edit surfaces on every cell it would affect
        const pendingItem =
          pendingMap.get(key) ??
          (cell && (cell.source === "global" || cell.source === "default")
            ? pendingMap.get(`${r.param.id}|`)
            : undefined);
        return (
          <EditableCell
            cell={cell}
            param={r.param}
            instance={inst.name}
            allInstances={instanceNames}
            presets={presetsQ.data}
            pendingItem={pendingItem}
            editing={editing === key}
            onStartEdit={() => setEditing(key)}
            onCancel={() => setEditing(null)}
            onCommit={(value) => {
              setEditing(null);
              routeCommit(r.param, inst.name, cell, value);
            }}
            onAction={(action) =>
              save.mutate({ instance: inst.name, paramId: r.param.id, action })
            }
            onCopyTo={(target) =>
              save.mutate({ instance: target, paramId: r.param.id, value: cell?.value })
            }
            onUndo={() =>
              revert.mutate({
                paramId: r.param.id,
                instance: pendingItem?.scope === "global" ? "" : inst.name,
              })
            }
          />
        );
      },
    }));
    return [...base, ...instCols];
    // save.mutate/revert.mutate/setEditing are stable; the rest drive re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.instances, grid.rows, editing, presetsQ.data, pendingMap, prefs.showTypeCol, prefs.showScopeCol, prefs.showDescCol, instWidths, flash, selectedInstance, hlParam, hlDesc]);

  const scrollX =
    PARAM_W + TYPE_W + SCOPE_W + DESC_W +
    grid.instances.reduce((a, i) => a + (instWidths[i.name] ?? 150), 0);
  const headerH = prefs.density === "compact" ? 55 : 63;
  const title = categoryKey ? categoryKey.split("/").pop() : "All Parameters";
  const activeFilters = Number(filters.invalidOnly) + Number(filters.overriddenOnly) + Number(filters.hideNA);

  // The editor stays editing-focused: the table fills the available height.
  // Category inventory lives in the Overview dashboard, not here.
  const availH = Math.max(bodyH - headerH, 120);
  const tableY = availH;

  // Step through the matching rows, selecting and scrolling to each.
  const gotoMatch = (delta: number) => {
    if (rows.length === 0) return;
    const next = (((matchCursor + delta) % rows.length) + rows.length) % rows.length;
    setMatchCursor(next);
    const r = rows[next];
    selectParam(r.param.id);
    setJump("param", r.param.id);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, rowGap: 8, padding: "6px 12px", flexWrap: "wrap" }}>
        {/* The search grows to fill the row so the toolbar reads as one balanced
            band: scope + search on the left, actions on the right. The live
            parameter count sits quietly inside the field (as a suffix) instead
            of a floating tag. */}
        <div style={{ display: "flex", flex: "1 1 300px", minWidth: 150, maxWidth: 820, alignItems: "center", gap: 8 }}>
          <Space.Compact size="small" style={{ width: "100%" }}>
            <Select
              size="small"
              value={searchScope}
              onChange={(v) => setSearchScope(v)}
              style={{ width: 90, flexShrink: 0 }}
              title="Search in"
              options={[
                { value: "all", label: "All" },
                { value: "param", label: "Name" },
                { value: "desc", label: "Desc" },
                { value: "value", label: "Value" },
              ]}
            />
            <Input
              size="small"
              allowClear
              prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
              suffix={!localQ && !hlq ? <span style={{ fontSize: 11, opacity: 0.4 }} title={`${rows.length} parameters`}>{rows.length}</span> : undefined}
              placeholder={categoryKey ? `Search in ${title}…` : "Search parameters…"}
              value={localQ}
              onChange={(e) => setLocalQ(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
          </Space.Compact>
          {hlq && (
            <Space size={2} style={{ flexShrink: 0 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {rows.length} match{rows.length === 1 ? "" : "es"}
              </Typography.Text>
              <Tooltip title="Previous match">
                <Button size="small" type="text" icon={<UpOutlined />} disabled={!rows.length} onClick={() => gotoMatch(-1)} />
              </Tooltip>
              <Tooltip title="Next match">
                <Button size="small" type="text" icon={<DownOutlined />} disabled={!rows.length} onClick={() => gotoMatch(1)} />
              </Tooltip>
            </Space>
          )}
        </div>
        {q && (
          <Tag color="blue" closable closeIcon={<CloseCircleFilled />} onClose={() => setSearch("")}>
            ⌘K: “{search.trim()}”
          </Tag>
        )}
        {/* All grid actions live in one right-aligned cluster. marginLeft:auto
            keeps it flush-right whether it shares the first row or wraps to a
            second one, so the toolbar is never two half-empty bars. */}
        <Space size={4} style={{ marginLeft: "auto", flexShrink: 0 }}>
          <Popover
            trigger="click"
            placement="bottomRight"
            title="What do the marks mean?"
            content={
              <div style={{ display: "flex", flexDirection: "column", gap: 7, width: 300, fontSize: 12 }}>
                <span><span className="cell-pending mono">10.0.0.1</span>: your pending change (hover it to see before → after)</span>
                <span><span className="cell-new mono">1.2</span>: newly introduced in this software version</span>
                <span><span className="cell-deprecated mono">off</span>: deprecated; no longer editable</span>
                <span><span className="cell-invalid mono">99999</span>: value breaks a rule (hover for why)</span>
                <span><span className="cell-excluded">∅ excluded</span>: removed from this instance's files entirely</span>
                <span><span className="cell-na">n/a</span>: doesn't exist in this software version yet</span>
                <span>
                  <span className="source-badge">glb</span> where a value comes from:{" "}
                  glb = all instances · env = environment · zone/site = that area · def = built-in default
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  Everything you edit is saved to Git and only goes live after approval.
                </Typography.Text>
              </div>
            }
          >
            <Button size="small" type="text" icon={<QuestionCircleOutlined />} aria-label="Legend" title="Legend: what the cell marks mean" />
          </Popover>
          <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
            Add Parameter
          </Button>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "invalidOnly", label: <Checkbox checked={filters.invalidOnly}>Only invalid</Checkbox> },
                { key: "overriddenOnly", label: <Checkbox checked={filters.overriddenOnly}>Only instance overrides</Checkbox> },
                { key: "hideNA", label: <Checkbox checked={filters.hideNA}>Hide fully n/a rows</Checkbox> },
              ],
              onClick: ({ key }) =>
                setFilters({ [key]: !filters[key as keyof typeof filters] } as Partial<typeof filters>),
            }}
          >
            <Button size="small" icon={<FilterOutlined />} aria-label="Filter" title="Filter rows">
              {activeFilters ? activeFilters : ""}
            </Button>
          </Dropdown>
          <Popover
            trigger="click"
            placement="bottomRight"
            content={
              <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 210 }}>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>DENSITY</Typography.Text>
                <Segmented
                  size="small"
                  block
                  value={prefs.density}
                  options={[
                    { value: "compact", label: "Compact" },
                    { value: "comfortable", label: "Comfortable" },
                  ]}
                  onChange={(v) => setPrefs({ density: v as "compact" | "comfortable" })}
                />
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>COLUMNS</Typography.Text>
                <Checkbox checked={prefs.showTypeCol} onChange={(e) => setPrefs({ showTypeCol: e.target.checked })}>
                  Type
                </Checkbox>
                <Checkbox checked={prefs.showScopeCol} onChange={(e) => setPrefs({ showScopeCol: e.target.checked })}>
                  Scope
                </Checkbox>
                <Checkbox checked={prefs.showDescCol} onChange={(e) => setPrefs({ showDescCol: e.target.checked })}>
                  Description
                </Checkbox>
              </div>
            }
          >
            <Button size="small" icon={<SettingOutlined />} aria-label="View options" title="View: density & columns" />
          </Popover>
          <Tooltip title={editorFocus ? "Exit focus mode (Esc)" : "Focus mode: maximize the editor"}>
            <Button
              size="small"
              type={editorFocus ? "primary" : "default"}
              ghost={editorFocus}
              icon={editorFocus ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={() => setEditorFocus(!editorFocus)}
            />
          </Tooltip>
          <SubmitChangesButton instances={grid.instances} />
        </Space>
      </div>
      <AddParameterModal open={addOpen} onClose={() => setAddOpen(false)} grid={grid} />
      <GlobalPrompt
        ask={globalAsk}
        instanceCount={grid.instances.length}
        onClose={() => setGlobalAsk(null)}
        onEveryone={() => {
          if (globalAsk) save.mutate({ instance: "", paramId: globalAsk.param.id, value: globalAsk.value, scope: "global" });
          setGlobalAsk(null);
        }}
        onJustThis={() => {
          if (globalAsk) {
            const { param, instance, value } = globalAsk;
            save.mutate({ instance, paramId: param.id, value });
            // The parameter is no longer managed as one shared value, so its
            // declared scope follows: global -> instance (attributed commit).
            api
              .updateParameter(param.id, { scope: "instance", author: "demo-user" })
              .then(() => {
                message.info(`${param.name} is now scoped per instance; other systems keep the previous shared value.`, 5);
                qc.invalidateQueries();
              })
              .catch((e: Error) => message.error(e.message));
          }
          setGlobalAsk(null);
        }}
      />
      <div
        ref={rootRef}
        style={{ display: "contents", "--grid-bg": token.colorBgContainer } as React.CSSProperties}
      >
      <div ref={bodyRef} style={{ flex: 1, overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Table<Row>
          ref={tableRef}
          className="param-grid"
          rowKey={(r) => r.param.id}
          columns={columns}
          dataSource={rows}
          size={prefs.density === "compact" ? "small" : "middle"}
          virtual
          scroll={{ x: scrollX, y: tableY }}
          pagination={false}
          rowClassName={(r) =>
            (flash?.kind === "param" && flash.id === r.param.id ? "row-flash " : "") +
            (r.param.id === selectedParamId ? "row-selected" : "")
          }
          onRow={(r) => ({
            onClick: () => selectParam(r.param.id),
            style: { cursor: "pointer" },
          })}
        />
      </div>
      </div>
    </div>
  );
}

// GlobalPrompt asks what a new value for a global-scope parameter means:
// change it for every instance (stays global), override only the edited
// instance (scope narrows for that one), or cancel.
function GlobalPrompt({
  ask,
  instanceCount,
  onClose,
  onEveryone,
  onJustThis,
}: {
  ask: { param: Parameter; instance: string; value: unknown } | null;
  instanceCount: number;
  onClose: () => void;
  onEveryone: () => void;
  onJustThis: () => void;
}) {
  return (
    <Modal
      open={!!ask}
      onCancel={onClose}
      title={
        <Space>
          <GlobalOutlined style={{ color: "#722ed1" }} />
          You are changing a global value
        </Space>
      }
      footer={[
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        <Button key="one" onClick={onJustThis}>
          Only for {ask?.instance}
        </Button>,
        <Button key="all" type="primary" onClick={onEveryone}>
          Change it for everyone
        </Button>,
      ]}
    >
      {ask && (
        <>
          <Typography.Paragraph style={{ marginBottom: 8 }}>
            <b className="mono">{ask.param.name}</b> is a <Tag color="purple" style={{ marginInlineEnd: 0 }}>global</Tag>{" "}
            setting: all {instanceCount} systems currently share one value.
          </Typography.Paragraph>
          <Typography.Paragraph style={{ marginBottom: 8 }}>
            New value: <span className="mono" style={{ color: "#389e0d" }}>{fmtValue(ask.value)}</span>
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            "Change it for everyone" updates the shared global value. "Only for {ask.instance}" sets an
            override on that system alone and changes the parameter's scope from global to instance;
            the others keep the previous shared value. Value changes are staged for review first,
            nothing goes live yet.
          </Typography.Paragraph>
        </>
      )}
    </Modal>
  );
}
