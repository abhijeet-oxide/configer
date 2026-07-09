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
  App as AntApp,
} from "antd";
import {
  FilterOutlined,
  SettingOutlined,
  LockOutlined,
  CloseCircleFilled,
  CheckCircleFilled,
  PlusOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons";
import AddParameterModal from "./AddParameterModal";
import type { ColumnsType } from "antd/es/table";
import { useMemo, useState } from "react";
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
  default: "Built-in default value — applies unless something more specific is set",
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

function SourceBadge({ cell }: { cell: Cell }) {
  if (!cell.set || cell.source === "instance") return null;
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
      }   (pending — not yet sent for review)`
    : undefined;

  if (cell.excluded) {
    return (
      <Tooltip title={pendingTip ?? "Excluded on this instance — nothing is rendered in its generated files"}>
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
    display = <span style={{ opacity: 0.3 }}>—</span>;
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
// Each editor constrains input to the parameter's declared type and effective
// validation rules; commits happen on Enter (or toggle), Escape/blur cancels.

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
  // Commit whatever is visible in the input (not just React state) so the
  // value the user sees is exactly what is validated and saved.
  const commit = (raw?: string) => {
    let v = val;
    if (raw != null && raw.trim() !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) v = parsed;
    }
    if (v == null) return onCancel();
    if (integer) v = Math.round(v);
    // clamp to the effective min/max so an out-of-range entry cannot commit
    if (rules.min != null && v < rules.min) v = rules.min;
    if (rules.max != null && v > rules.max) v = rules.max;
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
      onPressEnter={(e) => commit((e.target as HTMLInputElement).value)}
      onBlur={onCancel}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
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
  const err = validateString(val, rules);
  const changed = val !== String(initial ?? "");
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
        onPressEnter={(e) => {
          // validate the actual input content at commit time
          const raw = (e.target as HTMLInputElement).value;
          if (!validateString(raw, rules)) onCommit(raw);
        }}
        onBlur={onCancel}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
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
            {err ?? `${items.length} entr${items.length === 1 ? "y" : "ies"} — one line/element is rendered per entry`}
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
  if (!cell) return <span style={{ opacity: 0.3 }}>—</span>;
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
// and every instance value. Case-insensitive substring.
function rowMatches(r: Row, q: string): boolean {
  const p = r.param;
  const hay = [p.name, p.displayName, p.description, p.category, p.id, p.source.file, p.source.path]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (hay.includes(q)) return true;
  for (const c of Object.values(r.cells)) {
    if (c.value != null && String(c.value).toLowerCase().includes(q)) return true;
  }
  return false;
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
  const { categoryKey, selectedParamId, selectParam, search, setSearch, filters, setFilters, prefs, setPrefs } =
    useUI();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const presetsQ = useQuery({ queryKey: ["presets"], queryFn: api.presets });
  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft });
  // key: `${paramId}|${instance}` of the cell currently in edit mode
  const [editing, setEditing] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // pending draft items indexed by cell, for hover before→after and undo
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
    },
  });
  // body: the area the virtualized table body may occupy (auto-fits height/width)
  const { ref: bodyRef, width: bodyW, height: bodyH } = useElementSize<HTMLDivElement>();

  const save = useMutation({
    mutationFn: (p: { instance: string; paramId: string; value?: unknown; action?: "set" | "reset" | "exclude" }) =>
      api.setValue(p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
    },
    onError: (e: Error) => message.error(`Rejected: ${e.message}`),
  });

  const q = search.trim().toLowerCase();
  const rows = useMemo(() => {
    return grid.rows.filter((r) => {
      if (categoryKey && r.param.category !== categoryKey && !r.param.category.startsWith(categoryKey + "/"))
        return false;
      if (q && !rowMatches(r, q)) return false;
      const cells = Object.values(r.cells);
      if (filters.invalidOnly && !cells.some((c) => !c.valid)) return false;
      if (filters.overriddenOnly && !cells.some((c) => c.set && c.source === "instance")) return false;
      if (filters.hideNA && cells.every((c) => c.state === "na")) return false;
      return true;
    });
  }, [grid.rows, categoryKey, q, filters]);

  // Auto-fit: distribute the actual container width across columns (with
  // sensible minimums) instead of hardcoding a total; the virtual table keeps
  // memory flat regardless of column/row count.
  const PARAM_W = 230;
  const TYPE_W = prefs.showTypeCol ? 88 : 0;
  const DESC_W = prefs.showDescCol ? 180 : 0;
  const instW = useMemo(() => {
    const n = Math.max(grid.instances.length, 1);
    const avail = bodyW - PARAM_W - TYPE_W - DESC_W;
    return Math.max(150, Math.floor(avail / n) - 1);
  }, [bodyW, grid.instances.length, TYPE_W, DESC_W]);

  const columns: ColumnsType<Row> = useMemo(() => {
    const base: ColumnsType<Row> = [
      {
        title: "Parameter",
        dataIndex: ["param", "name"],
        key: "param",
        fixed: "left",
        width: PARAM_W,
        render: (_v, r) => (
          <Space size={4}>
            {r.param.secret && <LockOutlined style={{ color: "#faad14" }} />}
            <span>{r.param.name}</span>
          </Space>
        ),
      },
    ];
    if (prefs.showTypeCol) {
      base.push({
        title: "Type",
        key: "type",
        width: TYPE_W,
        render: (_v, r) => <Tag>{r.param.type}</Tag>,
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
            {r.param.displayName || r.param.description}
          </Typography.Text>
        ),
      });
    }
    const instanceNames = grid.instances.map((i) => i.name);
    const instCols: ColumnsType<Row> = grid.instances.map((inst) => ({
      title: instanceHeader(inst),
      key: inst.name,
      width: instW,
      render: (_v, r) => {
        const key = `${r.param.id}|${inst.name}`;
        return (
          <EditableCell
            cell={r.cells[inst.name]}
            param={r.param}
            instance={inst.name}
            allInstances={instanceNames}
            presets={presetsQ.data}
            pendingItem={pendingMap.get(key)}
            editing={editing === key}
            onStartEdit={() => setEditing(key)}
            onCancel={() => setEditing(null)}
            onCommit={(value) => {
              setEditing(null);
              save.mutate({ instance: inst.name, paramId: r.param.id, value });
            }}
            onAction={(action) =>
              save.mutate({ instance: inst.name, paramId: r.param.id, action })
            }
            onCopyTo={(target) =>
              save.mutate({ instance: target, paramId: r.param.id, value: r.cells[inst.name]?.value })
            }
            onUndo={() => revert.mutate({ paramId: r.param.id, instance: inst.name })}
          />
        );
      },
    }));
    return [...base, ...instCols];
    // save.mutate/revert.mutate/setEditing are stable; the rest drive re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.instances, editing, presetsQ.data, pendingMap, prefs.showTypeCol, prefs.showDescCol, instW]);

  const scrollX = PARAM_W + TYPE_W + DESC_W + grid.instances.length * instW;
  const headerH = prefs.density === "compact" ? 55 : 63;
  const title = categoryKey ? categoryKey.split("/").pop() : "All Parameters";
  const activeFilters = Number(filters.invalidOnly) + Number(filters.overriddenOnly) + Number(filters.hideNA);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", flexWrap: "wrap" }}>
        <Typography.Text strong>{title}</Typography.Text>
        <Tag>{rows.length} parameters</Tag>
        {q && (
          <Tag
            color="blue"
            closable
            closeIcon={<CloseCircleFilled />}
            onClose={() => setSearch("")}
          >
            search: “{search.trim()}”
          </Tag>
        )}
        <div style={{ flex: 1 }} />
        <Space size={4}>
          <Popover
            trigger="click"
            placement="bottomRight"
            title="What do the marks mean?"
            content={
              <div style={{ display: "flex", flexDirection: "column", gap: 7, width: 300, fontSize: 12 }}>
                <span><span className="cell-pending mono">10.0.0.1</span> — your pending change (hover it to see before → after)</span>
                <span><span className="cell-new mono">1.2</span> — newly introduced in this software version</span>
                <span><span className="cell-deprecated mono">off</span> — deprecated; no longer editable</span>
                <span><span className="cell-invalid mono">99999</span> — value breaks a rule (hover for why)</span>
                <span><span className="cell-excluded">∅ excluded</span> — removed from this instance's files entirely</span>
                <span><span className="cell-na">n/a</span> — doesn't exist in this software version yet</span>
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
            <Button size="small" type="text" icon={<QuestionCircleOutlined />}>Legend</Button>
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
            <Button size="small" icon={<FilterOutlined />}>
              Filter{activeFilters ? ` (${activeFilters})` : ""}
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
                <Checkbox checked={prefs.showDescCol} onChange={(e) => setPrefs({ showDescCol: e.target.checked })}>
                  Description
                </Checkbox>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>PANELS</Typography.Text>
                <Checkbox checked={prefs.showCompare} onChange={(e) => setPrefs({ showCompare: e.target.checked })}>
                  Compare panel
                </Checkbox>
              </div>
            }
          >
            <Button size="small" icon={<SettingOutlined />}>View</Button>
          </Popover>
        </Space>
      </div>
      <AddParameterModal open={addOpen} onClose={() => setAddOpen(false)} grid={grid} />
      <div ref={bodyRef} style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
        <Table<Row>
          rowKey={(r) => r.param.id}
          columns={columns}
          dataSource={rows}
          size={prefs.density === "compact" ? "small" : "middle"}
          virtual
          scroll={{ x: scrollX, y: Math.max(bodyH - headerH, 120) }}
          pagination={false}
          onRow={(r) => ({
            onClick: () => selectParam(r.param.id),
            style:
              r.param.id === selectedParamId
                ? { background: "rgba(47,107,255,0.08)", cursor: "pointer" }
                : { cursor: "pointer" },
          })}
        />
      </div>
    </div>
  );
}
