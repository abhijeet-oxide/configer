import {
  Table,
  Tag,
  Tooltip,
  Space,
  Button,
  Typography,
  Switch,
  Input,
  Select,
  Badge,
  Dropdown,
  Checkbox,
  Segmented,
  Modal,
  App as AntApp,
  theme as antdTheme,
  type GetRef,
} from "antd";
import {
  LockOutlined,
  CloseCircleFilled,
  PlusOutlined,
  QuestionCircleOutlined,
  SearchOutlined,
  GlobalOutlined,
  ScopeGlobalOutlined,
  ScopeInstanceOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  SwapOutlined,
  UpOutlined,
  DownOutlined,
  MoreOutlined,
} from "../icons";
import AddParameterModal from "./AddParameterModal";
import SubmitChangesButton from "./SubmitChangesButton";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Cell,
  bindingsOf,
  type ChangeItem,
  type Grid,
  type Instance,
  type Parameter,
  type PresetRule,
  type Row,
} from "../api";
import { effectiveRules, fmtValue } from "../rules";
import {
  CellView,
  EnumEditor,
  ListEditor,
  NumberEditor,
  SourceBadge,
  StringEditor,
  scopeColor,
  scopeExplain,
} from "./grid/cells";
import { envHex } from "../theme";
import { enqueueEdit, OfflineError } from "../offline";
import { useElementSize } from "../hooks";
import { useUI } from "../store";

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
  onFind,
  onReplace,
  onOpenFile,
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
  onFind: (value: string) => void;
  onReplace: (value: string) => void;
  /** open the file this cell's value lives in (Files workspace) */
  onOpenFile?: () => void;
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
    ...(cell.editable && cell.source === "instance"
      ? [{ key: "reset", label: "Reset to inherited (remove from this instance's files)" }]
      : []),
    ...(cell.editable && cell.set
      ? [{ key: "exclude", label: "Remove from this instance (delete the key)" }]
      : []),
    ...(cell.set && allInstances.length > 1
      ? [{
          key: "copy",
          label: "Copy value to…",
          children: allInstances
            .filter((n) => n !== instance)
            .map((n) => ({ key: `copy:${n}`, label: n })),
        }]
      : []),
    ...(cell.set && cell.value != null
      ? [
          { type: "divider" as const },
          { key: "find", label: `Find occurrences of "${fmtValue(cell.value)}"` },
          { key: "replace", label: `Replace occurrences of "${fmtValue(cell.value)}"…` },
        ]
      : []),
    ...(cell.file && onOpenFile
      ? [
          { type: "divider" as const },
          { key: "openfile", label: `Open ${cell.file.split("/").pop()} in Files` },
        ]
      : []),
  ];

  const body =
    param.type === "boolean" && cell.editable && cell.set ? (
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
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          if (key === "undo") onUndo();
          else if (key === "edit") onStartEdit();
          else if (key === "reset") onAction("reset");
          else if (key === "exclude") onAction("exclude");
          else if (key === "find") onFind(fmtValue(cell.value));
          else if (key === "replace") onReplace(fmtValue(cell.value));
          else if (key === "openfile") onOpenFile?.();
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

// valueSig is a row's value fingerprint across instances: two rows share a
// signature when they hold the same value in every instance (true "same
// value"), so grouping never fuses rows that merely coincide in one column.
function valueSig(r: Row, instances: Instance[]): string {
  return JSON.stringify(instances.map((i) => r.cells[i.name]?.value ?? null));
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
  const hay = [
    p.name, p.displayName, p.description, p.category, p.id,
    ...bindingsOf(p).flatMap((b) => [b.file, b.path]),
  ]
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
            background: envHex(inst.environment),
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
  const { categoryKey, selectedParamId, selectParam, selectedInstance, selectInstance, search, setSearch, filters, setFilters, prefs, setPrefs, jump, setJump, editorFocus, setEditorFocus, setFileFocus, setSection } =
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
  // Single-instance view: pick one instance and the matrix collapses to a
  // Parameter / Value / Source / Changed sheet for that instance alone.
  // Single-instance view. It initializes from the ?inst= selection so a
  // handoff ("open the configuration for THIS instance", from topology or the
  // global Instances page) lands on an already-filtered sheet, and it writes
  // back through selectInstance so the URL always reflects the filter.
  const [viewInstance, setViewInstance] = useState<string | null>(
    () => useUI.getState().selectedInstance,
  );
  // Environment filter: narrows the visible instance columns (and the
  // instance picker) to one environment.
  const [envFilter, setEnvFilter] = useState<string>("");
  // Draft-status filter pills (All / Changed / Added / Removed).
  const [pill, setPill] = useState<"all" | "changed" | "added" | "removed">("all");
  // one-shot flash highlight after a jump from the left-hand trees, the
  // health map, or an application's details panel (kind "cell": row+column)
  const [flash, setFlash] = useState<{ kind: "param" | "instance" | "cell"; id: string; inst?: string } | null>(null);
  // Find & Replace dialog (opened from the toolbar or a cell's right-click)
  const [findReplace, setFindReplace] = useState<{ find: string } | null>(null);
  // The single-row toolbar's overflow menu and the legend dialog.
  const [moreOpen, setMoreOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
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

  // Canonical order matching the left parameter tree: the tree groups by the
  // dotted name and orders each node's children (sub-groups and leaves) by
  // segment, which is exactly a full-name sort. So the table, ordered by full
  // name, reads top-to-bottom in the same order as the tree.
  const treeOrder = useMemo(() => {
    const order = new Map<string, number>();
    [...grid.rows]
      .sort((a, b) => a.param.name.localeCompare(b.param.name))
      .forEach((r, i) => order.set(r.param.id, i));
    return order;
  }, [grid.rows]);

  // The instance columns currently on screen (environment filter + the
  // single-instance view). Widths stay derived from ALL instances so
  // switching filters never re-lays-out the columns.
  const visibleInstances = useMemo(
    () =>
      grid.instances.filter(
        (i) =>
          (!envFilter || (i.environment ?? "") === envFilter) &&
          (!viewInstance || i.name === viewInstance),
      ),
    [grid.instances, envFilter, viewInstance],
  );

  // Draft items per parameter, for the status pills and the Changed column.
  const pendingByParam = useMemo(() => {
    const m = new Map<string, ChangeItem[]>();
    for (const it of draftQ.data?.draft?.items ?? []) {
      if (!it.paramId) continue;
      const arr = m.get(it.paramId) ?? [];
      arr.push(it);
      m.set(it.paramId, arr);
    }
    return m;
  }, [draftQ.data]);
  const isAdded = (it: ChangeItem) =>
    (it.old == null || it.old === "") && (!it.action || it.action === "set");
  const isRemoved = (it: ChangeItem) =>
    it.action === "exclude" || it.action === "reset" || it.action === "remove-instance";

  const q = search.trim().toLowerCase();
  const lq = localQ.trim().toLowerCase();
  const baseRows = useMemo(() => {
    const filtered = grid.rows.filter((r) => {
      // categoryKey is a dotted NAME prefix selected in the tree.
      if (categoryKey && r.param.name !== categoryKey && !r.param.name.startsWith(categoryKey + "."))
        return false;
      if (q && !rowMatches(r, q, searchScope)) return false;
      if (lq && !rowMatches(r, lq, searchScope)) return false;
      const cells = Object.values(r.cells);
      if (filters.invalidOnly && !cells.some((c) => !c.valid)) return false;
      if (filters.overriddenOnly && !cells.some((c) => c.set && c.source === "instance")) return false;
      if (filters.hideNA && cells.every((c) => c.state === "na")) return false;
      return true;
    });
    filtered.sort(
      (a, b) => (treeOrder.get(a.param.id) ?? 0) - (treeOrder.get(b.param.id) ?? 0),
    );
    return filtered;
  }, [grid.rows, categoryKey, q, lq, filters, searchScope, treeOrder]);

  // Counts for the draft-status pills, taken before the pill filter applies
  // so the numbers stay stable while switching between them.
  const pillCounts = useMemo(() => {
    let changed = 0;
    let added = 0;
    let removed = 0;
    for (const r of baseRows) {
      const items = pendingByParam.get(r.param.id) ?? [];
      if (items.length > 0) changed++;
      if (items.some(isAdded)) added++;
      if (items.some(isRemoved)) removed++;
    }
    return { changed, added, removed };
     
  }, [baseRows, pendingByParam]);

  const rows = useMemo(() => {
    const pilled = baseRows.filter((r) => {
      if (pill === "all") return true;
      const items = pendingByParam.get(r.param.id) ?? [];
      if (pill === "changed") return items.length > 0;
      if (pill === "added") return items.some(isAdded);
      return items.some(isRemoved);
    });
    if (!prefs.groupByValue) return pilled;
    // Group-by-value: cluster rows that share the same value signature (their
    // per-instance values, identical across the board) adjacently, anchored at
    // each group's first appearance so the overall order stays familiar.
    const bySig = new Map<string, Row[]>();
    const order: string[] = [];
    for (const r of pilled) {
      const s = valueSig(r, grid.instances);
      if (!bySig.has(s)) {
        bySig.set(s, []);
        order.push(s);
      }
      bySig.get(s)!.push(r);
    }
    return order.flatMap((s) => bySig.get(s)!);
     
  }, [baseRows, pill, pendingByParam, prefs.groupByValue, grid.instances]);

  // Visual metadata for group-by-value: for each row in a same-value group of
  // more than one, its cycling color and whether it opens/closes the group box.
  const groupMeta = useMemo(() => {
    if (!prefs.groupByValue) return null;
    const counts = new Map<string, number>();
    const sigs = rows.map((r) => valueSig(r, grid.instances));
    for (const s of sigs) counts.set(s, (counts.get(s) ?? 0) + 1);
    const meta = new Map<string, { color: number; top: boolean; bot: boolean }>();
    let color = -1;
    for (let i = 0; i < rows.length; i++) {
      const s = sigs[i];
      if ((counts.get(s) ?? 0) < 2) continue;
      const top = i === 0 || sigs[i - 1] !== s;
      const bot = i === rows.length - 1 || sigs[i + 1] !== s;
      if (top) color = (color + 1) % 5;
      meta.set(rows[i].param.id, { color, top, bot });
    }
    return meta;
  }, [rows, prefs.groupByValue, grid.instances]);

  // Auto-fit: each instance column gets at least what its longest visible
  // value needs (so "staging.example.internal" never truncates), and any
  // remaining container width is distributed evenly so wide screens fill up.
  // Metadata columns are kept tight so the instance columns (the point of the
  // grid) get the width budget. Type/Scope hold short tags; Description is a
  // supporting hint (the full text is always in the details panel), so it stays
  // narrow and truncates.
  const PARAM_W = 240;
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
  // the shared/default chain asks the user what they mean before staging.
  const routeCommit = (param: Parameter, instName: string, cell: Cell | undefined, value: unknown) => {
    if (
      param.scope === "global" &&
      cell &&
      (cell.source === "base" || cell.source === "default")
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
    // antd's virtual table scrolls horizontally via wheel deltas (the body is
    // transform-positioned, so setting scrollLeft does nothing and desyncs the
    // header). Dispatching a wheel with the right deltaX moves the body AND
    // keeps the sticky header aligned. The header's scrollLeft mirrors the
    // current horizontal position, so we delta from there to the target.
    const scrollToInstance = (name: string) => {
      let left = 0;
      for (const inst of visibleInstances) {
        if (inst.name === name) break;
        left += instWidths[inst.name] ?? 150;
      }
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
    };
    if (jump.kind === "param" || jump.kind === "cell") {
      const idx = rows.findIndex((r) => r.param.id === jump.id);
      if (idx < 0) return; // rows not filtered to it yet; retry on next update
      consumedJump.current = jump.n;
      tableRef.current?.scrollTo({ index: Math.max(idx - 2, 0) });
      selectParam(jump.id);
      if (jump.kind === "cell" && jump.inst) scrollToInstance(jump.inst);
    } else {
      consumedJump.current = jump.n;
      scrollToInstance(jump.id);
    }
    setFlash({ kind: jump.kind, id: jump.id, inst: jump.inst });
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
        ellipsis: { showTitle: false },
        sorter: (a, b) => a.param.name.localeCompare(b.param.name),
        render: (_v, r) => (
          // The name column is a fixed width; long dotted names must truncate
          // (with the full name on hover) instead of spilling into Type/Scope.
          <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            {r.param.secret && <LockOutlined style={{ color: "#faad14", flexShrink: 0 }} />}
            <Tooltip title={r.param.name} placement="topLeft">
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {hl(r.param.name, hlParam)}
              </span>
            </Tooltip>
            {bindingsOf(r.param).length === 0 && (
              <Tooltip title="Design phase: not attached to a configuration file yet. Attach it to real file locations from the details panel.">
                <Tag color="purple" style={{ fontSize: 10, lineHeight: "16px", marginInlineStart: 2, flexShrink: 0 }}>
                  design
                </Tag>
              </Tooltip>
            )}
          </div>
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
              {r.param.scope === "global" ? (
                <ScopeGlobalOutlined style={{ marginInlineEnd: 4 }} />
              ) : (
                <ScopeInstanceOutlined style={{ marginInlineEnd: 4 }} />
              )}
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
    const instCols: ColumnsType<Row> = visibleInstances.map((inst) => ({
      title: viewInstance ? "Value" : instanceHeader(inst),
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
          ((flash?.kind === "instance" && flash.id === inst.name) ||
          (flash?.kind === "cell" && flash.inst === inst.name)
            ? " th-flash"
            : "") +
          (selectedInstance === inst.name ? " col-selected-h" : ""),
        onClick: () => selectInstance(selectedInstance === inst.name ? null : inst.name),
        style: { cursor: "pointer" },
      }),
      onCell: (r: Row) => ({
        className:
          (selectedInstance === inst.name ? "col-selected" : "") +
          (flash?.kind === "cell" && flash.id === r.param.id && flash.inst === inst.name
            ? " cell-flash"
            : ""),
      }),
      render: (_v, r) => {
        const key = `${r.param.id}|${inst.name}`;
        const cell = r.cells[inst.name];
        // a pending global edit surfaces on every cell it would affect
        const pendingItem =
          pendingMap.get(key) ??
          (cell && (cell.source === "base" || cell.source === "default")
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
            onFind={(value) => {
              setLocalQ(value);
              setSearchScope("value");
            }}
            onReplace={(value) => setFindReplace({ find: value })}
            onOpenFile={
              cell?.file
                ? () => {
                    const b = bindingsOf(r.param).find((x) => x.path === cell.path);
                    setFileFocus({ path: cell.file!, line: b?.line || undefined, instance: inst.name });
                    setSection("files");
                  }
                : undefined
            }
          />
        );
      },
    }));
    // Single-instance view: the reference sheet layout gains provenance and
    // draft-status columns beside the one Value column.
    const extraCols: ColumnsType<Row> = viewInstance
      ? [
          {
            title: "Source",
            key: "source",
            width: 100,
            render: (_v, r) => {
              const c = r.cells[viewInstance];
              if (!c || !c.set) return <span style={{ color: "var(--text-3)" }}>-</span>;
              const label = c.source === "instance" ? "Local" : c.source === "base" ? "Base" : "Default";
              return (
                <span
                  style={{
                    fontSize: 12,
                    color: c.source === "instance" ? "var(--c-review)" : "var(--text-2)",
                    fontWeight: c.source === "instance" ? 600 : 400,
                  }}
                >
                  {label}
                </span>
              );
            },
          },
          {
            title: "Changed",
            key: "changed",
            width: 90,
            render: (_v, r) => {
              const items = pendingByParam.get(r.param.id) ?? [];
              const hit = items.some((it) => it.instance === viewInstance || it.scope === "global");
              return hit ? (
                <span style={{ color: "var(--c-danger)", fontWeight: 600, fontSize: 12 }}>Yes</span>
              ) : (
                <span style={{ color: "var(--text-3)", fontSize: 12 }}>No</span>
              );
            },
          },
        ]
      : [];
    return [...base, ...instCols, ...extraCols];
    // save.mutate/revert.mutate/setEditing are stable; the rest drive re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.instances, visibleInstances, viewInstance, grid.rows, editing, presetsQ.data, pendingMap, pendingByParam, prefs.showTypeCol, prefs.showScopeCol, prefs.showDescCol, instWidths, flash, selectedInstance, hlParam, hlDesc]);

  const scrollX =
    PARAM_W + TYPE_W + SCOPE_W + DESC_W + (viewInstance ? 190 : 0) +
    visibleInstances.reduce((a, i) => a + (instWidths[i.name] ?? 150), 0);
  const headerH = prefs.density === "compact" ? 55 : 63;
  const title = categoryKey ? categoryKey.split(".").pop() : "All Parameters";
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

  const pendingCount = draftQ.data?.draft?.items?.length ?? 0;
  const environments = [...new Set(grid.instances.map((i) => i.environment).filter(Boolean))] as string[];
  const pickerInstances = grid.instances.filter((i) => !envFilter || (i.environment ?? "") === envFilter);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      {/* ONE toolbar row: context (instance, environment), the draft-status
          pills, search, an overflow menu for everything else, and the primary
          action. It wraps only when space truly runs out. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          rowGap: 6,
          padding: "7px 12px",
          flexWrap: "wrap",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {/* Left cluster: what you're looking at. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexShrink: 0 }}>
          <Tooltip title="View all instances side by side, or one instance as a single sheet">
            <Select
              size="small"
              value={viewInstance ?? ""}
              onChange={(v) => {
                setViewInstance(v || null);
                selectInstance(v || null);
              }}
              style={{ width: 168 }}
              options={[
                { value: "", label: "All instances" },
                ...pickerInstances.map((i) => ({ value: i.name, label: i.name })),
              ]}
            />
          </Tooltip>
          <Tooltip title="Show only instances of one environment">
            <Select
              size="small"
              value={envFilter}
              onChange={(v) => {
                setEnvFilter(v);
                if (v && viewInstance && grid.instances.find((i) => i.name === viewInstance)?.environment !== v) {
                  setViewInstance(null);
                  selectInstance(null);
                }
              }}
              style={{ width: 118 }}
              options={[
                { value: "", label: "All environments" },
                ...environments.map((e) => ({ value: e, label: e })),
              ]}
            />
          </Tooltip>
          <span style={{ width: 1, height: 20, background: "var(--border)" }} />
          <Segmented
            size="small"
            value={pill}
            onChange={(v) => setPill(v as typeof pill)}
            options={[
              { value: "all", label: "All" },
              { value: "changed", label: `Changed${pillCounts.changed ? ` (${pillCounts.changed})` : ""}` },
              { value: "added", label: `Added${pillCounts.added ? ` (${pillCounts.added})` : ""}` },
              { value: "removed", label: `Removed${pillCounts.removed ? ` (${pillCounts.removed})` : ""}` },
            ]}
          />
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>{rows.length}</span>
          {q && (
            <Tag color="blue" closable closeIcon={<CloseCircleFilled />} onClose={() => setSearch("")}>
              ⌘K: “{search.trim()}”
            </Tag>
          )}
        </div>
        {/* Right cluster: narrowing and acting. marginLeft:auto keeps it
            flush-right on one row, and drops it whole (still right-aligned)
            onto a clean second row only when space truly runs out. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", minWidth: 0 }}>
          <Space.Compact size="small" style={{ flex: "0 1 260px", minWidth: 140 }}>
            <Select
              size="small"
              value={searchScope}
              onChange={(v) => setSearchScope(v)}
              style={{ width: 64, flexShrink: 0 }}
              popupMatchSelectWidth={96}
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
          <Tooltip title="Add parameter">
            <Button size="small" icon={<PlusOutlined />} onClick={() => setAddOpen(true)} aria-label="Add parameter" />
          </Tooltip>
        <Dropdown
          trigger={["click"]}
          open={moreOpen}
          onOpenChange={setMoreOpen}
          menu={{
            items: [
              { key: "findreplace", icon: <SwapOutlined />, label: "Find & replace values…" },
              { key: "legend", icon: <QuestionCircleOutlined />, label: "Legend: what the marks mean" },
              {
                key: "focus",
                icon: editorFocus ? <FullscreenExitOutlined /> : <FullscreenOutlined />,
                label: editorFocus ? "Exit focus mode" : "Focus mode",
              },
              { type: "divider" as const },
              { key: "invalidOnly", label: <Checkbox checked={filters.invalidOnly}>Only invalid</Checkbox> },
              { key: "overriddenOnly", label: <Checkbox checked={filters.overriddenOnly}>Only instance overrides</Checkbox> },
              { key: "hideNA", label: <Checkbox checked={filters.hideNA}>Hide fully n/a rows</Checkbox> },
              { type: "divider" as const },
              {
                key: "density",
                label: <Checkbox checked={prefs.density === "comfortable"}>Comfortable density</Checkbox>,
              },
              { key: "showTypeCol", label: <Checkbox checked={prefs.showTypeCol}>Type column</Checkbox> },
              { key: "showScopeCol", label: <Checkbox checked={prefs.showScopeCol}>Scope column</Checkbox> },
              { key: "showDescCol", label: <Checkbox checked={prefs.showDescCol}>Description column</Checkbox> },
              { key: "groupByValue", label: <Checkbox checked={prefs.groupByValue}>Group by value</Checkbox> },
            ],
            onClick: ({ key }) => {
              if (key === "findreplace") {
                setFindReplace({ find: "" });
                setMoreOpen(false);
              } else if (key === "legend") {
                setLegendOpen(true);
                setMoreOpen(false);
              } else if (key === "focus") {
                setEditorFocus(!editorFocus);
                setMoreOpen(false);
              } else if (key === "invalidOnly" || key === "overriddenOnly" || key === "hideNA") {
                setFilters({ [key]: !filters[key as keyof typeof filters] } as Partial<typeof filters>);
              } else if (key === "density") {
                setPrefs({ density: prefs.density === "comfortable" ? "compact" : "comfortable" });
              } else if (key === "showTypeCol" || key === "showScopeCol" || key === "showDescCol" || key === "groupByValue") {
                setPrefs({ [key]: !prefs[key as keyof typeof prefs] } as Partial<typeof prefs>);
              }
            },
          }}
        >
          <Badge dot={activeFilters > 0 || prefs.groupByValue} color="var(--c-review)" offset={[-2, 2]}>
            <Button size="small" icon={<MoreOutlined />} aria-label="More editor options" title="Filters, view options and tools" />
          </Badge>
        </Dropdown>
          <span style={{ width: 1, height: 20, background: "var(--border)" }} />
          {/* Save state as a single dot: green = saved, orange = unsent
              edits. The words live in the tooltip so the toolbar keeps to
              one row. */}
          <Tooltip
            title={
              pendingCount === 0
                ? "All changes saved"
                : `${pendingCount} unsent edit${pendingCount === 1 ? "" : "s"}: create a change request to submit`
            }
          >
            <span
              role="status"
              aria-label={pendingCount === 0 ? "All changes saved" : `${pendingCount} unsent edits`}
              style={{
                width: 9,
                height: 9,
                borderRadius: 5,
                flexShrink: 0,
                background: pendingCount === 0 ? "var(--c-ok)" : "var(--c-pending)",
                boxShadow: `0 0 0 3px ${pendingCount === 0 ? "var(--c-ok-bg)" : "var(--c-pending-bg)"}`,
                cursor: "default",
              }}
            />
          </Tooltip>
          {pendingCount > 0 && (
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--c-pending)" }}>{pendingCount}</span>
          )}
          <SubmitChangesButton instances={grid.instances} />
        </div>
      </div>

      <Modal
        title="What do the marks mean?"
        open={legendOpen}
        onCancel={() => setLegendOpen(false)}
        footer={null}
        width={420}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 12 }}>
          <span><span className="cell-pending mono">10.0.0.1</span>: your pending change (hover it to see before and after)</span>
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
      </Modal>
      <AddParameterModal open={addOpen} onClose={() => setAddOpen(false)} grid={grid} />
      {findReplace && (
        <FindReplaceModal
          grid={grid}
          initialFind={findReplace.find}
          onClose={() => setFindReplace(null)}
        />
      )}
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
          rowClassName={(r) => {
            const g = groupMeta?.get(r.param.id);
            return (
              ((flash?.kind === "param" || flash?.kind === "cell") && flash.id === r.param.id ? "row-flash " : "") +
              (r.param.id === selectedParamId ? "row-selected " : "") +
              (g ? `vgrp vgrp-c${g.color}${g.top ? " vgrp-top" : ""}${g.bot ? " vgrp-bot" : ""}` : "")
            ).trim();
          }}
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

// coerceToType turns the replacement string back into a parameter's declared
// type, so replacing "3" in an integer parameter stores 3, not "3".
function coerceToType(raw: string, type: string): unknown {
  switch (type) {
    case "integer":
    case "number": {
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    case "boolean":
      return raw === "true";
    case "list":
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    default:
      return raw;
  }
}

interface FRMatch {
  paramId: string;
  name: string;
  instance: string;
  type: string;
  current: string;
}

// FindReplaceModal finds every editable cell whose value equals the search
// term and replaces it in one action, the pragmatic tool for "these N
// parameters all say X, change them together" without permanently merging
// them. Each replacement is staged into the draft like a normal cell edit, so
// it still flows through review. A preview shows exactly what will change.
function FindReplaceModal({
  grid,
  initialFind,
  onClose,
}: {
  grid: Grid;
  initialFind: string;
  onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [find, setFind] = useState(initialFind);
  const [replace, setReplace] = useState("");
  const [instances, setInstances] = useState<string[]>([]); // empty = all
  const [caseSensitive, setCaseSensitive] = useState(true);

  const matches = useMemo<FRMatch[]>(() => {
    const needle = find.trim();
    if (!needle) return [];
    const targets = new Set(instances.length ? instances : grid.instances.map((i) => i.name));
    const eq = (a: string) => (caseSensitive ? a === needle : a.toLowerCase() === needle.toLowerCase());
    const out: FRMatch[] = [];
    for (const r of grid.rows) {
      for (const inst of grid.instances) {
        if (!targets.has(inst.name)) continue;
        const c = r.cells[inst.name];
        if (!c || !c.editable || !c.set) continue;
        const cur = fmtValue(c.value);
        if (eq(cur)) out.push({ paramId: r.param.id, name: r.param.name, instance: inst.name, type: r.param.type, current: cur });
      }
    }
    return out;
  }, [grid, find, instances, caseSensitive]);

  const apply = useMutation({
    mutationFn: async () => {
      // Sequential so validation errors surface per cell without racing writes.
      for (const m of matches) {
        await api.setValue({ instance: m.instance, paramId: m.paramId, value: coerceToType(replace, m.type) });
      }
    },
    onSuccess: () => {
      message.success(`Replaced ${matches.length} value${matches.length === 1 ? "" : "s"}; staged in your draft for review.`);
      qc.invalidateQueries();
      onClose();
    },
    onError: (e: Error) => message.error(`Replace failed: ${e.message}`, 6),
  });

  const byParam = matches.reduce((n, m) => n.add(m.paramId), new Set<string>()).size;

  return (
    <Modal
      title={
        <Space>
          <SwapOutlined />
          Find &amp; replace values
        </Space>
      }
      open
      onCancel={onClose}
      width={620}
      okText={matches.length ? `Replace ${matches.length}` : "Replace"}
      okButtonProps={{ disabled: matches.length === 0 || replace === "", loading: apply.isPending }}
      onOk={() => apply.mutate()}
    >
      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <Input placeholder="Find value" value={find} onChange={(e) => setFind(e.target.value)} autoFocus />
        <SwapOutlined style={{ alignSelf: "center", opacity: 0.5 }} />
        <Input placeholder="Replace with" value={replace} onChange={(e) => setReplace(e.target.value)} />
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "12px 0" }}>
        <Checkbox checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)}>
          Case sensitive
        </Checkbox>
        <Select
          size="small"
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="All instances"
          value={instances}
          onChange={setInstances}
          options={grid.instances.map((i) => ({ value: i.name, label: i.name }))}
        />
      </div>
      {find.trim() === "" ? (
        <Typography.Text type="secondary">Enter a value to find its occurrences across the grid.</Typography.Text>
      ) : matches.length === 0 ? (
        <Typography.Text type="secondary">No editable cells currently hold that value.</Typography.Text>
      ) : (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {matches.length} cell{matches.length === 1 ? "" : "s"} across {byParam} parameter{byParam === 1 ? "" : "s"} will change
            {replace !== "" && (
              <>
                {": "}
                <span className="mono" style={{ textDecoration: "line-through", opacity: 0.6 }}>{find}</span>
                {" → "}
                <span className="mono" style={{ color: "#389e0d" }}>{replace}</span>
              </>
            )}
          </Typography.Text>
          <div style={{ maxHeight: 260, overflow: "auto", marginTop: 8, border: "1px solid rgba(127,137,160,0.22)", borderRadius: 8 }}>
            <Table<FRMatch>
              size="small"
              rowKey={(m) => `${m.paramId}|${m.instance}`}
              dataSource={matches.slice(0, 300)}
              pagination={false}
              columns={[
                { title: "Parameter", dataIndex: "name", render: (v) => <span className="mono" style={{ fontSize: 12 }}>{v}</span> },
                { title: "Instance", dataIndex: "instance", width: 150 },
              ]}
            />
          </div>
        </>
      )}
    </Modal>
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
