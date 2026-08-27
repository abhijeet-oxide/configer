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
  ScopeSiteOutlined,
  ScopeInstanceOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  SwapOutlined,
  TableOutlined,
  UpOutlined,
  DownOutlined,
  SettingOutlined,
  UndoOutlined,
  FileSearchOutlined,
  FileOutlined,
  EyeInvisibleOutlined,
  InfoCircleOutlined,
  CheckCircleOutlined,
  ClockOutlined,
  PushpinOutlined,
  PushpinFilled,
  HolderOutlined,
} from "../icons";
import AddParameterModal from "./AddParameterModal";
import { EmptyState, InlineNotice } from "./ui";
import SubmitChangesButton from "./SubmitChangesButton";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import {
  api,
  type Cell,
  bindingsOf,
  expandBinding,
  type ChangeItem,
  type Grid,
  type Instance,
  nameSegments,
  type Parameter,
  type PresetRule,
  type Row,
} from "../api";
import { effectiveRules, fmtValue, typeLabel } from "../rules";
import { effectiveScope, SCOPE_META, type ScopeFacet, type ScopeFilter } from "../scope";
import { buildNameTree, inGroup, nameTreeOrder } from "../paramtree";
import GroupEditorModal from "./GroupEditorModal";
import {
  CellView,
  EnumEditor,
  ListEditor,
  NumberEditor,
  SourceBadge,
  StringEditor,
} from "./grid/cells";
import ValueDiff from "./ui/ValueDiff";
import { stageEdit, unstageEdit, type ValueEdit } from "./grid/optimistic";
import { canonicalEnv, envHex, envOptions } from "../theme";
import { useIdentity } from "../identity";
import { enqueueEdit, OfflineError } from "../offline";
import { useDebounced, useElementSize } from "../hooks";
import { useUI, type GroupBy } from "../store";
import { c } from "../uikit";

function EditableCell({
  cell,
  param,
  instance,
  allInstances,
  presets,
  pendingItem,
  beforeAfter,
  canEdit,
  revertible,
  editing,
  onStartEdit,
  onCancel,
  onCommit,
  onAction,
  onCopyTo,
  onBulkSet,
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
  /** show a staged cell as "old -> new" rather than just the new value */
  beforeAfter?: boolean;
  /** this person may change configuration in this application */
  canEdit: boolean;
  /** a draft item exists for THIS cell, so undoing it means something */
  revertible: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onCommit: (v: unknown) => void;
  onAction: (action: "reset" | "exclude") => void;
  onCopyTo: (target: string) => void;
  /** open the "set this value across many instances" picker */
  onBulkSet: () => void;
  onUndo: () => void;
  onFind: (value: string) => void;
  onReplace: (value: string) => void;
  /** open the file this cell's value lives in (Files workspace) */
  onOpenFile?: () => void;
}) {
  // Whether this cell's context menu has ever been asked for, and whether it is
  // showing. See the bottom of this component: the menu is not mounted until
  // the first right-click.
  const [menu, setMenu] = useState(false);
  const [menuOpen, setMenuOpen] = useState(true);
  if (!cell) return <span style={{ opacity: 0.3 }}>-</span>;
  const rules = effectiveRules(param, presets);
  // A cell is editable when the PARAMETER allows it (not n/a, not deprecated,
  // not a template expression) AND this person may change configuration here.
  // Everything below keys off this one value, so a viewer gets a grid that
  // simply has no edit affordances rather than controls that fail on use.
  const editable = canEdit && cell.editable;

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
    return (
      <StringEditor
        initial={cell.value}
        rules={rules}
        paramName={param.displayName || param.name}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }

  // Right-click menu: structural actions beyond plain value edits. Everything
  // that would write is gated on `editable`; finding occurrences and opening the
  // file are reads, so they stay for a viewer.
  const menuItems = [
    ...(canEdit && revertible ? [{ key: "undo", label: "Undo pending change" }] : []),
    ...(editable ? [{ key: "edit", label: "Edit value" }] : []),
    ...(editable && cell.source === "instance"
      ? [{ key: "reset", label: "Reset to inherited (remove from this instance's files)" }]
      : []),
    ...(editable && cell.set
      ? [{ key: "exclude", label: "Remove from this instance (delete the key)" }]
      : []),
    ...(canEdit && cell.set && cell.value != null && allInstances.length > 1
      ? [{ key: "bulkset", label: "Set on other instances…" }]
      : []),
    ...(canEdit && cell.set && allInstances.length > 1
      ? [{
          key: "copy",
          label: "Copy value to one…",
          children: allInstances
            .filter((n) => n !== instance)
            .map((n) => ({ key: `copy:${n}`, label: n })),
        }]
      : []),
    ...(cell.set && cell.value != null
      ? [
          { type: "divider" as const },
          { key: "find", label: `Find occurrences of "${fmtValue(cell.value)}"` },
          ...(canEdit
            ? [{ key: "replace", label: `Replace occurrences of "${fmtValue(cell.value)}"…` }]
            : []),
        ]
      : []),
    ...(cell.file && onOpenFile
      ? [
          { type: "divider" as const },
          { key: "openfile", label: `Open ${cell.file.split("/").pop()} in Files` },
        ]
      : []),
  ];

  // A pending cell carries its own one-click undo, so reverting never requires
  // discovering the right-click menu: the affordance is visible on the change
  // itself (with the full undo/reset menu still a right-click away).
  // Undo is offered only where there IS a change of this cell's own to undo.
  // A cell in a staged instance's column is marked pending by the preview, but
  // the pending thing is the whole instance - a per-cell undo there sent a
  // request that matched no draft item and silently did nothing.
  const undoBtn = canEdit && revertible ? (
    <Tooltip title="Undo this change">
      <span
        role="button"
        aria-label="Undo this change"
        onClick={(e) => {
          e.stopPropagation();
          onUndo();
        }}
        className="cell-undo-btn"
      >
        <UndoOutlined />
      </span>
    </Tooltip>
  ) : null;

  const body =
    param.type === "boolean" && editable && cell.set ? (
      <span onClick={(e) => e.stopPropagation()} className={cell.state === "new" ? "cell-new" : undefined} style={{ display: "inline-flex", alignItems: "center" }}>
        <Switch size="small" checked={!!cell.value} onChange={(v) => onCommit(v)} />
        <SourceBadge cell={cell} />
        {undoBtn}
      </span>
    ) : (
      <div
        className="cell-body"
        style={{ minHeight: 20, cursor: editable ? "text" : undefined }}
        title={
          cell.templated
            ? "Template expression, computed when the chart renders. Edit it in file mode to keep the template."
            : // A staged cell carries its own richer hover (before → after, plus
              // the same invitation), so the native hint would double up.
              editable && !pendingItem
              ? "Double-click to edit · right-click for actions"
              : undefined
        }
        onDoubleClick={editable ? onStartEdit : undefined}
      >
        <CellView cell={cell} pendingItem={pendingItem} editable={editable} beforeAfter={beforeAfter} />
        {undoBtn}
      </div>
    );

  if (!menuItems.length) return body;
  // A cell's context menu is a whole antd Dropdown, and a sheet puts several
  // hundred cells on the screen at once: mounting one per cell cost more than
  // everything else the grid does put together, on every single render. The
  // menu is mounted when a cell is first right-clicked, and only for that cell
  // - the wrapper generates no box (display: contents), so nothing about the
  // cell's layout changes and the event still reaches it from the child.
  if (!menu) {
    return (
      <div
        style={{ display: "contents" }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
      >
        {body}
      </div>
    );
  }
  return (
    <Dropdown
      trigger={["contextMenu"]}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      menu={{
        items: menuItems,
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          if (key === "undo") onUndo();
          else if (key === "edit") onStartEdit();
          else if (key === "bulkset") onBulkSet();
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

// measureColumns sizes each instance column to the longest value it holds, so
// "staging.example.internal" is not truncated in a column sized for "true".
// Measured from ALL rows, not the filtered set, so searching or filtering never
// re-lays-out the columns (which used to drift the header out of alignment with
// the body in the virtual table).
function measureColumns(instances: Instance[], rows: Row[]): Record<string, number> {
  const px = (s: string) => Math.round(s.length * 7.4) + 46; // approx mono glyphs + padding/badge
  const need: Record<string, number> = {};
  for (const inst of instances) {
    let w = px(inst.name) + 16; // header text + env dot
    for (const r of rows) {
      const c = r.cells[inst.name];
      if (!c || c.value == null || Array.isArray(c.value)) continue;
      const s = String(c.value);
      if (s) w = Math.max(w, px(s));
    }
    need[inst.name] = Math.min(Math.max(w, 130), 360);
  }
  return need;
}

interface AutoFit {
  sig: string;
  rows: number;
  width: number;
  widths: Record<string, number>;
}

// fitColumns is measureColumns plus the one thing that needs the container:
// any width left over after every column has what it needs is shared out, so a
// wide screen fills up instead of leaving a gutter. Done once, at fit time.
function fitColumns(instances: Instance[], rows: Row[], budget: number): Record<string, number> {
  const need = measureColumns(instances, rows);
  const sum = Object.values(need).reduce((a, b) => a + b, 0);
  const extra = budget - sum;
  if (extra > 0 && instances.length > 0) {
    const per = Math.floor(extra / instances.length);
    for (const k of Object.keys(need)) need[k] += per;
  }
  return need;
}

// What the grouping control is doing, said in the words of the question it
// answers rather than the mechanism.
const GROUP_HINT: Record<GroupBy, string> = {
  none: "Rows in the order the files spell them, the same order the parameter tree reads in.",
  value: "Rows that carry the same value across every instance are brought together and boxed, so the one that differs stands out.",
  path: "Rows are gathered under the path they live at, the way the parameter tree presents them.",
};

// What a row is grouped BY: the values it carries across the fleet, or the
// path it lives under. For path grouping that is the FULL route - category
// plus whatever repeated-structure step it sits in (net-info[1] vs
// net-info[2]) - not just the top-level category, so a list's entries band
// together as the distinct groups they are rather than one group per file
// section. A parameter with no route at all (a flat, top-level setting)
// falls back to its category.
function groupSig(r: Row, by: GroupBy, instances: Instance[]): string {
  if (by === "path") {
    const { route } = splitName(r.param);
    return route.length ? route.join("\u0000") : r.param.category || "\uffffUncategorized";
  }
  return valueSig(r, instances);
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

// A parameter name is read from the RIGHT. "failRetryInterval" is what the
// setting IS; "additionalValues.zts.value.admin.rebuildSlave" is only where it
// lives, and in a fixed-width column an ellipsis at the end cut off the one part
// worth reading. So the cell shows the leaf on its own line and the route to it
// underneath, written the way a path is written.
//
// The steps come from api.nameSegments - the same split the parameter tree
// nests on - so the leaf here and the leaf there are always the same word. A
// "/" also splits, for a name that arrived path-shaped from a source with no
// segmentation of its own; without it such a row was one long bold line among
// rows that all had a leaf and a route.
function splitName(param: Pick<Parameter, "name" | "nameSegments">): { leaf: string; route: string[] } {
  const parts = nameSegments(param).flatMap((s) => (s.includes("/") ? s.split("/").filter(Boolean) : [s]));
  const leaf = parts[parts.length - 1] ?? param.name;
  // A name that ENDS in a separator has no leaf to promote; show it whole
  // rather than an empty first line over a route.
  if (parts.length < 2 || leaf === "") return { leaf: leaf || param.name, route: [] };
  return { leaf, route: parts.slice(0, -1) };
}
function leafOf(param: Pick<Parameter, "name" | "nameSegments">): string {
  return splitName(param).leaf;
}

// A grid of a real estate is FULL of rows whose leaf is the same word. Twelve
// `cpu` rows and nine `memory` rows all read "cpu" over a grey route, and the
// one segment that says WHICH cpu - cmserver, cnfcmserver, indexmgr - is set in
// the same weight and colour as the four segments every one of them shares. The
// reader is left comparing five words across two lines to find the difference,
// and edits the wrong limit.
//
// So: for every set of rows that share a leaf, work out which segments of their
// routes actually TELL THEM APART, and let those carry the weight. The rest
// stays quiet - it is shared context, not identity. Segments are compared from
// the RIGHT, because a route's tail is what a reader anchors on and routes in
// one group are often different lengths.
//
// Computed once per catalog and cached by parameter id: the cell renderer only
// ever looks its own row up, so a scroll through ten thousand rows costs the
// same as before. Grouping over EVERY row (not just the visible ones) keeps a
// row's emphasis from shifting as filters change - what tells a value apart is a
// property of the estate, not of the current search.
function discriminatingSegments(rows: { param: Parameter }[]): Map<string, Set<number>> {
  const byLeaf = new Map<string, { id: string; route: string[] }[]>();
  for (const r of rows) {
    const { leaf, route } = splitName(r.param);
    if (route.length === 0) continue;
    const group = byLeaf.get(leaf);
    if (group) group.push({ id: r.param.id, route });
    else byLeaf.set(leaf, [{ id: r.param.id, route }]);
  }
  const out = new Map<string, Set<number>>();
  for (const group of byLeaf.values()) {
    if (group.length < 2) continue; // a leaf that is already unique needs nothing
    const longest = Math.max(...group.map((g) => g.route.length));
    for (let fromEnd = 1; fromEnd <= longest; fromEnd++) {
      const seen = new Set<string>();
      for (const g of group) seen.add(g.route[g.route.length - fromEnd] ?? " ");
      if (seen.size < 2) continue; // every row shares this step: shared context
      for (const g of group) {
        const i = g.route.length - fromEnd;
        if (i < 0) continue;
        const marks = out.get(g.id) ?? new Set<number>();
        marks.add(i);
        out.set(g.id, marks);
      }
    }
  }
  return out;
}

// Route renders a parameter's route with its distinguishing steps picked out.
// One span per step is the whole cost, and the set of marked indices is looked
// up once per row from a map built for the entire catalog.
function Route({
  param,
  keys,
  q,
}: {
  param: Parameter;
  keys: Set<number> | undefined;
  q: string;
}) {
  const { route } = splitName(param);
  if (route.length === 0) return null;
  return (
    <>
      {route.map((seg, i) => (
        <span key={i}>
          {i > 0 && <span className="cf-route-sep"> / </span>}
          <span className={keys?.has(i) ? "cf-route-key" : undefined}>{hl(seg, q)}</span>
        </span>
      ))}
    </>
  );
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

// FilePicker answers "which FILE am I looking at". On a product that spreads
// one instance across a dozen documents - a deployment descriptor, a network
// input, a certificate provision - the parameter tree groups by NAME, which is
// the wrong axis for somebody who has been handed one file to review. Picking
// none is the normal state and means every file; picking some narrows the grid
// to the parameters those files actually carry.
//
// It sits beside the instance picker rather than inside the settings gear
// because it is context ("what am I looking at"), not a view option.
function FilePicker({
  choices,
  selected,
  onChange,
}: {
  choices: { file: string; count: number }[];
  selected: string[];
  onChange: (files: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const picked = useMemo(() => new Set(selected), [selected]);
  // A file the catalog no longer writes to must not keep filtering invisibly.
  const live = useMemo(
    () => selected.filter((f) => choices.some((c) => c.file === f)),
    [selected, choices],
  );
  const needle = q.trim().toLowerCase();
  const shown = needle ? choices.filter((c) => c.file.toLowerCase().includes(needle)) : choices;

  if (choices.length < 2) return null;

  const label =
    live.length === 0
      ? "All files"
      : live.length === 1
        ? live[0].split("/").pop()
        : `${live.length} files`;

  return (
    <Dropdown
      trigger={["click"]}
      open={open}
      onOpenChange={setOpen}
      placement="bottomLeft"
      popupRender={() => (
        <div className="cf-pop" style={{ width: 340, maxWidth: "90vw" }}>
          <div style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>
            <Input
              size="small"
              allowClear
              autoFocus
              prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
              placeholder="Filter files"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div style={{ maxHeight: 320, overflow: "auto", padding: 4 }}>
            {shown.length === 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12, padding: 8, display: "block" }}>
                No file matches “{q.trim()}”.
              </Typography.Text>
            )}
            {shown.map((c) => (
              <label
                key={c.file}
                className="cf-filepick-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 6px",
                  cursor: "pointer",
                  borderRadius: 4,
                }}
              >
                <Checkbox
                  checked={picked.has(c.file)}
                  onChange={() =>
                    onChange(
                      picked.has(c.file) ? live.filter((f) => f !== c.file) : [...live, c.file],
                    )
                  }
                />
                {/* The path is read from the RIGHT: the file name is what
                    tells one document from another, the folders are context. */}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="mono" style={{ fontSize: 12, display: "block", lineHeight: 1.3 }}>
                    {c.file.split("/").pop()}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: "var(--text-3)",
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      direction: "rtl",
                      textAlign: "left",
                    }}
                  >
                    {c.file}
                  </span>
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                  {c.count}
                </Typography.Text>
              </label>
            ))}
          </div>
          {live.length > 0 && (
            <div style={{ padding: 6, borderTop: "1px solid var(--border)" }}>
              <Button size="small" type="link" style={{ padding: 0 }} onClick={() => onChange([])}>
                Show every file
              </Button>
            </div>
          )}
        </div>
      )}
    >
      <Tooltip title="Show only the parameters these files carry">
        <Badge dot={live.length > 0} color="var(--c-review)" offset={[-4, 2]}>
          <Button size="small" icon={<FileOutlined />} aria-label="Files shown" style={{ flexShrink: 0, maxWidth: 190 }}>
            <span className="cf-instbtn-label">{label}</span>
            <DownOutlined style={{ fontSize: 9, opacity: 0.55, marginInlineStart: 2 }} />
          </Button>
        </Badge>
      </Tooltip>
    </Dropdown>
  );
}

// InstancePicker is THE control for "which instances am I looking at, and in
// what order". It is one panel because it was one question: the toolbar used to
// carry a view Select (all / one environment / one instance) AND a separate
// column manager (tick which instances show, drag to reorder), so half the
// answer lived in each and neither said what the other had done. Ticking one
// instance in one and picking it in the other did different things.
//
// So: one list. A tick is whether the instance has a column, a drag is where
// that column sits, and the row's own name button opens it as a single SHEET -
// which is a different reading of one instance, not a filter, and is the only
// thing here that is not just column state. Environments are quick selections
// over the same ticks rather than a mode of their own, so "all production" and
// "these three" are the same kind of answer.
function InstancePicker({
  instances,
  hidden,
  widths,
  order,
  environments,
  focused,
  onToggle,
  onSetHidden,
  onReorder,
  onFocus,
  onReset,
}: {
  instances: Instance[];
  hidden: Set<string>;
  widths: Record<string, number>;
  order: string[];
  environments: string[];
  /** the instance being read as a single sheet, if any */
  focused: string | null;
  onToggle: (name: string) => void;
  onSetHidden: (names: string[]) => void;
  onReorder: (from: string, to: string) => void;
  onFocus: (name: string | null) => void;
  onReset: () => void;
}) {
  const [q, setQ] = useState("");
  const dirty = hidden.size > 0 || Object.keys(widths).length > 0 || order.length > 0 || !!focused;
  const needle = q.trim().toLowerCase();
  const shownList = needle
    ? instances.filter(
        (i) =>
          i.name.toLowerCase().includes(needle) ||
          (i.environment ?? "").toLowerCase().includes(needle),
      )
    : instances;
  const visible = instances.length - hidden.size;
  return (
    <div className="cf-instpick">
      <div className="cf-instpick-head">
        <span className="cf-instpick-title">Instances</span>
        <span className="cf-instpick-count">
          {visible} of {instances.length} shown
        </span>
        <a
          onClick={onReset}
          className="cf-instpick-reset"
          style={{ opacity: dirty ? 1 : 0.35, pointerEvents: dirty ? "auto" : "none" }}
        >
          Reset
        </a>
      </div>

      {/* A sheet is a reading, not a filter, so leaving it is its own line -
          and it is the first thing here, because while it is on nothing else
          in this panel is doing anything. */}
      {focused && (
        <button type="button" className="cf-instpick-sheet" onClick={() => onFocus(null)}>
          <ScopeInstanceOutlined />
          <span>
            Reading <b>{focused}</b> as a single sheet
          </span>
          <span className="cf-instpick-sheet-exit">Back to the grid</span>
        </button>
      )}

      {instances.length > 7 && (
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
          placeholder="Filter instances"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ marginBottom: 6 }}
        />
      )}

      {/* Quick selections over the same ticks. "All production" is not a mode
          the grid goes into; it is three boxes ticked. */}
      <div className="cf-instpick-quick">
        <a onClick={() => onSetHidden([])}>All</a>
        <a onClick={() => onSetHidden(instances.map((i) => i.name))}>None</a>
        {environments.map((e) => (
          <a
            key={e}
            onClick={() =>
              onSetHidden(
                instances.filter((i) => canonicalEnv(i.environment) !== e).map((i) => i.name),
              )
            }
            title={`Show only the ${e} instances`}
          >
            <span className="cf-instpick-dot" style={{ background: envHex(e) }} />
            {e}
          </a>
        ))}
      </div>

      <div className="cf-instpick-list">
        {shownList.length === 0 && <div className="cf-instpick-empty">No instance matches “{q}”.</div>}
        {shownList.map((inst) => {
          const shown = !hidden.has(inst.name);
          return (
            <div
              key={inst.name}
              className={"cf-col-row" + (focused === inst.name ? " is-focused" : "")}
              {...dragProps("inst", inst.name, onReorder)}
            >
              <HolderOutlined className="cf-col-grip" />
              <Checkbox
                checked={shown}
                onChange={() => onToggle(inst.name)}
                aria-label={`Show the ${inst.name} column`}
              />
              <span className="cf-instpick-dot" style={{ background: envHex(inst.environment) }} />
              <Tooltip title={`Read ${inst.name} on its own, as a sheet`} placement="right">
                <button
                  type="button"
                  className="cf-instpick-name mono"
                  style={{ opacity: shown || focused === inst.name ? 1 : 0.45 }}
                  onClick={() => onFocus(focused === inst.name ? null : inst.name)}
                >
                  {inst.name}
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>
      <div className="cf-instpick-foot">
        Tick to show a column, drag to reorder, click a name to read that instance on its own. Drag
        a column's right edge in the grid to resize it.
      </div>
    </div>
  );
}

// BulkSetModal is the "change once, apply to many" surface - the point of a
// parameter x instance grid. Pick target instances (pre-selected to the source
// instance's own environment, the common intent), see exactly how many will
// change, and stage them all as ordinary pending changes to review before
// publishing.
function BulkSetModal({
  grid,
  param,
  value,
  from,
  applying,
  onClose,
  onApply,
}: {
  grid: Grid;
  param: Parameter;
  value: unknown;
  from: string;
  applying: boolean;
  onClose: () => void;
  onApply: (targets: string[]) => void;
}) {
  const fromEnv = grid.instances.find((i) => i.name === from)?.environment;
  const others = useMemo(() => grid.instances.filter((i) => i.name !== from), [grid.instances, from]);
  const [sel, setSel] = useState<Set<string>>(
    () => new Set(others.filter((i) => canonicalEnv(i.environment) === fromEnv).map((i) => i.name)),
  );
  const toggle = (name: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const setMany = (insts: Instance[], on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      for (const i of insts) {
        if (on) n.add(i.name);
        else n.delete(i.name);
      }
      return n;
    });
  const byEnv = new Map<string, Instance[]>();
  for (const i of others) {
    const e = i.environment || "other";
    byEnv.set(e, [...(byEnv.get(e) ?? []), i]);
  }
  return (
    <Modal
      open
      width={460}
      title={
        <span>
          Set <span className="mono">{param.name}</span> on multiple instances
        </span>
      }
      okText={sel.size ? `Apply to ${sel.size} instance${sel.size === 1 ? "" : "s"}` : "Apply"}
      okButtonProps={{ disabled: sel.size === 0, loading: applying }}
      onOk={() => onApply([...sel])}
      onCancel={onClose}
    >
      <div style={{ marginBottom: 12, fontSize: 13 }}>
        Set the value to{" "}
        <span className="mono" style={{ color: "var(--c-review)", fontWeight: 600 }}>{fmtValue(value)}</span>{" "}
        on the instances you choose. Each becomes a pending change you review before publishing.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: 320, overflow: "auto" }}>
        {[...byEnv.entries()].map(([env, insts]) => {
          const allOn = insts.every((i) => sel.has(i.name));
          return (
            <div key={env}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, textTransform: "capitalize" }}>
                  <span style={{ width: 7, height: 7, borderRadius: 4, background: envHex(env) }} />
                  {env}
                </span>
                <a style={{ fontSize: 12 }} onClick={() => setMany(insts, !allOn)}>
                  {allOn ? "Clear" : "Select all"}
                </a>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingLeft: 13 }}>
                {insts.map((i) => (
                  <Checkbox key={i.name} checked={sel.has(i.name)} onChange={() => toggle(i.name)}>
                    <span className="mono" style={{ fontSize: 12 }}>{i.name}</span>
                    {i.region && <span style={{ fontSize: 11, color: "var(--text-3)", marginLeft: 6 }}>{i.region}</span>}
                  </Checkbox>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// What a person may do to the grid's columns, per application, kept in
// localStorage so a curated view survives a reload: which instance columns are
// hidden, the order of the instance columns and of the metadata columns, and
// any width they dragged (instance columns and metadata columns alike).
interface ColLayout {
  hidden: string[];
  order: string[];
  metaOrder: string[];
  widths: Record<string, number>;
  meta: Record<string, number>;
}
const emptyColLayout: ColLayout = { hidden: [], order: [], metaOrder: [], widths: {}, meta: {} };

// Resize limits. Below the minimum a column cannot show even a short value and
// the header controls collide; above the maximum one column starts pushing the
// rest of the fleet off the screen, which is the opposite of what the grid is
// for. Both are enforced during the drag, so the handle simply stops.
const COL_MIN = 96;
const COL_MAX = 560;
const clampCol = (w: number) => Math.min(Math.max(Math.round(w), COL_MIN), COL_MAX);

// The metadata columns, their default widths, and their default order. Only
// these three move: the parameter name is the row's identity and stays first
// (it is the fixed-left column the rest scrolls under).
// Whether a row has been retired, and so belongs after the live ones: 1 for a
// setting on its way out, 0 for everything still in service. A number rather
// than a boolean because it is the first key of a sort, and one day there may
// be a middle.
//
// Retired is asked two ways, because it is said two ways. The catalog can
// declare it (versionDeprecated), or a draft can stage it to stop being managed
// - and failing both, the CELLS can say it: a setting every instance's software
// version has left behind is retired whatever the catalog was told.
function retiredRank(r: Row): number {
  if (r.pendingUnmanage || r.param.versionDeprecated) return 1;
  const cells = Object.values(r.cells);
  return cells.length > 0 && cells.every((c) => c.state === "deprecated") ? 1 : 0;
}

// Widest reach to narrowest: the only order in which a scope column tells the
// reader anything.
const SCOPE_ORDER: Record<ScopeFacet, number> = { global: 0, site: 1, instance: 2 };
const SCOPE_ICON: Record<ScopeFacet, typeof ScopeGlobalOutlined> = {
  global: ScopeGlobalOutlined,
  site: ScopeSiteOutlined,
  instance: ScopeInstanceOutlined,
};

// Scope is wide enough for its longest label ("Instance-specific") plus its
// glyph. At 96 the tag ran out of its own column and into the description
// beside it, which is how a column of hundreds of rows turned into two columns
// of overlapping text.
const META_DEFAULTS: Record<string, number> = { param: 240, type: 104, scope: 150, desc: 140 };
const META_MOVABLE = ["type", "scope", "desc"];

// metaHeader wraps a plain column title with the same resize strip the instance
// headers carry, and makes the movable ones draggable.
function metaHeader(
  label: string,
  onResizeStart: (e: React.MouseEvent) => void,
  drag?: DragProps,
) {
  return (
    <div className="cf-col-head" {...(drag ?? {})}>
      <span>{label}</span>
      <span
        className="col-resize-handle"
        onMouseDown={(e) => {
          e.stopPropagation();
          onResizeStart(e);
        }}
        onClick={(e) => e.stopPropagation()}
        title="Drag to resize this column"
      />
    </div>
  );
}

// The handful of DOM props that make a header a drag source and a drop target.
// Reordering is one gesture in two places - the header itself and the column
// manager's list - so both build their handlers from the same helper.
type DragProps = {
  draggable: true;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
};
function dragProps(group: string, key: string, onReorder: (from: string, to: string) => void): DragProps {
  const mark = (el: EventTarget | null, on: boolean) => {
    const box = (el as HTMLElement | null)?.closest<HTMLElement>("[draggable]");
    box?.classList.toggle("cf-drop-target", on);
  };
  return {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", `${group}:${key}`);
    },
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes("text/plain")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      mark(e.currentTarget, true);
    },
    onDragLeave: (e) => mark(e.currentTarget, false),
    onDragEnd: (e) => mark(e.currentTarget, false),
    onDrop: (e) => {
      mark(e.currentTarget, false);
      const raw = e.dataTransfer.getData("text/plain");
      const [g, ...rest] = raw.split(":");
      const from = rest.join(":");
      if (g !== group || !from || from === key) return;
      e.preventDefault();
      e.stopPropagation();
      onReorder(from, key);
    },
  };
}

// move puts `from` where `to` is, keeping everything else in order.
function moveBefore(list: string[], from: string, to: string): string[] {
  const next = list.filter((k) => k !== from);
  const at = next.indexOf(to);
  if (at < 0) return list;
  next.splice(at, 0, from);
  return next;
}

function instanceHeader(
  inst: Instance,
  onResizeStart?: (e: React.MouseEvent) => void,
  /** the column exists only in the draft: staged to be added, or to be retired */
  staged?: "added" | "retiring",
  onDropStaged?: () => void,
  /** makes the header a drag handle for reordering the instance columns */
  drag?: DragProps,
) {
  return (
    <div style={{ lineHeight: 1.25, position: "relative" }} {...(drag ?? {})} title={drag ? "Drag to reorder this column" : undefined}>
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
      {/* A whole column that exists only in the draft says so ONCE, here, and
          carries the one action that undoes it. Its cells cannot: they have no
          change of their own behind them. It sits on the metadata line, left
          aligned, so it never lands under the column's resize strip. */}
      {staged ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 1 }}>
          <Tooltip
            title={
              staged === "added"
                ? "This instance is staged in your draft: it is not on Git yet. Its values come from the instance it was cloned from, and become real when the change is published."
                : "This instance is staged for retirement in your draft; it is still on Git until the change is published."
            }
          >
            <Tag
              color={staged === "added" ? "gold" : "red"}
              style={{ fontSize: 10, lineHeight: "15px", marginInlineEnd: 0 }}
            >
              {staged === "added" ? "new" : "retiring"}
            </Tag>
          </Tooltip>
          {onDropStaged && (
            <Tooltip
              title={
                staged === "added"
                  ? "Discard this staged instance and its column"
                  : "Keep this instance (undo the staged retirement)"
              }
            >
              <span
                role="button"
                aria-label={
                  staged === "added" ? "Discard this staged instance" : "Undo the staged retirement"
                }
                className="cell-undo-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDropStaged();
                }}
              >
                <UndoOutlined />
              </span>
            </Tooltip>
          )}
        </div>
      ) : (
        <div
          style={{ fontSize: 10, fontWeight: 400, opacity: 0.65 }}
          title={inst.versionName && inst.versionName !== inst.softwareVersion ? `Version ${inst.softwareVersion}` : undefined}
        >
          {inst.versionName || inst.softwareVersion}
          {inst.region ? ` · ${inst.region}` : ""}
        </div>
      )}
      {onResizeStart && (
        // A thin drag strip on the column's right edge. Dragging resizes the
        // column; the pointer-events guard keeps the header's select-column
        // click from firing during a resize.
        <span
          className="col-resize-handle"
          onMouseDown={(e) => {
            e.stopPropagation();
            onResizeStart(e);
          }}
          onClick={(e) => e.stopPropagation()}
          title="Drag to resize this column"
        />
      )}
    </div>
  );
}

export default function ParameterGrid({ grid }: { grid: Grid }) {
  const { categoryKey, setCategory, groupKey, setGroup, groupEdit, openGroupEditor, selectedParamId, selectParam, inspectParam, togglePin, unpinAll, selectedInstance, selectInstance, search, setSearch, filters, setFilters, prefs, setPrefs, jump, setJump, editorFocus, setEditorFocus, setFileFocus, setSection, panels, togglePanel, viewChangeId } =
    useUI();

  // Clicking a parameter row opens the details panel on it; clicking the same
  // parameter again collapses the panel. Value cells stop propagation (they
  // own click-to-edit), so editing a cell never toggles the panel.
  const toggleParamPanel = useCallback((id: string) => {
    if (selectedParamId === id && panels.right) {
      togglePanel("right");
      selectParam(null);
    } else {
      selectParam(id);
      if (!panels.right) togglePanel("right");
    }
  }, [selectedParamId, panels.right, togglePanel, selectParam]);
  const { message } = AntApp.useApp();
  const { token } = antdTheme.useToken();
  // What this person may do here. A viewer gets the grid without a single edit
  // affordance: no inline editors, no write actions in the cell menu, no
  // Add parameter, no Find & Replace. The service enforces the same rule, but
  // being refused after typing a value is not a permission model - it is a
  // trap, so the UI never offers what it knows will be refused.
  //
  // The same rule covers reading the grid THROUGH somebody else's change (see
  // ChangeViewPicker): those values are a proposal, not the workspace, and an
  // edit made on top of them would silently land in the reader's OWN draft
  // while the screen showed a different change's numbers - the worst possible
  // combination of "it looked like it worked" and "it went somewhere else".
  const { canEdit: mayEdit } = useIdentity();
  const canEdit = mayEdit && !grid.viewing?.readOnly;
  const qc = useQueryClient();
  const presetsQ = useRepoQuery({ queryKey: ["presets"], queryFn: api.presets });
  const draftQ = useRepoQuery({ queryKey: ["draft"], queryFn: api.draft });
  // The change this grid is being READ THROUGH, when it is not the workspace
  // (see ChangeViewPicker). The server has already applied its edits to the
  // cell VALUES; what is fetched here is the item list, which is what every
  // other answer on this screen is built from.
  const viewedQ = useRepoQuery({
    queryKey: ["change", viewChangeId],
    queryFn: () => api.change(viewChangeId as number),
    enabled: viewChangeId != null,
  });

  // THE pending edits this grid is showing, and the single place that decides
  // whose they are.
  //
  // Everything downstream reads from this: which cells are highlighted as
  // changed, the before -> after on hover, the per-row status pills, the
  // Changed / Added / Removed filter, the instance columns a change would add
  // or retire. All of it used to come straight off the reader's OWN draft, and
  // that was invisible until the grid could be pointed at somebody else's
  // change - at which point the screen said "CR-3" in the bar, showed CR-3's
  // values in the cells, and highlighted, filtered and explained the reader's
  // own unrelated draft on top of them. Two changes' answers in one picture,
  // with nothing saying which was which.
  //
  // While a viewed change is still loading this is EMPTY rather than the
  // draft's items: a flash of the wrong change's highlights is the same lie,
  // just briefer.
  const shownItems = useMemo<ChangeItem[]>(() => {
    if (viewChangeId != null) return viewedQ.data?.items ?? [];
    return draftQ.data?.draft?.items ?? [];
  }, [viewChangeId, viewedQ.data, draftQ.data]);
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
  // "set this value on many instances" picker, opened from a cell's menu
  const [bulkSet, setBulkSet] = useState<{ param: Parameter; value: unknown; from: string } | null>(null);
  // Single-instance view: pick one instance and the matrix collapses to a
  // Parameter / Value / Source / Changed sheet for that instance alone.
  // Single-instance view. It initializes from the ?inst= selection so a
  // handoff ("open the configuration for THIS instance", from topology or the
  // global Instances page) lands on an already-filtered sheet, and it writes
  // back through selectInstance so the URL always reflects the filter.
  const [viewInstance, setViewInstance] = useState<string | null>(
    () => useUI.getState().selectedInstance,
  );
  // There is no separate environment filter any more: "all production" is three
  // ticks in the instance picker, not a mode the grid goes into, so one piece of
  // state (colLayout.hidden) answers "which instances" however it was chosen.
  // Per-application column layout the user controls: which instance columns
  // are hidden, their order, and manual width overrides (drag-resized). All
  // persisted so a curated view survives reloads. Keyed by repo so switching
  // applications never leaks one layout onto another.
  const repoId = useUI.getState().repoId ?? "default";
  const COLS_KEY = `configer.cols.${repoId}`;
  const [colLayout, setColLayout] = useState<ColLayout>(() => {
    try {
      const raw = localStorage.getItem(COLS_KEY);
      if (raw) return { ...emptyColLayout, ...JSON.parse(raw) };
    } catch {
      // corrupted layout: start fresh
    }
    return emptyColLayout;
  });
  const patchColLayout = (p: Partial<ColLayout>) =>
    setColLayout((c) => {
      const next = { ...c, ...p };
      localStorage.setItem(COLS_KEY, JSON.stringify(next));
      return next;
    });
  const hiddenInstances = useMemo(() => new Set(colLayout.hidden), [colLayout.hidden]);
  const [instOpen, setInstOpen] = useState(false);
  // Live drag width while resizing a column header (committed to colLayout on
  // mouse-up); null when no resize is in progress.
  const [resizing, setResizing] = useState<{ name: string; width: number } | null>(null);
  // Draft-status filter pills (All / Changed / Added / Removed).
  const [pill, setPill] = useState<"all" | "changed" | "added" | "removed">("all");
  // Which SCOPE of settings the grid is showing. "How widely does an edit
  // land" is the first question anybody has in front of a fleet, and a row of
  // identical values cannot answer it: twelve columns reading "example.com"
  // look the same whether that is one shared line or twelve copies. So it is a
  // dimension of the view, not a column somebody sorts by.
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  // one-shot flash highlight after a jump from the left-hand trees, the
  // health map, or an application's details panel (kind "cell": row+column)
  const [flash, setFlash] = useState<{ kind: "param" | "instance" | "cell"; id: string; inst?: string; n?: number } | null>(null);
  // A brief success pulse on the cell(s) an edit just staged, so a save reads as
  // "done" without a toast. inst "" pulses every cell of a global edit.
  const [saved, setSaved] = useState<{ param: string; inst: string } | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashSaved = (paramId: string, instance: string) => {
    setSaved({ param: paramId, inst: instance });
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(null), 900);
  };
  // Keyboard navigation: the cell the arrow keys act on (by ids, so it survives
  // sorting/filtering). A single click selects it; Enter/F2 edits; Esc clears.
  const [active, setActive] = useState<{ param: string; inst: string } | null>(null);
  // Find & Replace dialog (opened from the toolbar or a cell's right-click)
  const [findReplace, setFindReplace] = useState<{ find: string } | null>(null);
  // The single-row toolbar's overflow menu and the legend dialog.
  const [moreOpen, setMoreOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  // The toolbar keeps to exactly one row: its width is measured and the
  // lowest-priority controls fold into the overflow (⋮) menu, in order, as
  // space runs out. Essentials (instance, filters, search, the primary
  // action) always stay visible.
  const { ref: barRef, width: barW } = useElementSize<HTMLDivElement>();
  const tableRef = useRef<GetRef<typeof Table>>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // pending draft items indexed by cell, for hover before→after and undo;
  // a global item is stored under `${paramId}|` (empty instance)
  const pendingMap = useMemo(() => {
    const m = new Map<string, ChangeItem>();
    for (const it of shownItems) {
      m.set(`${it.paramId}|${it.instance}`, it);
    }
    return m;
  }, [shownItems]);

  const revert = useMutation({
    mutationFn: (p: { paramId: string; instance: string }) => api.revertValue(p.paramId, p.instance),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
      qc.invalidateQueries({ queryKey: ["render"] });
    },
  });
  // Stop managing a parameter. It rewrites .configer/parameters.yaml, so it is
  // a change like any other: staged on the draft and applied when that change
  // is published. The heavier "retire everywhere" (which also deletes the key
  // from every file) stays where it was, in the details panel, because the two
  // must never be one slip apart.
  const [unmanaging, setUnmanaging] = useState<Parameter | null>(null);
  const unmanage = useMutation({
    mutationFn: (id: string) => api.unmanageParameter(id, "Local user"),
    onSuccess: () => {
      setUnmanaging(null);
      qc.invalidateQueries();
      message.success("Staged: it stops being managed when this change is published.");
    },
    onError: (e: Error) => message.error(e.message),
  });

  // Fan-out write: stage the same value on many instances in ONE request (the
  // whole reason a grid beats editing files one by one). The backend reports
  // per-target results, so a rejection on one instance still stages the rest.
  const bulkSave = useMutation({
    mutationFn: (p: { paramId: string; value: unknown; targets: string[] }) =>
      api.bulkSetValue({ paramId: p.paramId, edits: p.targets.map((t) => ({ instance: t, value: p.value })) }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
      qc.invalidateQueries({ queryKey: ["render"] });
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length) {
        message.warning(`Set on ${res.staged}; ${failed.length} could not be set (${failed[0].error})`);
      } else {
        message.success(`Set on ${res.staged} instance${res.staged === 1 ? "" : "s"}`);
      }
      setBulkSet(null);
    },
    onError: (e: Error) => message.error(`Rejected: ${e.message}`),
  });

  // body: the area the virtualized table body may occupy (auto-fits height/width)
  const { ref: bodyRef, width: bodyW, height: bodyH } = useElementSize<HTMLDivElement>();

  const save = useMutation({
    mutationFn: (p: ValueEdit) => api.setValue(p),
    // The edit is staged in the caches before the request goes out, so the cell
    // shows its new value on the next frame instead of after a write round trip
    // plus a full grid refetch. The invalidations below reconcile it.
    onMutate: async (vars) => {
      const snapshot = await stageEdit(qc, vars);
      flashSaved(vars.paramId, vars.scope === "global" ? "" : vars.instance);
      return snapshot;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
      qc.invalidateQueries({ queryKey: ["render"] });
    },
    onError: (e: Error, vars, snapshot) => {
      if (e instanceof OfflineError) {
        // Service unreachable: keep the edit on this device (and on screen, as
        // the message promises); it syncs when the connection returns.
        enqueueEdit(vars);
        message.info("Saved on this device; it will sync when the service is reachable again.");
        return;
      }
      // Rejected: put the cell back exactly as it was, so the grid never shows
      // a value the service refused.
      if (snapshot) unstageEdit(qc, snapshot);
      message.error(`Rejected: ${e.message}`);
    },
  });

  // Canonical order matching the left parameter tree - by walking the very same
  // tree, which is the only way the two can be guaranteed to agree.
  //
  // Catalog order is not enough, because the panel is a TRIE and therefore
  // hoists: it draws every row of a group where that group first appears, and a
  // setting written into two files keeps the position of the first and the name
  // of the other. So the last leaf in the panel sat nowhere near the last row of
  // the table, and clicking a row below it jumped to the middle of the panel.
  const treeOrder = useMemo(
    () => nameTreeOrder(buildNameTree(grid.rows.map((r) => r.param))),
    [grid.rows],
  );

  // The instance columns currently on screen: the user's chosen order and
  // visibility, then the environment filter and single-instance view on top.
  // The single-instance view ignores hide/order (it is exactly one column).
  // Widths stay derived from ALL instances so switching filters never
  // re-lays-out the columns.
  const orderedInstances = useMemo(() => {
    const pos = new Map(colLayout.order.map((n, i) => [n, i]));
    return [...grid.instances].sort(
      (a, b) => (pos.get(a.name) ?? 1e9) - (pos.get(b.name) ?? 1e9),
    );
  }, [grid.instances, colLayout.order]);
  // The movable metadata columns in the user's order, with any newly added one
  // appended (and anything stale dropped).
  const metaOrder = useMemo(() => {
    const saved = colLayout.metaOrder.filter((k) => META_MOVABLE.includes(k));
    return [...saved, ...META_MOVABLE.filter((k) => !saved.includes(k))];
  }, [colLayout.metaOrder]);
  // Which instance columns the grid draws. One rule: the picker's ticks, in the
  // picker's order. Reading one instance as a sheet is the single exception -
  // that is a different presentation of one instance, not a filter, so it shows
  // its instance whether or not the tick is on.
  const visibleInstances = useMemo(
    () =>
      (viewInstance ? grid.instances : orderedInstances).filter((i) =>
        viewInstance ? i.name === viewInstance : !hiddenInstances.has(i.name),
      ),
    [grid.instances, orderedInstances, viewInstance, hiddenInstances],
  );

  // Draft items per parameter, for the status pills and the Changed column.
  const pendingByParam = useMemo(() => {
    const m = new Map<string, ChangeItem[]>();
    for (const it of shownItems) {
      if (!it.paramId) continue;
      const arr = m.get(it.paramId) ?? [];
      arr.push(it);
      m.set(it.paramId, arr);
    }
    return m;
  }, [shownItems]);
  // Instances that exist only in the draft (staged add) or are staged for
  // removal. Their columns are previewed wholesale by the service, so their
  // cells carry `pending` without any per-cell change behind them - which is
  // why nothing here may offer a per-cell undo for them.
  const pendingInstances = useMemo(() => {
    const m = new Map<string, "added" | "retiring">();
    for (const it of shownItems) {
      if (it.action === "add-instance") m.set(it.instance, "added");
      else if (it.action === "remove-instance") m.set(it.instance, "retiring");
    }
    return m;
  }, [shownItems]);

  // The one answer to "does THIS cell carry a change of its own?". A global
  // edit surfaces on every cell it would affect; a staged instance's cells are
  // marked pending by the preview but have nothing of their own behind them,
  // which is why they must not be highlighted or offer an undo.
  const itemFor = useMemo(
    () => (paramId: string, instance: string, source?: string) =>
      pendingMap.get(`${paramId}|${instance}`) ??
      (source === "base" || source === "default" ? pendingMap.get(`${paramId}|`) : undefined),
    [pendingMap],
  );

  const isAdded = (it: ChangeItem) =>
    (it.old == null || it.old === "") && (!it.action || it.action === "set");
  const isRemoved = (it: ChangeItem) =>
    it.action === "exclude" || it.action === "reset" || it.action === "remove-instance";

  // Each row's scope facet, worked out once per catalog rather than per render:
  // it reads bindings, and it is asked by the filter, the counts and the column
  // on every keystroke.
  const facetOf = useMemo(() => {
    const m = new Map<string, ScopeFacet>();
    for (const r of grid.rows) m.set(r.param.id, effectiveScope(r.param));
    return m;
  }, [grid.rows]);
  const facet = useCallback(
    (r: Row): ScopeFacet => facetOf.get(r.param.id) ?? effectiveScope(r.param),
    [facetOf],
  );

  // The rows of the branch the reader clicked in the tree. Clicking a group
  // POINTS at it - the rest of the estate stays on screen - so this is a set of
  // ids to mark, never a filter. Computed off the catalog, not the filtered
  // list, so marks do not appear and disappear as somebody types in the search
  // box.
  const groupHits = useMemo(() => {
    const hits = new Set<string>();
    if (!groupKey) return hits;
    for (const r of grid.rows) if (inGroup(r.param, groupKey)) hits.add(r.param.id);
    return hits;
  }, [grid.rows, groupKey]);

  const q = search.trim().toLowerCase();
  // What the grid acts on: the search box stays instant to type in, but
  // filtering 800 rows, rebuilding every column and re-rendering the sheet on
  // each keystroke made the box itself feel like treacle. The pause is the one
  // a person makes between typing and expecting an answer.
  const lq = useDebounced(localQ, 140).trim().toLowerCase();
  // Which files the grid is restricted to. A Set, because this is asked once
  // per row on every keystroke and an array scan over a dozen files is not.
  const fileFilter = useMemo(() => new Set(filters.files), [filters.files]);
  const baseRows = useMemo(() => {
    const filtered = grid.rows.filter((r) => {
      // categoryKey is a dotted NAME prefix selected in the tree.
      if (categoryKey && r.param.name !== categoryKey && !r.param.name.startsWith(categoryKey + "."))
        return false;
      if (scopeFilter !== "all" && facet(r) !== scopeFilter) return false;
      if (q && !rowMatches(r, q, searchScope)) return false;
      if (lq && !rowMatches(r, lq, searchScope)) return false;
      // A parameter belongs to a file if ANY of its bindings lives there: a
      // deduplicated setting is genuinely part of every file it writes to.
      if (fileFilter.size && !bindingsOf(r.param).some((b) => fileFilter.has(b.file))) return false;
      const cells = Object.values(r.cells);
      if (filters.invalidOnly && !cells.some((c) => !c.valid)) return false;
      if (filters.overriddenOnly && !cells.some((c) => c.set && c.source === "instance")) return false;
      if (filters.hideNA && cells.every((c) => c.state === "na")) return false;
      return true;
    });
    // Retired settings sink. A parameter the product has deprecated, or one a
    // draft has staged to stop managing, is still real - it is still in files,
    // it can still be read, and hiding it would be a lie about the repository.
    // But it is not what anybody is working on, and interleaved with the live
    // ones it puts dead rows between two settings somebody is comparing. So it
    // keeps its place in the tree order, at the end.
    filtered.sort(
      (a, b) =>
        retiredRank(a) - retiredRank(b) ||
        (treeOrder.get(a.param.id) ?? 0) - (treeOrder.get(b.param.id) ?? 0),
    );
    return filtered;
  }, [grid.rows, categoryKey, q, lq, filters, fileFilter, searchScope, treeOrder, scopeFilter, facet]);

  // How many settings sit at each scope. Counted over ALL rows for the same
  // reason the file counts are: what the estate holds is a fact about the
  // estate, and a number that moved while you were choosing from it would be
  // describing the answer rather than the choice.
  const scopeCounts = useMemo(() => {
    const n: Record<ScopeFacet, number> = { global: 0, site: 0, instance: 0 };
    for (const r of grid.rows) n[facetOf.get(r.param.id) ?? "instance"]++;
    return n;
  }, [grid.rows, facetOf]);

  // Every file the catalog writes to, with how many parameters each carries.
  // Counted over ALL rows, never the filtered ones: the counts are a property
  // of the estate, and numbers that moved while you picked from them would be
  // describing the answer rather than the choice.
  const fileChoices = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of grid.rows) {
      for (const f of new Set(bindingsOf(r.param).map((b) => b.file))) {
        counts.set(f, (counts.get(f) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([file, count]) => ({ file, count }));
  }, [grid.rows]);

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

  // Pinned parameters are held OUT of the scrolling list and drawn in a sticky
  // block directly under the header, so they stay on screen however far down the
  // grid goes. Sorting them to the top was the first attempt and it is not what
  // pinning means: they scrolled away with everything else, which is exactly the
  // moment you wanted them.
  const pinnedSet = useMemo(() => new Set(prefs.pinned), [prefs.pinned]);
  // Which steps of each row's route tell it apart from the other rows with the
  // same leaf. One pass over the catalog, not per render and not per row.
  const routeKeys = useMemo(() => discriminatingSegments(grid.rows), [grid.rows]);
  const dropPinned = useCallback(
    (list: Row[]) => (prefs.pinned.length ? list.filter((r) => !pinnedSet.has(r.param.id)) : list),
    [prefs.pinned.length, pinnedSet],
  );

  // Open the file this parameter lives in, at the line it lives on. The exact
  // line is resolved from the file itself - a binding records one at scan time,
  // but the file has been edited since - and a miss opens the file at the top
  // rather than refusing to go.
  const openInFiles = async (param: Parameter) => {
    const file = fileFor(param);
    const b = bindingsOf(param)[0];
    if (!file || !b) return;
    let line: number | undefined = b.line || undefined;
    try {
      line = (await api.locate(file, b.path, b.format)).line || line;
    } catch {
      // ignore: the file still opens, just not on the line
    }
    setFileFocus({
      path: file,
      line,
      instance: viewInstance ?? selectedInstance ?? undefined,
      param: param.name,
      allInstances: true,
    });
    setSection("files");
  };

  // Which file a parameter's value lives in, expanded for the instance in view
  // (a binding's path templates {folder}/{instance}).
  const fileFor = useCallback(
    (param: Parameter): string | undefined => {
      const b = bindingsOf(param)[0];
      if (!b) return undefined;
      const name = viewInstance ?? selectedInstance ?? grid.instances[0]?.name;
      const inst = grid.instances.find((i) => i.name === name);
      return expandBinding(b, inst);
    },
    [grid.instances, viewInstance, selectedInstance],
  );

  const rows = useMemo(() => {
    const pilled = baseRows.filter((r) => {
      if (pill === "all") return true;
      const items = pendingByParam.get(r.param.id) ?? [];
      if (pill === "changed") return items.length > 0;
      if (pill === "added") return items.some(isAdded);
      return items.some(isRemoved);
    });
    if (prefs.groupBy === "none") return dropPinned(pilled);
    // Clustering: rows that share a signature are brought next to each other.
    // By VALUE the signature is what the parameter is set to across the fleet;
    // by PATH it is the category the parameter lives under. Either way groups
    // keep the order they first appear in, which is the catalog's order, so the
    // grid still reads the way the parameter tree and the file do.
    const bySig = new Map<string, Row[]>();
    const order: string[] = [];
    for (const r of pilled) {
      const s = groupSig(r, prefs.groupBy, grid.instances);
      if (!bySig.has(s)) {
        bySig.set(s, []);
        order.push(s);
      }
      bySig.get(s)!.push(r);
    }
    return dropPinned(order.flatMap((s) => bySig.get(s)!));
  }, [baseRows, pill, pendingByParam, prefs.groupBy, grid.instances, dropPinned]);

  // Visual metadata for grouping: for each row in a group of more than one, its
  // cycling colour and whether it opens or closes the group's box. A group of
  // one is not banded - a band around a single row says nothing.
  const groupMeta = useMemo(() => {
    if (prefs.groupBy === "none") return null;
    const counts = new Map<string, number>();
    const sigs = rows.map((r) => groupSig(r, prefs.groupBy, grid.instances));
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
  }, [rows, prefs.groupBy, grid.instances]);

  // Metadata column widths: the user's if they have dragged one, otherwise the
  // default. Type/Scope hold short tags; Description is a supporting hint (the
  // full text is always in the details panel), so both stay narrow by default
  // and the instance columns - the point of the grid - get the width budget.
  const metaW = (key: string) => (resizing?.name === key ? resizing.width : colLayout.meta[key] ?? META_DEFAULTS[key]);
  const PARAM_W = metaW("param");
  const TYPE_W = prefs.showTypeCol ? metaW("type") : 0;
  const SCOPE_W = prefs.showScopeCol ? metaW("scope") : 0;
  const DESC_W = prefs.showDescCol ? metaW("desc") : 0;
  const fixedW = PARAM_W + TYPE_W + SCOPE_W + DESC_W;

  // Auto-fit, ONCE. Sizing every instance column to its longest value is a pass
  // over the whole grid (instances x rows), and it used to run again on every
  // edit, every refetch and every pixel of a window resize - each one throwing
  // away the widths object and re-rendering every column behind it. It now runs
  // when the estate's SHAPE changes (an instance arrives or leaves) and not one
  // time more; in between, the same object is handed back, so nothing
  // downstream re-computes. Widths staying put while you work is also simply
  // what a sheet should do.
  const instSig = useMemo(() => grid.instances.map((i) => i.name).join("\u0000"), [grid.instances]);
  const [autoFit, setAutoFit] = useState<AutoFit>(() => ({ sig: "", rows: 0, width: 0, widths: {} }));
  useEffect(() => {
    // Fit when there is something to fit: a new instance set, the rows finally
    // arriving, or the container reporting a real width for the first time.
    // Never on a later resize - the widths a person is working with must not
    // shuffle under them because the window moved, and rebuilding the columns
    // on every pixel of a drag re-renders every cell in the sheet, which is
    // where the slowness came from.
    const fresh = autoFit.sig !== instSig || (autoFit.rows === 0 && grid.rows.length > 0) || (autoFit.width === 0 && bodyW > 0);
    if (!fresh) return;
    setAutoFit({
      sig: instSig,
      rows: grid.rows.length,
      width: bodyW,
      widths: fitColumns(grid.instances, grid.rows, bodyW - fixedW),
    });
    // fixedW is the metadata columns' share; it is read at fit time on purpose,
    // so dragging one later does not re-fit the instance columns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instSig, autoFit.sig, autoFit.rows, autoFit.width, grid.instances, grid.rows, bodyW]);
  const autoWidths = autoFit.widths;

  // The widths actually used: the fitted ones, with a dragged width winning
  // over the fit and the live drag winning over both, so header, body and
  // scroll math move together. One pass over the instances, and it only re-runs
  // when a width really changes.
  const instWidths = useMemo(() => {
    const need = { ...autoWidths };
    for (const [k, w] of Object.entries(colLayout.widths)) need[k] = w;
    if (resizing) need[resizing.name] = resizing.width;
    return need;
  }, [autoWidths, colLayout.widths, resizing]);

  // startResize begins a column-width drag: track the pointer, feed the live
  // width through (so header + body + scroll math move together), and commit to
  // the persisted layout on mouse-up. `meta` says which bucket it belongs to;
  // both are clamped to the same limits.
  const startResize = (name: string, startWidth: number, meta = false) => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    let liveWidth = startWidth;
    const onMove = (ev: MouseEvent) => {
      liveWidth = clampCol(startWidth + (ev.clientX - startX));
      setResizing({ name, width: liveWidth });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      patchColLayout(
        meta
          ? { meta: { ...colLayout.meta, [name]: Math.round(liveWidth) } }
          : { widths: { ...colLayout.widths, [name]: Math.round(liveWidth) } },
      );
      setResizing(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Reordering, from a header drag or from the column manager's list.
  const reorderInstances = (from: string, to: string) => {
    const current = orderedInstances.map((i) => i.name);
    patchColLayout({ order: moveBefore(current, from, to) });
  };
  const reorderMeta = (from: string, to: string) => {
    const current = metaOrder;
    patchColLayout({ metaOrder: moveBefore(current, from, to) });
  };

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
      // Center the target row rather than pinning it near the top. The virtual
      // body's holder is a native vertical scroller (see index.css), and
      // antd's scrollTo({index}) is a no-op here, so drive scrollTop directly:
      // row top minus half a viewport (plus half a row), clamped at 0.
      const root = rootRef.current;
      const holder = root?.querySelector<HTMLElement>(".ant-table-tbody-virtual-holder");
      const rowH =
        root?.querySelector<HTMLElement>(".ant-table-tbody-virtual .ant-table-row")?.getBoundingClientRect()
          .height || (prefs.density === "compact" ? 39 : 48);
      if (holder) {
        holder.scrollTop = Math.max(idx * rowH - holder.clientHeight / 2 + rowH / 2, 0);
      } else {
        tableRef.current?.scrollTo({ index: Math.max(idx - 4, 0) });
      }
      selectParam(jump.id);
      if (jump.kind === "cell" && jump.inst) scrollToInstance(jump.inst);
    } else {
      consumedJump.current = jump.n;
      scrollToInstance(jump.id);
    }
    setFlash({ kind: jump.kind, id: jump.id, inst: jump.inst, n: jump.n });
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

  // Marking a branch is no use if it is eight hundred rows below the fold, so
  // the grid scrolls to the first of its rows. No flash: the wash already says
  // where they are, and a row that pulses as well reads as "this one" when the
  // reader asked about all of them.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!groupKey) {
      scrolledTo.current = null;
      return;
    }
    if (scrolledTo.current === groupKey) return;
    const idx = rows.findIndex((r) => groupHits.has(r.param.id));
    if (idx < 0) return; // not in the filtered list; nothing to scroll to
    scrolledTo.current = groupKey;
    const root = rootRef.current;
    const holder = root?.querySelector<HTMLElement>(".ant-table-tbody-virtual-holder");
    if (!holder) return;
    const rowH =
      root?.querySelector<HTMLElement>(".ant-table-tbody-virtual .ant-table-row")?.getBoundingClientRect()
        .height || (prefs.density === "compact" ? 39 : 48);
    holder.scrollTop = Math.max(idx * rowH - rowH, 0);
  }, [groupKey, groupHits, rows, prefs.density]);

  // The pinned rows, in the order they were pinned. Taken from the FULL set
  // rather than the filtered one: a pin means "keep this in front of me", and a
  // search that happens not to match it should not take it away.
  const pinnedRows = useMemo(() => {
    if (!prefs.pinned.length) return [] as Row[];
    const byId = new Map(baseRows.map((r) => [r.param.id, r]));
    return prefs.pinned.map((id) => byId.get(id)).filter((r): r is Row => !!r);
  }, [prefs.pinned, baseRows]);

  const columns: ColumnsType<Row> = useMemo(() => {
    const types = [...new Set(grid.rows.map((r) => r.param.type))].sort();
    const base: ColumnsType<Row> = [
      {
        title: metaHeader("Parameter", startResize("param", PARAM_W, true)),
        dataIndex: ["param", "name"],
        key: "param",
        fixed: "left",
        width: PARAM_W,
        ellipsis: { showTitle: false },
        sorter: (a, b) => a.param.name.localeCompare(b.param.name),
        render: (_v, r) => (
          // The name column is a fixed width, so the cell shows the leaf and
          // the route to it on separate lines rather than one truncated string
          // (see leafOf/routeOf); the full name is on hover either way.
          // Right-clicking it acts on the PARAMETER (the whole row), which is a
          // different set of actions from right-clicking one of its values.
          <ParamMenu
            canEdit={canEdit}
            pinned={pinnedSet.has(r.param.id)}
            pinnedCount={prefs.pinned.length}
            fileLabel={fileFor(r.param)?.split("/").pop()}
            onDetails={() => inspectParam(r.param.id, "overview")}
            onValidation={() => inspectParam(r.param.id, "rules")}
            onHistory={() => inspectParam(r.param.id, "history")}
            onOpenFile={fileFor(r.param) ? () => void openInFiles(r.param) : undefined}
            onTogglePin={() => togglePin(r.param.id)}
            onUnpinAll={unpinAll}
            onUnmanage={() => setUnmanaging(r.param)}
          >
            {/* A NATIVE title, not a Tooltip. The floating tooltip opened on
                the same pointer that opens the context menu and covered the
                first item of it; the browser's own tip waits, and gets out of
                the way the moment a menu appears. */}
            <div className="cf-pname" title={r.param.name}>
              <div className="cf-pname-top">
                {pinnedSet.has(r.param.id) && (
                  <Tooltip title="Pinned to the top of the grid">
                    <PushpinFilled style={{ color: "var(--c-review)", fontSize: 11, flexShrink: 0 }} />
                  </Tooltip>
                )}
                {r.param.secret && <LockOutlined style={{ color: c.pending, flexShrink: 0 }} />}
                <span
                  className="cf-pname-leaf"
                  style={r.pendingUnmanage ? { textDecoration: "line-through", opacity: 0.65 } : undefined}
                >
                  {hl(leafOf(r.param), hlParam)}
                </span>
                {r.pendingUnmanage && (
                  <Tooltip title="A change in your draft stops managing this parameter. It leaves the grid when that change is published; every value stays in the files.">
                    <Tag color="orange" style={{ fontSize: 10, lineHeight: "16px", marginInlineStart: 2, flexShrink: 0 }}>
                      unmanaging
                    </Tag>
                  </Tooltip>
                )}
                {r.pendingAdd && (
                  <Tooltip title="A file edit in your draft added this setting. Configer starts managing it when that change is published, so it is not editable from the grid yet - change it in file mode.">
                    <Tag color="green" style={{ fontSize: 10, lineHeight: "16px", marginInlineStart: 2, flexShrink: 0 }}>
                      new
                    </Tag>
                  </Tooltip>
                )}
                {bindingsOf(r.param).length === 0 && (
                  <Tooltip title="Design phase: not attached to a configuration file yet. Attach it to real file locations from the details panel.">
                    <Tag color="purple" style={{ fontSize: 10, lineHeight: "16px", marginInlineStart: 2, flexShrink: 0 }}>
                      design
                    </Tag>
                  </Tooltip>
                )}
              </div>
              {/* The route to the leaf, in the same cell. Always rendered (empty
                  when a name has no route) so every row is the same height in
                  the virtual body. The steps that tell this row apart from the
                  others with the same leaf carry the weight; the shared ones
                  stay quiet. */}
              <div className="cf-pname-route">
                <bdi>
                  <Route param={r.param} keys={routeKeys.get(r.param.id)} q={hlParam} />
                </bdi>
              </div>
            </div>
          </ParamMenu>
        ),
      },
    ];
    const meta: Record<string, ColumnsType<Row>[number]> = {};
    if (prefs.showTypeCol) {
      meta.type = ({
        title: metaHeader("Type", startResize("type", TYPE_W, true), dragProps("meta", "type", reorderMeta)),
        key: "type",
        width: TYPE_W,
        sorter: (a, b) => a.param.type.localeCompare(b.param.type),
        filters: types.map((t) => ({ text: t, value: t })),
        onFilter: (v, r) => r.param.type === v,
        render: (_v, r) => (
          <Tooltip title={r.param.type === "list" && r.param.itemType ? `List of ${r.param.itemType} values` : undefined}>
            <Tag>{typeLabel(r.param.type, r.param.itemType)}</Tag>
          </Tooltip>
        ),
      });
    }
    if (prefs.showScopeCol) {
      meta.scope = ({
        title: metaHeader("Scope", startResize("scope", SCOPE_W, true), dragProps("meta", "scope", reorderMeta)),
        key: "scope",
        width: SCOPE_W,
        // Widest reach first: global, then a group, then one system. That is
        // the order the column means something in - alphabetical would put
        // "global" between "environment" and "instance" and say nothing.
        sorter: (a, b) => SCOPE_ORDER[facet(a)] - SCOPE_ORDER[facet(b)],
        filters: (["global", "site", "instance"] as ScopeFacet[])
          .filter((f) => scopeCounts[f] > 0)
          .map((f) => ({ text: SCOPE_META[f].label, value: f })),
        onFilter: (v, r) => facet(r) === v,
        render: (_v, r) => {
          const f = facet(r);
          const Icon = SCOPE_ICON[f];
          return (
            // The declared scope is named in full on hover when it says more
            // than the facet does: "zone" and "environment" are both groups,
            // and which grouping is meant is exactly what the reader wants
            // before they change the value.
            <Tooltip title={`${SCOPE_META[f].explain}${r.param.scope && r.param.scope !== f ? ` (declared "${r.param.scope}")` : ""}`}>
              <Tag
                color={SCOPE_META[f].color}
                style={{ marginInlineEnd: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}
              >
                <Icon style={{ marginInlineEnd: 4 }} />
                {SCOPE_META[f].label}
              </Tag>
            </Tooltip>
          );
        },
      });
    }
    if (prefs.showDescCol) {
      meta.desc = ({
        title: metaHeader("Description", startResize("desc", DESC_W, true), dragProps("meta", "desc", reorderMeta)),
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
    for (const key of metaOrder) if (meta[key]) base.push(meta[key]);
    const instanceNames = grid.instances.map((i) => i.name);
    const instCols: ColumnsType<Row> = visibleInstances.map((inst) => ({
      title: viewInstance
        ? "Value"
        : instanceHeader(
            inst,
            startResize(inst.name, instWidths[inst.name] ?? 150),
            pendingInstances.get(inst.name),
            canEdit && pendingInstances.has(inst.name)
              ? () => revert.mutate({ paramId: "", instance: inst.name })
              : undefined,
            dragProps("inst", inst.name, reorderInstances),
          ),
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
          // The changed marker goes on the CELL (a hairline down its leading
          // edge, see .cell-changed) and only where a change of this cell's own
          // exists - so a staged instance's whole column is not marked for a
          // change that belongs to the instance, not to any cell in it.
          (itemFor(r.param.id, inst.name, r.cells[inst.name]?.source)
            ? r.cells[inst.name]?.valid === false
              ? " cell-changed cell-changed-bad"
              : " cell-changed"
            : "") +
          (flash?.kind === "cell" && flash.id === r.param.id && flash.inst === inst.name
            ? " cell-flash"
            : "") +
          (saved && saved.param === r.param.id && (saved.inst === "" || saved.inst === inst.name)
            ? " cell-saved"
            : "") +
          (active && active.param === r.param.id && active.inst === inst.name ? " cell-active" : ""),
        // Value cells own click-to-edit; keep the click here so it never
        // bubbles up to the row handler and collapses the details panel. A
        // single click also selects the cell for keyboard navigation.
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
          setActive({ param: r.param.id, inst: inst.name });
        },
      }),
      render: (_v, r) => {
        const key = `${r.param.id}|${inst.name}`;
        const cell = r.cells[inst.name];
        const pendingItem = itemFor(r.param.id, inst.name, cell?.source);
        return (
          <EditableCell
            cell={cell}
            param={r.param}
            instance={inst.name}
            allInstances={instanceNames}
            presets={presetsQ.data}
            pendingItem={pendingItem}
            // Reading the grid THROUGH a change makes before -> after the point
            // of the screen rather than a preference: somebody who has pointed
            // the page at CR-3 is asking what CR-3 did, and a cell showing only
            // the value it would end up at answers a different question. The
            // saved preference is untouched, so returning to Main returns to
            // whatever this person normally reads.
            beforeAfter={prefs.showBeforeAfter || viewChangeId != null}
            canEdit={canEdit}
            revertible={!!pendingItem}
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
            onBulkSet={() => setBulkSet({ param: r.param, value: cell?.value, from: inst.name })}
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
              const label =
                c.source === "instance" ? "Local" : c.source === "base" ? "Base" : c.source === "derived" ? "Derived" : "Default";
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
  }, [grid.instances, visibleInstances, viewInstance, grid.rows, editing, presetsQ.data, itemFor, pendingByParam, pendingInstances, canEdit, prefs.showTypeCol, prefs.showScopeCol, prefs.showDescCol, prefs.showBeforeAfter, viewChangeId, pinnedSet, fileFor, instWidths, metaOrder, PARAM_W, TYPE_W, SCOPE_W, DESC_W, flash, saved, active, selectedInstance, hlParam, hlDesc, facet, scopeCounts]);

  const scrollX =
    PARAM_W + TYPE_W + SCOPE_W + DESC_W + (viewInstance ? 190 : 0) +
    visibleInstances.reduce((a, i) => a + (instWidths[i.name] ?? 150), 0);
  const headerH = prefs.density === "compact" ? 55 : 63;
  const title = categoryKey ? categoryKey.split(".").pop() : "All Parameters";
  const activeFilters =
    Number(filters.invalidOnly) +
    Number(filters.overriddenOnly) +
    Number(filters.hideNA) +
    Number(filters.files.length > 0);

  // Any dimension that narrows the visible rows. Several are independent (the
  // parameter tree's category, the Changed/Added/Removed pill, the row filters,
  // and both search boxes), so "All Parameters" alone never guarantees the full
  // list. A single count-with-Clear makes the narrowing visible and gives one
  // reliable way back to everything.
  const total = grid.rows.length;
  const isFiltered =
    !!categoryKey || pill !== "all" || scopeFilter !== "all" || !!q || !!lq || activeFilters > 0;
  const clearAllFilters = useCallback(() => {
    setCategory(null);
    setGroup(null);
    selectParam(null);
    setPill("all");
    setScopeFilter("all");
    setLocalQ("");
    setSearch("");
    setFilters({ invalidOnly: false, overriddenOnly: false, hideNA: false, files: [] });
  }, [setCategory, setGroup, selectParam, setSearch, setFilters]);

  // Bring the active cell into view within the virtual body (vertical scrollTop
  // + horizontal wheel-delta, mirroring the jump-to-cell scroller above).
  const scrollActiveIntoView = (rowIdx: number, instName: string) => {
    const root = rootRef.current;
    if (!root) return;
    const holder = root.querySelector<HTMLElement>(".ant-table-tbody-virtual-holder");
    if (holder) {
      const rowH =
        root.querySelector<HTMLElement>(".ant-table-tbody-virtual .ant-table-row")?.getBoundingClientRect().height ||
        (prefs.density === "compact" ? 39 : 48);
      const top = rowIdx * rowH;
      if (top < holder.scrollTop) holder.scrollTop = top;
      else if (top + rowH > holder.scrollTop + holder.clientHeight)
        holder.scrollTop = top + rowH - holder.clientHeight;
    }
    // Horizontal: only nudge if the column is off-screen either side.
    let left = 0;
    for (const inst of visibleInstances) {
      if (inst.name === instName) break;
      left += instWidths[inst.name] ?? 150;
    }
    const width = instWidths[instName] ?? 150;
    const header = root.querySelector<HTMLElement>(".ant-table-header");
    if (holder && header) {
      const viewLeft = header.scrollLeft;
      const viewW = holder.clientWidth - (PARAM_W + (prefs.showTypeCol ? TYPE_W : 0) + (prefs.showScopeCol ? SCOPE_W : 0) + (prefs.showDescCol ? DESC_W : 0));
      let delta = 0;
      if (left < viewLeft) delta = left - viewLeft - 8;
      else if (left + width > viewLeft + viewW) delta = left + width - (viewLeft + viewW) + 8;
      if (delta !== 0) holder.dispatchEvent(new WheelEvent("wheel", { deltaX: delta, bubbles: true, cancelable: true }));
    }
  };

  // Arrow-key navigation over the grid, spreadsheet-style. It listens globally
  // but only acts when a cell is active and focus is not inside an input, so it
  // never hijacks typing in an editor, the search box, or a dialog.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (editing) return; // the open editor owns the keyboard
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;

      const rowIdx = rows.findIndex((r) => r.param.id === active.param);
      const colIdx = visibleInstances.findIndex((i) => i.name === active.inst);
      if (rowIdx < 0 || colIdx < 0) return;

      if (e.key === "Escape") {
        setActive(null);
        return;
      }
      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        const cell = rows[rowIdx].cells[active.inst];
        if (canEdit && cell?.editable) setEditing(`${active.param}|${active.inst}`);
        return;
      }
      let nr = rowIdx;
      let nc = colIdx;
      if (e.key === "ArrowUp") nr = Math.max(0, rowIdx - 1);
      else if (e.key === "ArrowDown") nr = Math.min(rows.length - 1, rowIdx + 1);
      else if (e.key === "ArrowLeft") nc = Math.max(0, colIdx - 1);
      else if (e.key === "ArrowRight") nc = Math.min(visibleInstances.length - 1, colIdx + 1);
      else return;
      e.preventDefault();
      const np = rows[nr].param.id;
      const ni = visibleInstances[nc].name;
      setActive({ param: np, inst: ni });
      scrollActiveIntoView(nr, ni);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, editing, rows, visibleInstances]);

  // The editor stays editing-focused: the table fills the available height.
  // Category inventory lives in the Overview dashboard, not here.
  //
  // The pinned shelf is part of the table's FIXED half (header + shelf), so its
  // height comes out of the scrolling body's - otherwise the table grows past
  // the box it was given and the whole editor gains a scrollbar of its own,
  // which then carries the toolbar off the top of the screen.
  const rowH = prefs.density === "compact" ? 39 : 48;
  const shelfH = pinnedRows.length * rowH;
  const availH = Math.max(bodyH - headerH, 120);
  const tableY = Math.max(availH - shelfH, 120);

  // Step through the matching rows, selecting and scrolling to each.
  const gotoMatch = (delta: number) => {
    if (rows.length === 0) return;
    const next = (((matchCursor + delta) % rows.length) + rows.length) % rows.length;
    setMatchCursor(next);
    const r = rows[next];
    selectParam(r.param.id);
    setJump("param", r.param.id);
  };

  // One environment however its source spelled it: a registry still holding
  // "lab" beside a preset "Lab" would otherwise offer the same quick selection
  // twice, each covering half the fleet.
  const environments = envOptions(grid.instances.map((i) => i.environment)).filter((e) =>
    grid.instances.some((i) => canonicalEnv(i.environment) === e),
  );

  // Priority overflow: measure the toolbar and degrade the widest controls as
  // width tightens. Before the first measurement (width 0) everything shows, so
  // there is no collapse flash. Nothing folds away entirely any more - the
  // instance picker is the context for the whole screen and the row filter is
  // how a reviewer finds their own edits, so both only ever get smaller.
  const w = barW || 9999;
  const colsCustomized =
    colLayout.hidden.length > 0 || Object.keys(colLayout.widths).length > 0 || colLayout.order.length > 0;
  const showFilterSeg = w >= 820;
  // Scope outlives grouping, which outlives nothing. The order is what each
  // control DOES: the row filter and the scope filter change which settings are
  // on screen, and grouping only rearranges the ones already there - so when
  // space runs out, the arrangement gives way before the contents do. Neither
  // is ever hidden; both say the same thing in a select a third of the width.
  const showScopeSeg = w >= 960;
  const showGroupSeg = w >= 1180;

  // The empty state and the pinned shelf are whole subtrees; rebuilding them on
  // every render of this component rebuilt the sticky rows and the empty state
  // along with them.
  const locale = useMemo(() => ({
            emptyText:
              total === 0 ? (
                <EmptyState
                  icon={<PlusOutlined />}
                  title="No parameters yet"
                  hint={
                    canEdit
                      ? "Add a parameter, or import settings from your repository files to bring them under management."
                      : "Nothing is under management here yet. Someone with edit access can bring settings in from the repository's files."
                  }
                  actionLabel={canEdit ? "Add parameter" : undefined}
                  onAction={canEdit ? () => setAddOpen(true) : undefined}
                />
              ) : scopeFilter !== "all" && scopeCounts[scopeFilter] === 0 ? (
                // An empty scope is a FACT about the estate, not a failed
                // search: nothing here is declared that way. Saying so - and
                // saying what would make it true - beats "nothing matches",
                // which reads as though the filter were broken.
                <EmptyState
                  icon={<SearchOutlined />}
                  title={`Nothing is ${SCOPE_META[scopeFilter].label.toLowerCase()} here`}
                  hint={
                    scopeFilter === "site"
                      ? "No setting is declared as shared by a group of systems. Set a parameter's scope to site, zone or environment in its details panel to manage one that way."
                      : scopeFilter === "global"
                        ? "Every setting here lives in an instance's own files, so each one is changed per instance."
                        : "Every setting here is shared, so there is nothing to change for one instance alone."
                  }
                  actionLabel="Show all scopes"
                  onAction={() => setScopeFilter("all")}
                />
              ) : (
                <EmptyState
                  icon={<SearchOutlined />}
                  title="Nothing matches"
                  hint="No parameters match the current search and filters."
                  actionLabel="Clear filters"
                  onAction={clearAllFilters}
                />
              ),
          }), [total, canEdit, clearAllFilters, scopeFilter, scopeCounts]);
  const summary = useMemo(
    () => (pinnedRows.length
              ? () => (
                  <Table.Summary fixed="top">
                    {pinnedRows.map((r) => (
                      <Table.Summary.Row
                        key={r.param.id}
                        className={
                          "cf-pinned-row" +
                          (r.param.id === selectedParamId ? " row-selected" : "") +
                          (r.param.id === pinnedRows[pinnedRows.length - 1].param.id ? " cf-pinned-last" : "")
                        }
                        onClick={() => toggleParamPanel(r.param.id)}
                      >
                        {columns.map((col, i) => {
                          const cell = (col as { onCell?: (r: Row) => { className?: string } }).onCell?.(r);
                          return (
                            <Table.Summary.Cell key={col.key ?? i} index={i} className={cell?.className}>
                              {renderColumn(col, r, i)}
                            </Table.Summary.Cell>
                          );
                        })}
                      </Table.Summary.Row>
                    ))}
                  </Table.Summary>
                )
              : undefined),
    [pinnedRows, columns, selectedParamId, toggleParamPanel],
  );

  // The table's per-row callbacks, given stable identities. antd rebuilds the
  // body when any of them changes, so an inline arrow meant every render of
  // this component - a hover, the toolbar remeasuring itself - re-created every
  // cell in a 25-column sheet. These change only when what they SAY changes.
  const rowKey = useCallback((r: Row) => r.param.id, []);
  const scroll = useMemo(() => ({ x: scrollX, y: tableY }), [scrollX, tableY]);
  const rowClassName = useCallback(
    (r: Row) => {
      const g = groupMeta?.get(r.param.id);
      // Alternate two identical flash classes per click (by jump parity)
      // so the CSS animation restarts even when the same row is clicked
      // again - re-adding the same class would not replay it.
      const flashing = (flash?.kind === "param" || flash?.kind === "cell") && flash.id === r.param.id;
      const flashCls = flashing ? ((flash?.n ?? 0) % 2 ? "row-flash-b " : "row-flash-a ") : "";
      return (
        flashCls +
        (r.param.id === selectedParamId ? "row-selected " : "") +
        // The branch the reader clicked in the tree: marked where it sits,
        // with everything around it still on screen.
        (groupHits.has(r.param.id) ? "cf-group-hit " : "") +
        (g ? `vgrp vgrp-c${g.color}${g.top ? " vgrp-top" : ""}${g.bot ? " vgrp-bot" : ""}` : "")
      ).trim();
    },
    [groupMeta, flash, selectedParamId, groupHits],
  );
  const onRow = useCallback(
    (r: Row) => ({ onClick: () => toggleParamPanel(r.param.id), style: { cursor: "pointer" } }),
    [toggleParamPanel],
  );

  // Reading one instance on its own. It travels through selectInstance so the
  // URL (?inst=) keeps saying what the screen is showing.
  const focusInstance = (name: string | null) => {
    setViewInstance(name);
    selectInstance(name);
  };

  // What the instance button says. It has to answer "what am I looking at"
  // without being opened, so it names the one thing when there is one thing and
  // counts otherwise - and names an environment when the ticks happen to be
  // exactly that environment, because that is how the user chose it.
  const shownInstances = grid.instances.filter((i) => !hiddenInstances.has(i.name));
  const instanceLabel = viewInstance
    ? viewInstance
    : shownInstances.length === grid.instances.length
      ? "All instances"
      : shownInstances.length === 0
        ? "No instances"
        : shownInstances.length === 1
          ? shownInstances[0].name
          : environments.find(
                (e) =>
                  shownInstances.every((i) => canonicalEnv(i.environment) === e) &&
                  shownInstances.length ===
                    grid.instances.filter((i) => canonicalEnv(i.environment) === e).length,
              ) ??
            `${shownInstances.length} of ${grid.instances.length} instances`;

  return (
    <div className="param-grid" style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      {/* ONE toolbar row: context (instance, environment), the draft-status
          pills, search, an overflow menu for everything else, and the primary
          action. It wraps to a second line only when space truly runs out.

          Wrap, not clip. With nowrap + overflow:hidden the row simply cut off
          whatever did not fit, and what did not fit was the LAST thing on it -
          "Review N changes", the one button the screen exists to lead to. Every
          control here holds its width and the search gives way first; when even
          that is not enough the row takes a second line, which costs 30px and
          never hides an action. */}
      <div
        ref={barRef}
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
        {/* ONE control for what you are looking at. Ticks say which instances
            have columns, a drag says in what order, and a name says "read that
            one on its own" - all in the same list, because they were always the
            same question asked three ways. */}
        <Dropdown
          trigger={["click"]}
          open={instOpen}
          onOpenChange={setInstOpen}
          placement="bottomLeft"
          popupRender={() => (
            <div className="cf-pop">
              <InstancePicker
                instances={orderedInstances}
                hidden={hiddenInstances}
                widths={colLayout.widths}
                order={colLayout.order}
                environments={environments}
                focused={viewInstance}
                onToggle={(name) =>
                  patchColLayout({
                    hidden: hiddenInstances.has(name)
                      ? colLayout.hidden.filter((n) => n !== name)
                      : [...colLayout.hidden, name],
                  })
                }
                onSetHidden={(names) => patchColLayout({ hidden: names })}
                onReorder={reorderInstances}
                onFocus={focusInstance}
                onReset={() => {
                  patchColLayout(emptyColLayout);
                  focusInstance(null);
                }}
              />
            </div>
          )}
        >
          <Tooltip title="Which instances to show, in what order - and reading one on its own">
            <Badge dot={colsCustomized} color="var(--c-review)" offset={[-4, 2]}>
              <Button
                size="small"
                icon={viewInstance ? <ScopeInstanceOutlined /> : <TableOutlined />}
                aria-label="Instances shown"
                style={{ flexShrink: 0, maxWidth: 190 }}
              >
                <span className="cf-instbtn-label">{instanceLabel}</span>
                <DownOutlined style={{ fontSize: 9, opacity: 0.55, marginInlineStart: 2 }} />
              </Button>
            </Badge>
          </Tooltip>
        </Dropdown>
        <FilePicker
          choices={fileChoices}
          selected={filters.files}
          onChange={(files) => setFilters({ files })}
        />
        <span style={{ width: 1, height: 20, background: "var(--border)", flexShrink: 0 }} />
        {/* Scope: how widely an edit to these settings lands. It is the first
            thing anybody needs to know in front of a fleet and the one thing
            the values themselves cannot say - a row of twelve identical
            domains looks the same whether it is one shared line every system
            reads or twelve copies that happen to agree. The counts are of the
            whole estate, so picking one narrows the list without the numbers
            moving underneath the choice. */}
        <Tooltip title={scopeFilter === "all" ? "Show settings by how widely an edit to them lands" : SCOPE_META[scopeFilter].explain}>
          {showScopeSeg ? (
            <Segmented
              size="small"
              value={scopeFilter}
              onChange={(v) => setScopeFilter(v as ScopeFilter)}
              style={{ flexShrink: 0 }}
              options={[
                { value: "all", label: "All scopes" },
                {
                  value: "global",
                  label: (
                    <span>
                      <ScopeGlobalOutlined style={{ marginInlineEnd: 4 }} />
                      Global{scopeCounts.global ? ` (${scopeCounts.global})` : ""}
                    </span>
                  ),
                },
                {
                  value: "site",
                  label: (
                    <span>
                      <ScopeSiteOutlined style={{ marginInlineEnd: 4 }} />
                      Site{scopeCounts.site ? ` (${scopeCounts.site})` : ""}
                    </span>
                  ),
                },
                {
                  value: "instance",
                  label: (
                    <span>
                      <ScopeInstanceOutlined style={{ marginInlineEnd: 4 }} />
                      Instance{scopeCounts.instance ? ` (${scopeCounts.instance})` : ""}
                    </span>
                  ),
                },
              ]}
            />
          ) : (
            <Select
              size="small"
              value={scopeFilter}
              onChange={(v) => setScopeFilter(v)}
              style={{ width: 128, flexShrink: 0 }}
              options={[
                { value: "all", label: "All scopes" },
                { value: "global", label: `Global (${scopeCounts.global})` },
                { value: "site", label: `Site (${scopeCounts.site})` },
                { value: "instance", label: `Instance (${scopeCounts.instance})` },
              ]}
            />
          )}
        </Tooltip>
        <span style={{ width: 1, height: 20, background: "var(--border)", flexShrink: 0 }} />
        {/* Grouping. It answers two everyday questions - "which of these are
            set the same across the fleet, and which one is the odd one out"
            (by value) and "show me this the way the tree does" (by path) - so
            it belongs on the bar, not three clicks down a menu where nobody
            found it. */}
        <Tooltip title={GROUP_HINT[prefs.groupBy]}>
          {showGroupSeg ? (
            <Segmented
              size="small"
              value={prefs.groupBy}
              onChange={(v) => setPrefs({ groupBy: v as GroupBy })}
              style={{ flexShrink: 0 }}
              options={[
                { value: "path", label: "By path" },
                { value: "value", label: "By value" },
                { value: "none", label: "Ungrouped" },
              ]}
            />
          ) : (
            <Select
              size="small"
              value={prefs.groupBy}
              onChange={(v) => setPrefs({ groupBy: v })}
              style={{ width: 116, flexShrink: 0 }}
              options={[
                { value: "path", label: "By path" },
                { value: "value", label: "By value" },
                { value: "none", label: "Ungrouped" },
              ]}
            />
          )}
        </Tooltip>
        <span style={{ width: 1, height: 20, background: "var(--border)", flexShrink: 0 }} />
        {/* Row filter: the full segmented when there is room, a compact select
            (same options and counts) when space is tight. Never removed. */}
        {showFilterSeg ? (
          <Segmented
            size="small"
            value={pill}
            onChange={(v) => setPill(v as typeof pill)}
            style={{ flexShrink: 0 }}
            options={[
              { value: "all", label: "All" },
              { value: "changed", label: `Changed${pillCounts.changed ? ` (${pillCounts.changed})` : ""}` },
              { value: "added", label: `Added${pillCounts.added ? ` (${pillCounts.added})` : ""}` },
              { value: "removed", label: `Removed${pillCounts.removed ? ` (${pillCounts.removed})` : ""}` },
            ]}
          />
        ) : (
          <Select
            size="small"
            value={pill}
            onChange={(v) => setPill(v as typeof pill)}
            style={{ width: 130, flexShrink: 0 }}
            options={[
              { value: "all", label: "All" },
              { value: "changed", label: `Changed${pillCounts.changed ? ` (${pillCounts.changed})` : ""}` },
              { value: "added", label: `Added${pillCounts.added ? ` (${pillCounts.added})` : ""}` },
              { value: "removed", label: `Removed${pillCounts.removed ? ` (${pillCounts.removed})` : ""}` },
            ]}
          />
        )}
        <span style={{ fontSize: 12, color: "var(--text-3)", flexShrink: 0, whiteSpace: "nowrap" }}>
          {/* Pinned rows are held out of the list but are still on screen, so
              they count towards what the reader can see. */}
          {isFiltered
            ? `${rows.length + pinnedRows.length} of ${total}`
            : rows.length + pinnedRows.length}
        </span>
        {isFiltered && (
          <Tooltip title="Clear the category, filters and search - show every parameter">
            <Button size="small" type="link" style={{ padding: "0 2px", height: "auto", flexShrink: 0 }} onClick={clearAllFilters}>
              Clear filters
            </Button>
          </Tooltip>
        )}
        {q && (
          <Tag
            color="blue"
            closable
            closeIcon={<CloseCircleFilled />}
            onClose={() => setSearch("")}
            style={{ flexShrink: 0, marginInlineEnd: 0 }}
          >
            ⌘K: “{search.trim()}”
          </Tag>
        )}
        {/* Search grows to fill the gap, keeping the actions flush right, and
            shrinks first (down to its minimum) before anything folds. */}
        <Space.Compact size="small" style={{ flex: "1 1 auto", minWidth: 140, maxWidth: 460 }}>
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
        <Dropdown
          trigger={["click"]}
          open={moreOpen}
          onOpenChange={setMoreOpen}
          menu={{
            items: [
              // Find & replace stages edits across the grid, so it is an
              // editor's tool; searching (the toolbar box) stays for everyone.
              ...(canEdit
                ? [{ key: "findreplace", icon: <SwapOutlined />, label: "Find & replace values…" }]
                : []),
              { key: "legend", icon: <QuestionCircleOutlined />, label: "Legend: what the marks mean" },
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
              ...(prefs.pinned.length
                ? [{ key: "unpinAll", icon: <PushpinOutlined />, label: `Unpin all (${prefs.pinned.length})` }]
                : []),
              {
                key: "showBeforeAfter",
                label: (
                  <Checkbox checked={prefs.showBeforeAfter}>Before and after in changed cells</Checkbox>
                ),
              },
            ],
            onClick: ({ key }) => {
              if (key === "findreplace") {
                setFindReplace({ find: "" });
                setMoreOpen(false);
              } else if (key === "legend") {
                setLegendOpen(true);
                setMoreOpen(false);
              } else if (key === "invalidOnly" || key === "overriddenOnly" || key === "hideNA") {
                setFilters({ [key]: !filters[key as keyof typeof filters] } as Partial<typeof filters>);
              } else if (key === "unpinAll") {
                unpinAll();
                setMoreOpen(false);
              } else if (key === "density") {
                setPrefs({ density: prefs.density === "comfortable" ? "compact" : "comfortable" });
              } else if (
                key === "showTypeCol" ||
                key === "showScopeCol" ||
                key === "showDescCol" ||
                key === "showBeforeAfter"
              ) {
                setPrefs({ [key]: !prefs[key as keyof typeof prefs] } as Partial<typeof prefs>);
              }
            },
          }}
        >
          {/* A gear, not three dots. What is in here is the SETTINGS of the
              editor - which columns, which density, which rows - and a gear is
              the one glyph everybody already reads that way; "⋮" says "more of
              the same actions", which these are not. */}
          <Badge dot={activeFilters > 0} color="var(--c-review)" offset={[-2, 2]}>
            <Button size="small" icon={<SettingOutlined />} aria-label="Editor settings" title="Filters, view options and tools" style={{ flexShrink: 0 }} />
          </Badge>
        </Dropdown>
        <span style={{ width: 1, height: 20, background: "var(--border)", flexShrink: 0 }} />
        {/* Add parameter and full-screen focus are first-class, always-visible
            actions rather than buried in the overflow menu. Adding a parameter
            is a change, so a viewer does not get the button at all. */}
        {canEdit && (
          <Tooltip title="Add parameter">
            <Button size="small" icon={<PlusOutlined />} onClick={() => setAddOpen(true)} aria-label="Add parameter" style={{ flexShrink: 0 }} />
          </Tooltip>
        )}
        <Tooltip title={editorFocus ? "Exit full screen (Esc)" : "Full screen: just the configuration"}>
          <Button
            size="small"
            type={editorFocus ? "primary" : "default"}
            icon={editorFocus ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            onClick={() => setEditorFocus(!editorFocus)}
            aria-label={editorFocus ? "Exit full screen" : "Full screen"}
            style={{ flexShrink: 0 }}
          />
        </Tooltip>
        {/* Primary action, always visible and never shrinks. Its badge is the
            single source of truth for how many edits are waiting. The auto
            margin keeps it hard right even when the bar has wrapped and it is
            alone on the second line.

            It steps aside while the grid is being read through SOMEBODY ELSE'S
            change. It submits YOUR draft and counts YOUR edits, both of which
            are true and neither of which is what this screen is currently
            about: "Review 2 changes" sitting a centimetre under "CR-1, 1
            change" reads as an offer to submit CR-1, and its badge reads as
            CR-1's size. Your draft has not gone anywhere - Back to Main brings
            the whole screen, button included, back to it. */}
        {!grid.viewing?.readOnly && (
          <span style={{ marginLeft: "auto", flexShrink: 0 }}>
            <SubmitChangesButton instances={grid.instances} />
          </span>
        )}
      </div>

      <Modal
        title="What do the marks mean?"
        open={legendOpen}
        onCancel={() => setLegendOpen(false)}
        footer={null}
        width={420}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 12 }}>
          {/* The legend has to show the mark it is describing, so this is the
              real thing: a staged value, with the part of it that moved. */}
          <span>
            <span className="cell-pending mono cell-value">
              10.0.<mark className="vd-ins">9</mark>.1
            </span>
            : your pending change, with the part that changed marked. Hover it for the value it
            replaces; the ⋮ menu can show both values in the cell instead.
          </span>
          <span><span className="cell-new mono">1.2</span>: newly introduced in this software version</span>
          <span><span className="cell-deprecated mono">off</span>: deprecated; no longer editable</span>
          <span><span className="cell-invalid mono">99999</span>: value breaks a rule (hover for why)</span>
          <span><span className="cell-excluded">∅ excluded</span>: removed from this instance's files entirely</span>
          <span><span className="cell-na">n/a</span>: doesn't exist in this software version yet</span>
          <span>
            <span className="prov-chip prov-base"><span className="prov-dot" />base</span>{" "}
            inherited from a shared file every instance reads ·{" "}
            <span className="prov-chip prov-default"><span className="prov-dot" />def</span>{" "}
            a built-in default with no file behind it. A value set on the instance itself carries no mark.
          </span>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Everything you edit is saved to Git and only goes live after approval.
          </Typography.Text>
        </div>
      </Modal>
      {unmanaging && (
        <UnmanageModal
          param={unmanaging}
          instances={grid.instances.length}
          busy={unmanage.isPending}
          onCancel={() => setUnmanaging(null)}
          onConfirm={() => unmanage.mutate(unmanaging.id)}
        />
      )}
      <AddParameterModal open={addOpen} onClose={() => setAddOpen(false)} grid={grid} />
      {/* One branch of the parameter tree as a form. It lives here, not in the
          tree, because everything it needs is the grid: the settings, their
          committed values, and the instances they can be written to. */}
      {groupEdit && (
        <GroupEditorModal groupKey={groupEdit} grid={grid} onClose={() => openGroupEditor(null)} />
      )}
      {bulkSet && (
        <BulkSetModal
          grid={grid}
          param={bulkSet.param}
          value={bulkSet.value}
          from={bulkSet.from}
          applying={bulkSave.isPending}
          onClose={() => setBulkSet(null)}
          onApply={(targets) => bulkSave.mutate({ paramId: bulkSet.param.id, value: bulkSet.value, targets })}
        />
      )}
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
              .updateParameter(param.id, { scope: "instance", author: "Local user" })
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
          // An empty grid says so and stops there. Its body is still as wide as
          // every column added together, so antd hung a horizontal scrollbar
          // under "Nothing matches" - an invitation to scroll sideways through
          // nothing. The class turns that one bar off; see index.css.
          className={"param-grid" + (rows.length === 0 && pinnedRows.length === 0 ? " is-empty" : "")}
          rowKey={rowKey}
          columns={columns}
          dataSource={rows}
          size={prefs.density === "compact" ? "small" : "middle"}
          virtual
          scroll={scroll}
          pagination={false}
          locale={locale}
          rowClassName={rowClassName}
          onRow={onRow}
          // Pinned rows ride in the table's sticky top block: the same table, so
          // the same column widths and the same horizontal scroll, and they stay
          // under the header however far the list is scrolled. antd calls this
          // a summary; here it is the "keep these in front of me" shelf.
          summary={summary}
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
      // Group matches by parameter so each parameter fans out in ONE bulk
      // request (a single draft lock, per-cell validation) instead of a
      // separate write per cell. A 300-match replace becomes a handful of
      // requests, not 300 round trips, and any per-cell failure is reported
      // with the instance it happened on rather than an opaque single error.
      const byParamId = new Map<string, FRMatch[]>();
      for (const m of matches) {
        const group = byParamId.get(m.paramId) ?? [];
        group.push(m);
        byParamId.set(m.paramId, group);
      }
      const failures: string[] = [];
      for (const group of byParamId.values()) {
        const value = coerceToType(replace, group[0].type); // one param, one type
        const res = await api.bulkSetValue({
          paramId: group[0].paramId,
          edits: group.map((m) => ({ instance: m.instance, value })),
        });
        for (const r of res.results) {
          if (!r.ok) failures.push(`${group[0].name} · ${r.instance}: ${r.error ?? "invalid"}`);
        }
      }
      if (failures.length) {
        const shown = failures.slice(0, 3).join("; ");
        throw new Error(
          `${failures.length} value${failures.length === 1 ? "" : "s"} could not be replaced - ${shown}${failures.length > 3 ? " ..." : ""}`,
        );
      }
    },
    onSuccess: () => {
      message.success(`Replaced ${matches.length} value${matches.length === 1 ? "" : "s"}; staged in your draft for review.`);
      qc.invalidateQueries();
      onClose();
    },
    onError: (e: Error) => message.error(`Replace failed: ${e.message}`, 8),
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
                <ValueDiff before={find} after={replace} label="the replacement" />
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

// renderColumn draws one column's cell for a row OUTSIDE the table body (the
// pinned shelf), through the column's own render function so a pinned row is
// the same row, drawn the same way, and never drifts from the list below it.
function renderColumn(col: ColumnsType<Row>[number], row: Row, index: number): React.ReactNode {
  const c = col as {
    render?: (value: unknown, record: Row, index: number) => React.ReactNode;
    dataIndex?: string | string[];
  };
  const value =
    typeof c.dataIndex === "string"
      ? (row as unknown as Record<string, unknown>)[c.dataIndex]
      : Array.isArray(c.dataIndex)
        ? c.dataIndex.reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], row)
        : undefined;
  return c.render ? c.render(value, row, index) : (value as React.ReactNode);
}

// ParamMenu is the right-click menu for a PARAMETER (the row), as distinct from
// the one on a value (the cell). Every entry answers a question about the
// setting itself and LANDS on the answer: the inspector opens on the tab that
// holds it, "view in <file>" opens the file at the line, rather than leaving the
// reader to find their own way once the menu has closed.
function ParamMenu({
  canEdit,
  pinned,
  pinnedCount,
  fileLabel,
  onDetails,
  onValidation,
  onHistory,
  onOpenFile,
  onTogglePin,
  onUnpinAll,
  onUnmanage,
  children,
}: {
  canEdit: boolean;
  pinned: boolean;
  /** how many parameters are pinned in total (drives "Unpin all") */
  pinnedCount: number;
  /** the file this parameter's value lives in, already expanded for the
   *  instance in view (undefined for a design-phase parameter) */
  fileLabel?: string;
  onDetails: () => void;
  onValidation: () => void;
  onHistory: () => void;
  onOpenFile?: () => void;
  onTogglePin: () => void;
  onUnpinAll: () => void;
  onUnmanage: () => void;
  children: React.ReactElement;
}) {
  return (
    <Dropdown
      trigger={["contextMenu"]}
      menu={{
        items: [
          { key: "details", icon: <InfoCircleOutlined />, label: "Details" },
          { key: "validation", icon: <CheckCircleOutlined />, label: "Validations" },
          ...(onOpenFile && fileLabel
            ? [{ key: "file", icon: <FileSearchOutlined />, label: `View in ${fileLabel}` }]
            : []),
          {
            key: "pin",
            icon: <PushpinOutlined />,
            label: pinned ? "Unpin from the top" : "Pin on top",
          },
          ...(pinnedCount > 1 || (pinnedCount === 1 && !pinned)
            ? [{ key: "unpinAll", icon: <PushpinOutlined />, label: `Unpin all (${pinnedCount})` }]
            : []),
          { key: "history", icon: <ClockOutlined />, label: "View change history" },
          ...(canEdit
            ? [
                { type: "divider" as const },
                {
                  key: "unmanage",
                  icon: <EyeInvisibleOutlined />,
                  label: "Stop managing this parameter",
                  // Red, like every other action that takes something away.
                  danger: true,
                },
              ]
            : []),
        ],
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          if (key === "details") onDetails();
          else if (key === "validation") onValidation();
          else if (key === "history") onHistory();
          else if (key === "file") onOpenFile?.();
          else if (key === "pin") onTogglePin();
          else if (key === "unpinAll") onUnpinAll();
          else if (key === "unmanage") onUnmanage();
        },
      }}
    >
      {children}
    </Dropdown>
  );
}

// UnmanageModal is the one place that says what "stop managing" does and, just
// as importantly, what it does NOT do. The distinction between this and
// retiring a parameter (which deletes the value from every file) is the whole
// reason it is a dialog and not a menu item that fires.
function UnmanageModal({
  param,
  instances,
  busy,
  onCancel,
  onConfirm,
}: {
  param: Parameter;
  instances: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const bs = bindingsOf(param);
  return (
    <Modal
      title="Stop managing this parameter?"
      open
      onCancel={onCancel}
      onOk={onConfirm}
      okText="Stage this change"
      okButtonProps={{ danger: true, loading: busy }}
      width={520}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div className="mono" style={{ fontWeight: 600 }}>{param.name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {bs.length === 0
              ? "Not attached to a file yet."
              : `${bs.length} location${bs.length === 1 ? "" : "s"} across ${instances} instance${instances === 1 ? "" : "s"}`}
          </Typography.Text>
        </div>
        <InlineNotice tone="ok">
          Every value stays exactly where it is. Nothing is written to your configuration files.
        </InlineNotice>
        <Typography.Text style={{ fontSize: 13 }}>
          This is staged as a change like any other: nothing happens until you submit it and an
          approver publishes it. When it lands, the parameter leaves{" "}
          <code>.configer/parameters.yaml</code> and the grid, and its paths are remembered in{" "}
          <code>.configer/ignore.yaml</code> so a later scan does not offer it back. Any pending edit
          to it is dropped now. To manage it again, import it from Import settings.
        </Typography.Text>
      </div>
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
          <GlobalOutlined style={{ color: c.base }} />
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
            New value: <span className="mono" style={{ color: c.ok }}>{fmtValue(ask.value)}</span>
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
