import { Tabs, Descriptions, Tag, Typography, Divider, Button, Statistic, Row as ARow, Col, Popconfirm, Select, Switch, Form, Input, AutoComplete, Space, Tooltip, App as AntApp } from "antd";
import {
  DeleteOutlined, HistoryOutlined, InfoCircleOutlined, LinkOutlined,
  CheckOutlined, CloseOutlined,
  ShieldOutlined, UndoOutlined,
} from "../icons";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { api, bindingsOf, expandBinding, revertRef, type ChangeItem, type Grid, type Instance, type Parameter, type Scope, type Row as GridRow, type Cell } from "../api";
import { fmtValue } from "../rules";
import { effectiveScope, groupsOf, reachLabel, SCOPE_ICON, SCOPE_META, ungrouped, type ScopeFacet, type ScopeGroup } from "../scope";
import { useUI } from "../store";
import ValueDiff from "./ui/ValueDiff";
import RuleEditor from "./RuleEditor";
import { ParamHistorySkeleton } from "./Skeletons";
import PathPicker from "./PathPicker";
import { relTime } from "./DashboardView";
import { useIdentity } from "../identity";
import { c } from "../uikit";
import ParameterFlow from "./ParameterFlow";

// Right-hand Parameter Details panel: what this setting IS, what it is set to,
// what it may be, and how it got here.
//
// THERE IS NO EDIT BUTTON. There was one, and it was a mode: the panel opened
// read-only, every field was a label until the button was pressed, and pressing
// it swapped the whole thing for a form - so the fastest way to fix a typo in a
// description was click, wait for the form, find the field again, type, save.
// A mode that exists only to enable typing is a mode nobody asked for.
//
// Now the fields ARE the form. Nothing is staged while somebody thinks: the
// Save/Cancel bar appears the moment a field really differs from what the
// catalog says, and disappears again if it is put back - so the panel is never
// quietly holding an edit, and never asks to save one that says nothing.
//
// The source file/path still change only through the interactive attach picker,
// never as free text. A parameter without a source is in the design phase:
// fully editable and valued, rendered nowhere until attached.
//
// And a metadata edit is a CHANGE. It stages into the draft and travels the
// ordinary road - draft, review, publish - because a validation rule decides
// what everybody else may type into a cell, and because writing straight to the
// working branch is simply impossible anywhere the repository protects it.

// Widest reach to narrowest, and every scope the catalog understands is
// offered: the editor can filter by "site-specific", so there has to be
// somewhere to say a setting IS one. A group scope names which grouping is
// meant, because "these systems" is not an answer on its own.
const scopeOptions: Scope[] = ["global", "site", "zone", "environment", "instance"];
const typeOptions = [
  "string", "integer", "number", "boolean", "enum",
  "ipv4", "ipv6", "cidr", "port", "hostname", "email", "url", "mac",
  "list",
];
// A list's element type: any scalar type (not another list).
const itemTypeOptions = typeOptions.filter((t) => t !== "list" && t !== "enum");

interface EditValues {
  displayName?: string;
  description?: string;
  category: string;
  type: string;
  itemType?: string;
  scope: Scope;
  secret: boolean;
  default?: string;
  derived?: string;
}

// coerceDefault turns the edited default (a string from the form) back into
// the parameter's declared type so the catalog keeps proper YAML types.
function coerceDefault(raw: string | undefined, type: string): unknown {
  if (raw === undefined || raw === "") return undefined;
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

// The one form. Every field is live; a Save/Cancel bar appears underneath the
// moment one of them really differs from the catalog.
function DetailsTab({
  p,
  categories,
  grid,
  onDirtyChange,
}: {
  p: Parameter;
  categories: string[];
  grid: Grid;
  /** so the panel can warn before a different parameter is selected out from
   *  under an unsaved edit */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { canEdit } = useIdentity();
  const { selectedInstance, setFileFocus, setSection } = useUI();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [form] = Form.useForm<EditValues>();
  // What the form says right now, so "is anything different" can be answered on
  // every keystroke without reading the DOM. Ant Design's own isFieldsTouched
  // answers a different question - whether a field was TYPED IN - and a field
  // typed in and put back is not a change anybody wants to be asked to save.
  const [live, setLive] = useState<EditValues | null>(null);
  // A parameter can map to several locations (its bindings). It is in the
  // design phase only when it maps to none.
  const allSources = bindingsOf(p).filter((b) => b.file);
  const design = allSources.length === 0;

  const initial = useMemo<EditValues>(
    () => ({
      displayName: p.displayName ?? "",
      description: p.description ?? "",
      category: p.category,
      type: p.type,
      itemType: p.itemType ?? "string",
      scope: p.scope,
      secret: !!p.secret,
      default:
        p.default === undefined || p.default === null
          ? ""
          : Array.isArray(p.default)
            ? (p.default as unknown[]).join(", ")
            : String(p.default),
      derived: p.derived ?? "",
    }),
    [p],
  );

  // The form follows the parameter. It is reset when a different one is
  // selected, and when the one on screen changes underneath - which it does the
  // moment a save lands, because the grid comes back carrying the staged
  // metadata (see grid.applyStructuralPreview) and the form must then agree
  // with it rather than keep offering to save what it already said.
  useEffect(() => {
    form.setFieldsValue(initial);
    setLive(null);
  }, [initial, form]);

  const dirtyFields = useMemo(() => {
    if (!live) return [] as (keyof EditValues)[];
    const keys: (keyof EditValues)[] = [
      "displayName", "description", "category", "type", "itemType", "scope", "secret", "default", "derived",
    ];
    return keys.filter((k) => {
      // An entry type is only meaningful for a list, so a stale one left over
      // from a parameter that stopped being one is not a difference.
      if (k === "itemType" && live.type !== "list") return false;
      return String(live[k] ?? "") !== String(initial[k] ?? "");
    });
  }, [live, initial]);
  const dirty = dirtyFields.length > 0;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const patch = useMutation({
    mutationFn: (v: Parameters<typeof api.updateParameter>[1]) =>
      api.updateParameter(p.id, { ...v, author: "Local user" }),
    onSuccess: () => {
      message.success("Staged in your draft: submit it for review to apply these settings");
      setLive(null);
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const save = (v: EditValues) => {
    const d = coerceDefault(v.default, v.type);
    patch.mutate({
      displayName: v.displayName ?? "",
      description: v.description ?? "",
      category: v.category,
      type: v.type,
      // itemType is only meaningful for a list; clear it otherwise so a
      // parameter that stops being a list does not carry a stale element type.
      itemType: v.type === "list" ? v.itemType || "string" : "",
      scope: v.scope,
      secret: v.secret,
      default: d === undefined ? "" : d,
      derived: (v.derived ?? "").trim(),
    });
  };

  const sourceRow = design ? (
    <Space direction="vertical" size={4}>
      <Tag color="purple">design phase: not attached yet</Tag>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        Values can be set and reviewed now; they render into files once attached.
      </Typography.Text>
      {canEdit && (
        <Button size="small" type="primary" icon={<LinkOutlined />} onClick={() => setPickerOpen(true)}>
          Attach to a file…
        </Button>
      )}
    </Space>
  ) : (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {allSources.length > 1 && (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          Mapped to {allSources.length} locations · one edit updates all
        </Typography.Text>
      )}
      {allSources.map((sb, i) => (
        <div key={`${sb.file}|${sb.path}`} style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <span className="mono" style={{ fontSize: 12 }}>{sb.file}</span>
            {i === 0 && allSources.length > 1 && (
              <Tag style={{ marginInlineStart: 6, fontSize: 10 }}>primary</Tag>
            )}
            <div className="mono" style={{ fontSize: 11, opacity: 0.65 }}>{sb.path}</div>
          </div>
          <Tooltip title="Open the file and jump to this line">
            <Button
              size="small"
              type="link"
              icon={<LinkOutlined />}
              onClick={async () => {
                const inst =
                  grid.instances.find((x) => x.name === selectedInstance) ?? grid.instances[0];
                const file = expandBinding(sb, inst);
                // Resolve the exact line first (best effort; YAML/JSON/XML), then
                // open the file focused on it. A miss just opens at the top.
                let line: number | undefined;
                try {
                  line = (await api.locate(file, sb.path, sb.format)).line || undefined;
                } catch {
                  // ignore: fall back to opening the file without a line
                }
                // Hand the instance and version along as provenance only; the
                // Files explorer stays on "All instances" so this file is always
                // present (a single-instance filter could hide it entirely).
                setFileFocus({
                  path: file,
                  line,
                  instance: inst?.name,
                  version: inst?.softwareVersion,
                  param: p.name,
                  allInstances: true,
                });
                setSection("files");
              }}
              aria-label="Open in Files at this line"
            />
          </Tooltip>
        </div>
      ))}
      {canEdit && (
        <Button size="small" icon={<LinkOutlined />} onClick={() => setPickerOpen(true)}>
          Re-map…
        </Button>
      )}
    </Space>
  );

  // A viewer reads the same fields; they are simply not typeable. Rendering a
  // second, read-only copy of the same nine rows is how two descriptions of one
  // parameter drift apart, so there is one form and it is disabled.
  return (
    <>
      <Form
        form={form}
        layout="vertical"
        size="small"
        initialValues={initial}
        disabled={!canEdit || patch.isPending}
        onValuesChange={(_c, all) => setLive(all)}
        onFinish={save}
      >
        <Form.Item name="displayName" label="Display name" style={{ marginBottom: 8 }}>
          <Input placeholder="Human-friendly name" />
        </Form.Item>
        <Form.Item name="description" label="Description" style={{ marginBottom: 8 }}>
          <Input.TextArea rows={3} placeholder="What does this parameter control?" />
        </Form.Item>
        <div style={{ display: "flex", gap: 8 }}>
          <Form.Item name="category" label="Category" style={{ flex: 1, marginBottom: 8 }} rules={[{ required: true }]}>
            <AutoComplete
              options={categories.map((cat) => ({ value: cat }))}
              filterOption={(input, opt) => (opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item name="type" label="Data type" style={{ width: 110, marginBottom: 8 }}>
            <Select options={typeOptions.map((t) => ({ value: t, label: t }))} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.type !== cur.type}>
            {({ getFieldValue }) =>
              getFieldValue("type") === "list" ? (
                <Form.Item name="itemType" label="Each entry is" style={{ width: 120, marginBottom: 8 }}>
                  <Select options={itemTypeOptions.map((t) => ({ value: t, label: t }))} />
                </Form.Item>
              ) : null
            }
          </Form.Item>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Form.Item
            name="scope"
            label="Scope"
            tooltip="How widely an edit lands. A group scope names WHICH grouping is meant, and the instances sharing that site, zone or environment are what an edit reaches."
            style={{ flex: 1, marginBottom: 8 }}
          >
            <Select
              options={scopeOptions.map((sc) => {
                const Icon = SCOPE_ICON[sc as ScopeFacet];
                return {
                  value: sc,
                  label: (
                    <span>
                      <Icon style={{ marginInlineEnd: 6 }} />
                      {sc}
                    </span>
                  ),
                };
              })}
            />
          </Form.Item>
          <Form.Item name="secret" label="Secret" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Switch size="small" />
          </Form.Item>
        </div>
        <Form.Item
          name="default"
          label="Default value (lists comma-separated)"
          tooltip="What the value is when no file carries one. It is not the value: see the field above, which writes into the repository's own files."
          style={{ marginBottom: 10 }}
        >
          <Input className="mono" placeholder="Inherited default" />
        </Form.Item>
        <Form.Item
          name="derived"
          label="Derived from"
          tooltip="Compute a default from another parameter, e.g. {admin-port}+1. Any file value still overrides it."
          style={{ marginBottom: 10 }}
        >
          <Input className="mono" placeholder="e.g. {admin-port}+1" />
        </Form.Item>
        <Descriptions column={1} size="small" bordered items={[
          ...(p.source ? [{ key: "srcmap", label: "Linked source", children: (
            <span><Tag color="geekblue">{p.source.sourceId}</Tag><span className="mono">{p.source.key}</span>{p.source.instance ? <Tag style={{ marginInlineStart: 4 }}>{p.source.instance}</Tag> : null}</span>
          ) }] : []),
          { key: "intro", label: "Version introduced", children: p.versionIntroduced || "-" },
          { key: "dep", label: "Version deprecated", children: p.versionDeprecated || "-" },
          { key: "source", label: "Defined in", children: sourceRow },
        ]} />
        {/* The bar is the whole announcement, and it is only here when there is
            something to announce. It names the fields that moved, because
            "unsaved changes" is exactly the sentence that makes somebody press
            Cancel to find out what they were. */}
        {dirty && canEdit && (
          <div className="cf-savebar">
            <div className="cf-savebar-what">
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {dirtyFields.length} unsaved: {dirtyFields.map(fieldLabel).join(", ")}
              </Typography.Text>
            </div>
            <Space size={6}>
              <Button
                size="small"
                icon={<CloseOutlined />}
                onClick={() => {
                  form.setFieldsValue(initial);
                  setLive(null);
                }}
              >
                Cancel
              </Button>
              <Button type="primary" size="small" icon={<CheckOutlined />} htmlType="submit" loading={patch.isPending}>
                Save all
              </Button>
            </Space>
          </div>
        )}
      </Form>
      <PathPicker open={pickerOpen} onClose={() => setPickerOpen(false)} param={p} grid={grid} />
    </>
  );
}

/** The words the save bar uses for each field, so the bar names what the form
 *  labels named rather than the keys the code uses. */
function fieldLabel(k: keyof EditValues): string {
  switch (k) {
    case "displayName": return "display name";
    case "description": return "description";
    case "category": return "category";
    case "type": return "data type";
    case "itemType": return "entry type";
    case "scope": return "scope";
    case "secret": return "secret";
    case "default": return "default value";
    case "derived": return "derived from";
  }
}

// IdlePanel is the details panel's default state: selection-oriented, not a
// second Overview. It says what selecting does, surfaces what needs the
// user's hand right now (invalid cells, their own unsent edits), and stays
// out of the way; the application-wide numbers live on the Overview tab.
function IdlePanel({ grid }: { grid: Grid }) {
  const { setFilters, selectParam, setJump } = useUI();
  const qc = useQueryClient();
  const draftQ = useRepoQuery({ queryKey: ["draft"], queryFn: api.draft });
  const draftItems = (draftQ.data?.draft?.items ?? []).filter((it) => !it.action || it.action === "set");
  const allDraftItems = draftQ.data?.draft?.items ?? [];

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ["grid"] });
    qc.invalidateQueries({ queryKey: ["draft"] });
    qc.invalidateQueries({ queryKey: ["changes"] });
    qc.invalidateQueries({ queryKey: ["render"] });
  };
  const revert = useMutation({
    mutationFn: (it: ChangeItem) => {
      const ref = revertRef(it);
      return api.revertValue(ref.paramId, ref.instance, ref.action);
    },
    onSuccess: refetchAll,
  });
  const discardAll = useMutation({
    mutationFn: async () => {
      await api.revertValues(allDraftItems.map(revertRef));
    },
    onSuccess: refetchAll,
  });

  // Parameters with at least one invalid cell, worst first.
  const invalidRows = grid.rows
    .map((r) => ({ r, n: Object.values(r.cells).filter((c) => !c.valid).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const invalid = invalidRows.reduce((s, x) => s + x.n, 0);

  const jumpTo = (paramId: string) => {
    selectParam(paramId);
    setJump("param", paramId);
  };

  return (
    <div style={{ padding: 14, height: "100%", overflow: "auto" }}>
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 4 }}>
        Inspector
      </Typography.Title>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Select a cell to see its value, the file it comes from and its rules. Selecting a row
        shows the parameter's metadata, history and dependencies here.
      </Typography.Text>

      {invalid > 0 && (
        <>
          <Divider style={{ margin: "12px 0" }} />
          <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: 0.4 }}>
            NEEDS FIXING
          </Typography.Text>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {invalidRows.slice(0, 5).map(({ r, n }) => (
              <a
                key={r.param.id}
                onClick={() => jumpTo(r.param.id)}
                style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}
              >
                <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.param.name}
                </span>
                <Typography.Text type="danger" style={{ fontSize: 12, flexShrink: 0 }}>
                  {n} invalid
                </Typography.Text>
              </a>
            ))}
          </div>
          <Button
            size="small"
            style={{ marginTop: 10 }}
            onClick={() => setFilters({ invalidOnly: true })}
          >
            Show only invalid cells
          </Button>
        </>
      )}

      {draftItems.length > 0 && (
        <>
          <Divider style={{ margin: "12px 0" }} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: 0.4 }}>
              YOUR CHANGES
            </Typography.Text>
            <Popconfirm
              title="Discard every change?"
              description="This removes all your pending edits. It cannot be undone."
              okText="Discard all"
              okButtonProps={{ danger: true }}
              onConfirm={() => discardAll.mutate()}
            >
              <a style={{ fontSize: 11 }}>Discard all</a>
            </Popconfirm>
          </div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {draftItems.slice(0, 6).map((it) => (
              <div
                key={`${it.paramId}|${it.instance}`}
                style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12 }}
              >
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <a onClick={() => jumpTo(it.paramId)}>
                    <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                      {it.paramId} · {it.instance || "global"}
                    </span>
                  </a>
                  {/* The exact characters that moved, not two values to compare
                      by eye - the rail is narrow, so the diff is stacked. */}
                  <ValueDiff before={it.old} after={it.new} layout="stacked" label={it.paramId} />
                </div>
                <Tooltip title="Undo this change">
                  <Button
                    size="small"
                    type="text"
                    icon={<UndoOutlined />}
                    loading={revert.isPending}
                    onClick={() => revert.mutate(it)}
                    aria-label="Undo this change"
                  />
                </Tooltip>
              </div>
            ))}
            {draftItems.length > 6 && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                and {draftItems.length - 6} more in the draft
              </Typography.Text>
            )}
          </div>
        </>
      )}

      {invalid === 0 && draftItems.length === 0 && (
        <>
          <Divider style={{ margin: "12px 0" }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <CheckOutlined style={{ color: "var(--c-ok)", marginInlineEnd: 6 }} />
            Every value is valid and nothing is waiting on you.
          </Typography.Text>
        </>
      )}
    </div>
  );
}

// One instance's effective value, shown compactly with a layer hint. Absent
// and not-applicable cells are called out rather than shown as blanks.
function CellValue({ cell }: { cell?: Cell }) {
  if (!cell) return <span style={{ opacity: 0.4 }}>-</span>;
  if (cell.state === "na") return <Tag style={{ marginInlineEnd: 0 }}>n/a</Tag>;
  if (!cell.set) return <Tag color="default" style={{ marginInlineEnd: 0 }}>absent</Tag>;
  return (
    <Space size={4}>
      <span className="mono" style={{ fontSize: 12, color: cell.valid ? undefined : c.danger }}>
        {fmtValue(cell.value)}
      </span>
      {cell.set && cell.source !== "instance" && (
        <Tag style={{ fontSize: 10, marginInlineEnd: 0 }}>{cell.source}</Tag>
      )}
    </Space>
  );
}

// THE VALUE EDITOR - one field per thing the value is actually held BY.
//
// The Overview tab said what this parameter is, and then listed what each
// instance holds, and there was nowhere at all to change it: the only way in
// was to find the row in the grid and type into a cell. That is right for a
// setting each system holds its own copy of, and wrong for every other kind.
// A global setting had twelve cells and one value behind them, and the panel
// showed the twelve. A site-scoped one had four cells that were supposed to
// agree and no way to say so - somebody typed the same number four times and
// hoped.
//
// So the editor is shaped like the SCOPE. Global gets one field, and changing
// it changes everybody. A group scope gets a small table - a value, and what it
// applies to - one row per site, zone or environment the estate actually has.
// Instance scope gets nothing here: those really are edited per cell, and the
// list below already shows them.
function ScopeValueEditor({ row, grid }: { row: GridRow; grid: Grid }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { canEdit } = useIdentity();
  const param = row.param;
  const facet = effectiveScope(param);
  const field = SCOPE_META[facet].field;

  // The rows of the editor: one per group, or the single "everyone" row.
  const groups = useMemo<ScopeGroup[]>(() => {
    if (facet === "global") return [{ key: "", instances: grid.instances }];
    if (field) return groupsOf(param, grid.instances);
    return [];
  }, [facet, field, param, grid.instances]);
  const orphans = useMemo(
    () => (field ? ungrouped(field, grid.instances) : []),
    [field, grid.instances],
  );

  // What each row currently holds, and whether the systems in it agree. Held as
  // TEXT while it is being edited: a field the reader is halfway through typing
  // into must not be swapped out from under them by a refetch.
  const committed = useMemo(() => {
    const m = new Map<string, { text: string; mixed: boolean; set: boolean }>();
    for (const g of groups) {
      const cells = g.instances.map((i) => row.cells[i.name]).filter(Boolean) as Cell[];
      const rendered = new Set(cells.map((cl) => (cl.set ? fmtValue(cl.value) : "\u0000absent")));
      m.set(g.key, {
        text: cells[0]?.set ? fmtValue(cells[0].value) : "",
        mixed: rendered.size > 1,
        set: cells.some((cl) => cl.set),
      });
    }
    return m;
  }, [groups, row.cells]);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // A save lands as a new grid, so what the fields were offering to change is
  // no longer a change. Clearing them here is what makes the bar go away by
  // itself rather than by being pressed twice.
  useEffect(() => setDrafts({}), [committed]);

  const save = useMutation({
    mutationFn: (v: { group: string; value: string }) =>
      api.setValue({
        instance: "",
        paramId: param.id,
        scope: facet as "global" | "site" | "zone" | "environment",
        group: v.group || undefined,
        value: coerceForType(v.value, param.type),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
      qc.invalidateQueries({ queryKey: ["render"] });
      const failed = (res.results ?? []).filter((r) => !r.ok);
      const where = res.reach ? ` for ${res.reach}` : "";
      if (failed.length) message.warning(`Staged ${res.staged ?? 0}${where}; ${failed.length} refused (${failed[0].error})`, 6);
      else if ((res.staged ?? 1) === 0) message.info(`Already that value${where} - nothing to stage.`);
      else message.success(`Staged${where}`);
    },
    onError: (e: Error) => message.error(`Rejected: ${e.message}`),
  });

  if (facet === "instance") return null;

  const Icon = SCOPE_ICON[facet];
  const dirtyKeys = groups
    .map((g) => g.key)
    .filter((k) => drafts[k] !== undefined && drafts[k] !== (committed.get(k)?.text ?? ""));

  return (
    <div className="cf-scopeval">
      <div className="cf-scopeval-head">
        <Icon />
        <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: 0.4 }}>
          {facet === "global" ? "VALUE (ALL INSTANCES)" : `VALUE PER ${field?.toUpperCase()}`}
        </Typography.Text>
      </div>
      {groups.length === 0 ? (
        // A group scope over an estate that has never filled the field in. Said
        // plainly, because the fix is on the instances rather than here.
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          No instance has a {field} set, so there is no group to give a value to. Set one on the
          Instances tab and this becomes editable.
        </Typography.Text>
      ) : (
        <div className="cf-scopeval-rows">
          {groups.map((g) => {
            const cur = committed.get(g.key);
            const text = drafts[g.key] ?? cur?.text ?? "";
            const changed = drafts[g.key] !== undefined && drafts[g.key] !== (cur?.text ?? "");
            return (
              <div key={g.key || "__all__"} className="cf-scopeval-row">
                <div className="cf-scopeval-field">
                  <Input
                    size="small"
                    className="mono"
                    value={text}
                    disabled={!canEdit}
                    placeholder={cur?.mixed ? "these systems disagree" : cur?.set ? "" : "not set"}
                    status={cur?.mixed && !changed ? "warning" : undefined}
                    onChange={(e) => setDrafts((d) => ({ ...d, [g.key]: e.target.value }))}
                    onPressEnter={() => changed && save.mutate({ group: g.key, value: text })}
                  />
                </div>
                {/* APPLIES TO. The whole point of this shape: a value is not
                    worth reading without the systems it lands on beside it. */}
                <div className="cf-scopeval-to">
                  <Tooltip title={g.instances.map((i) => i.name).join(", ")}>
                    <span className="cf-scopeval-key">{g.key || "Every instance"}</span>
                  </Tooltip>
                  <span className="cf-scopeval-n">
                    {g.instances.length} instance{g.instances.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {orphans.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginTop: 8 }}>
          {orphans.length === 1 ? "One instance has" : `${orphans.length} instances have`} no {field}
          {" "}({orphans.map((i) => i.name).join(", ")}), so nothing here reaches{" "}
          {orphans.length === 1 ? "it" : "them"}.
        </Typography.Text>
      )}
      {dirtyKeys.length > 0 && canEdit && (
        <div className="cf-savebar">
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {dirtyKeys.length === 1
              ? `Applies to ${reachLabel(facet, dirtyKeys[0] || null, groups.find((g) => g.key === dirtyKeys[0])?.instances.length ?? 0)}`
              : `${dirtyKeys.length} groups changed`}
          </Typography.Text>
          <Space size={6}>
            <Button size="small" icon={<CloseOutlined />} onClick={() => setDrafts({})}>
              Cancel
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<CheckOutlined />}
              loading={save.isPending}
              onClick={() => {
                for (const k of dirtyKeys) save.mutate({ group: k, value: drafts[k] });
              }}
            >
              Save all
            </Button>
          </Space>
        </div>
      )}
    </div>
  );
}

/** Turn what was typed into the parameter's declared type. The service coerces
 *  and validates again - it is the authority - but sending a number as a number
 *  keeps the YAML a number rather than a quoted string. */
function coerceForType(raw: string, type: string): unknown {
  const t = raw.trim();
  if (t === "") return "";
  switch (type) {
    case "integer":
    case "number": {
      const n = Number(t);
      return Number.isNaN(n) ? t : n;
    }
    case "boolean":
      return t === "true";
    case "list":
      return t.split(",").map((x) => x.trim()).filter(Boolean);
    default:
      return raw;
  }
}

// OVERVIEW: what this parameter IS and what it is set to, in that order.
//
// These were two tabs, "Overview" and "Details", and nobody could say in
// advance which drawer an answer had been filed in - they are the same
// question asked twice. The metadata form sits underneath the values, because
// "what am I changing this from" is the first thing anyone wants while they
// type.
function OverviewTab({
  row,
  grid,
  categories,
  onDirtyChange,
}: {
  row: GridRow;
  grid: Grid;
  categories: string[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const values = grid.instances.map((i) => ({ inst: i, cell: row.cells[i.name] }));
  const set = values.filter((v) => v.cell?.set).length;
  const invalid = values.filter((v) => v.cell && !v.cell.valid).length;
  const perInstance = effectiveScope(row.param) === "instance";
  return (
    <div>
      <ARow gutter={8} style={{ marginBottom: 12 }}>
        <Col span={8}><Statistic title="Set" value={set} valueStyle={{ fontSize: 18 }} /></Col>
        <Col span={8}><Statistic title="Instances" value={grid.instances.length} valueStyle={{ fontSize: 18 }} /></Col>
        <Col span={8}><Statistic title="Invalid" value={invalid} valueStyle={{ fontSize: 18, color: invalid ? c.danger : undefined }} /></Col>
      </ARow>
      <ScopeValueEditor row={row} grid={grid} />
      {/* The per-instance list stays whatever the scope is. For a shared value
          it is the RECEIPT - proof that the twelve systems really do read the
          one line above - and a screen that hid it would be asking to be
          trusted about the thing somebody came here to check. */}
      <Typography.Text
        type="secondary"
        style={{ fontSize: 11, letterSpacing: 0.4, display: "block", marginTop: perInstance ? 0 : 14 }}
      >
        {perInstance ? "VALUE PER INSTANCE" : "WHAT EACH INSTANCE READS"}
      </Typography.Text>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        {values.map(({ inst, cell }) => (
          <div key={inst.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12 }}>{inst.name}</span>
            <CellValue cell={cell} />
          </div>
        ))}
      </div>
      <Divider style={{ margin: "16px 0 12px" }} />
      <DetailsTab p={row.param} categories={categories} grid={grid} onDirtyChange={onDirtyChange} />
    </div>
  );
}

// DEPENDENCIES tab: what this parameter depends on, and what depends on it
// (reverse edges computed from the catalog). Both are click-through.
function DependenciesTab({ p, grid, onSelect }: { p: Parameter; grid: Grid; onSelect: (id: string) => void }) {
  const nameOf = (id: string) => grid.rows.find((r) => r.param.id === id)?.param.name ?? id;
  const requiredBy = grid.rows.filter((r) => r.param.dependsOn?.includes(p.id)).map((r) => r.param);
  const chip = (id: string, label: string) => (
    <Tag key={id} className="mono" style={{ cursor: "pointer", margin: 0 }} onClick={() => onSelect(id)}>
      {label}
    </Tag>
  );
  // A small centered dependency graph: what this parameter depends on flows down
  // into it, and what it is required by flows out below. Reads top-to-bottom and
  // stays centered instead of hugging the left edge.
  const label = (t: string) => (
    <Typography.Text type="secondary" style={{ fontSize: 10, letterSpacing: 0.5 }}>
      {t}
    </Typography.Text>
  );
  const chipRow = (children: React.ReactNode) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, justifyContent: "center", maxWidth: "100%" }}>
      {children}
    </div>
  );
  const arrow = <span style={{ opacity: 0.35, fontSize: 16, lineHeight: 1 }}>↓</span>;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        textAlign: "center",
        padding: "6px 0",
      }}
    >
      {label("DEPENDS ON")}
      {p.dependsOn?.length ? (
        chipRow(p.dependsOn.map((d) => chip(d, nameOf(d))))
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          nothing
        </Typography.Text>
      )}
      {arrow}
      <Tag
        color="blue"
        className="mono"
        style={{ margin: 0, fontSize: 12, padding: "3px 12px", fontWeight: 600 }}
      >
        {p.name}
      </Tag>
      {arrow}
      {label("REQUIRED BY")}
      {requiredBy.length ? (
        chipRow(requiredBy.map((rp) => chip(rp.id, rp.name)))
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          nothing
        </Typography.Text>
      )}
    </div>
  );
}

// VERSIONS tab: the parameter's lifecycle and how it applies per instance,
// derived from each cell's version-aware state.
const applicability: Record<Cell["state"], { label: string; color: string }> = {
  normal: { label: "active", color: "blue" },
  new: { label: "new here", color: "green" },
  deprecated: { label: "deprecated", color: "red" },
  na: { label: "not in version", color: "default" },
};
function VersionsTab({ row, grid }: { row: GridRow; grid: Grid }) {
  const p = row.param;
  return (
    <div>
      <Descriptions column={1} size="small" bordered items={[
        { key: "intro", label: "Introduced", children: p.versionIntroduced || "-" },
        { key: "dep", label: "Deprecated", children: p.versionDeprecated || "-" },
      ]} />
      <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: 0.4, display: "block", marginTop: 12 }}>
        APPLICABILITY PER INSTANCE
      </Typography.Text>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        {grid.instances.map((i) => {
          const a = applicability[row.cells[i.name]?.state ?? "normal"];
          return (
            <div key={i.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12 }}>{i.name}</span>
              <Space size={6}>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>{i.softwareVersion}</Typography.Text>
                <Tag color={a.color} style={{ marginInlineEnd: 0 }}>{a.label}</Tag>
              </Space>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// HISTORY tab: how this parameter's value came to say what it says.
//
// It used to be the commit log, flattened: a list of values with a hash and an
// author beside each. That answers "when did this change" and cannot answer the
// question people actually open this tab with, which is "why". Why is in the
// change requests - who proposed it, who signed it off, what was turned down
// and on what grounds - and half of that is in no log at all, because a
// rejected change never reaches a commit.
//
// So the tab draws both (see ParameterFlow): the trunk, each commit naming the
// review it came out of, and every proposal that is not on the trunk hanging
// off the point it forked from, with its status in a colour, a line and a
// shape. When an instance is selected the whole picture is that instance's
// cell; otherwise it is the catalog default.
function ParamHistoryTab({ paramId, instances }: { paramId: string; instances: Instance[] }) {
  const { selectedInstance, setSection } = useUI();
  // WHICH cell this history is about.
  //
  // With no instance selected the service resolves the catalog DEFAULT, and on
  // a real repository that is usually nothing at all - so the picture read
  // "(empty)" down the trunk while the changes hanging off it plainly said
  // telco-dev -> telco-in-review. Two answers about two different things, in
  // one column, with nothing saying so.
  //
  // A history is about a cell, so one is always chosen: the selected instance,
  // or - failing that - the only one there is, or the first. The header names
  // it, because a picture that quietly picked an instance for you is worse than
  // one that picked the wrong one and said which.
  const readFor = selectedInstance ?? instances[0]?.name ?? "";
  const q = useRepoQuery({
    queryKey: ["paramHistory", paramId, readFor],
    queryFn: () => api.parameterHistory(paramId, readFor ? { instance: readFor } : undefined),
  });
  const { canEdit } = useIdentity();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const entries = q.data?.entries ?? [];
  const changes = q.data?.changes ?? [];
  const lastChange = q.data?.lastChange ?? null;
  const supported = q.data?.supported ?? true;

  const resume = useMutation({
    mutationFn: (id: number) => api.reopenChange(id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
      qc.invalidateQueries({ queryKey: ["paramHistory"] });
      message.success(`${res.carried} ${res.carried === 1 ? "edit" : "edits"} from ${res.from} are back in your draft.`);
    },
    onError: (e: Error) => message.error(e.message),
  });

  // A git log over a repository's whole life is not instant, and a line of text
  // saying so is the least a panel can do while it waits. The skeleton is
  // shaped like the timeline that arrives, so nothing jumps when it does.
  if (q.isLoading) return <ParamHistorySkeleton />;
  // A backend that cannot serve a log can still serve the change requests: they
  // are workflow state, not git. So an unsupported history is only missing its
  // trunk, and saying "no history here" while holding four proposals would be
  // simply untrue.
  if (!supported && changes.length === 0)
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        History is available for repositories cloned or opened on the server.
      </Typography.Text>
    );
  if (entries.length === 0 && changes.length === 0)
    return <Typography.Text type="secondary" style={{ fontSize: 12 }}>No recorded changes for this parameter.</Typography.Text>;

  // Proposals that are not on the trunk. Counted here rather than left to be
  // noticed, because "two changes to this value were turned down" is a fact
  // about a parameter that ought to reach somebody who is about to edit it.
  const open = changes.filter((cr) => cr.state === "under_review" || cr.state === "approved").length;
  const refused = changes.filter((cr) => cr.state === "rejected").length;

  return (
    <div>
      {lastChange && (
        <div
          style={{
            marginBottom: 10,
            padding: "6px 10px",
            borderRadius: 8,
            fontSize: 12,
            background: "var(--surface-2, rgba(127,137,160,0.08))",
            border: "1px solid rgba(127,137,160,0.2)",
          }}
        >
          <span style={{ color: "var(--text-2)" }}>Last changed to </span>
          <span className="mono" style={{ fontWeight: 600 }}>
            {lastChange.value === "" ? "(empty)" : lastChange.value}
          </span>
          <span style={{ color: "var(--text-2)" }}>
            {" "}by {lastChange.author} · {relTime(lastChange.date)}
          </span>
          {lastChange.changeNumber ? (
            <span style={{ color: "var(--text-2)" }}> · CR-{lastChange.changeNumber}</span>
          ) : null}
        </div>
      )}
      <div className="pf-head">
        <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: 0.4 }}>
          HOW THIS VALUE GOT HERE{readFor ? ` · ${readFor}` : " · default"}
        </Typography.Text>
        {(open > 0 || refused > 0) && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {[open ? `${open} waiting` : "", refused ? `${refused} rejected` : ""].filter(Boolean).join(" · ")}
          </Typography.Text>
        )}
      </div>
      <ParameterFlow
        entries={entries}
        changes={changes}
        canResume={canEdit}
        resuming={resume.isPending ? resume.variables : null}
        onResume={(id) => resume.mutate(id)}
        onOpenChange={() => setSection("changes")}
      />
    </div>
  );
}

export default function DetailsPanel({ grid }: { grid: Grid }) {
  const { message } = AntApp.useApp();
  // The inspector reads a parameter for everyone; editing its metadata,
  // attaching bindings and retiring it are editor actions.
  const { canEdit } = useIdentity();
  const qc = useQueryClient();
  // The tab lives in the store, not here: the grid's parameter menu leads
  // straight to a question ("what are its rules?", "who changed it?"), and the
  // panel has to open on the answer rather than on its front page.
  const { selectedParamId, selectParam, inspectorTab, setInspectorTab } = useUI();
  const row = grid.rows.find((r) => r.param.id === selectedParamId);
  // Where the six old tabs went. Anything that deep-links into the inspector -
  // the grid's row menu, a saved link - names the answer it wants, and the
  // answer moved rather than vanished.
  const MOVED: Record<string, string> = {
    details: "overview",
    validation: "rules",
    depends: "rules",
    versions: "history",
  };
  const tab = MOVED[inspectorTab] ?? inspectorTab;
  const setTab = setInspectorTab;
  // Whether the metadata form is holding something unsaved. The panel does not
  // block on it - selecting another parameter is a normal thing to do - but it
  // is worth SAYING, because the alternative is an edit that quietly went
  // nowhere and a person who thinks it was saved.
  const [metaDirty, setMetaDirty] = useState(false);
  useEffect(() => setMetaDirty(false), [selectedParamId]);

  // The rules editor shows the default but does not own it: a field edited from
  // two forms is a field two forms can disagree about, so the second one sends
  // the reader to the first rather than leaving them at a value they cannot
  // change. It is a jump to a tab now, not a mode: the field is already
  // typeable when they get there.
  const editDefault = () => setTab("overview");

  const retire = useMutation({
    mutationFn: (id: string) => api.deleteParameter(id, "Local user"),
    onSuccess: () => {
      message.success("Parameter retired: removed from the catalog and deleted from every file it lived in");
      selectParam(null);
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  if (!row) return <IdlePanel grid={grid} />;
  const p = row.param;
  const categories = [...new Set(grid.rows.map((r) => r.param.category))].sort();

  return (
    <div style={{ padding: 12, height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10.5, color: "var(--text-3)", fontWeight: 600, letterSpacing: 0.4 }}>
            INSPECTOR · PARAMETER DETAILS
          </div>
          <Typography.Title level={5} style={{ marginBottom: 0, marginTop: 2 }}>{p.name}</Typography.Title>
          <div style={{ marginTop: 4 }}>
            <Tag color="geekblue">{p.type}</Tag>
            {p.secret && <Tag color="gold">secret</Tag>}
            {bindingsOf(p).length === 0 && <Tag color="purple">design</Tag>}
          </div>
        </div>
        {/* No Edit button. The fields below ARE the form; a Save/Cancel bar
            appears under them the moment something really differs. What is
            worth saying up here is that one is waiting. */}
        {metaDirty && (
          <Tag color="warning" style={{ flexShrink: 0, marginInlineEnd: 0 }}>
            unsaved
          </Tag>
        )}
        {row.pendingMeta && (
          <Tooltip title="A change in your draft rewrites this parameter's settings. What you see here is what it will say once that change is published.">
            <Tag color="processing" style={{ flexShrink: 0, marginInlineEnd: 0 }}>
              in review
            </Tag>
          </Tooltip>
        )}
      </div>
      <Divider style={{ margin: "10px 0" }} />
      {/* Three tabs, and each one is a QUESTION rather than a filing cabinet
          drawer. Six tabs meant the reader had to know which drawer an answer
          had been filed in before they could ask - and "Overview" against
          "Details" is not a distinction anybody could make in advance.

            Overview - what is this, and what is it set to right now
            Rules    - what may it be, and what else does it touch
            History  - when did it arrive, when does it go, what happened to it

          The old keys still resolve (the grid's row menu links straight to an
          answer), so a link to "details" or "validation" lands where that
          content moved rather than on a tab that no longer exists. */}
      <Tabs
        size="small"
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "overview",
            label: (
              <span>
                <InfoCircleOutlined style={{ marginInlineEnd: 6 }} />
                Overview
              </span>
            ),
            children: (
              <OverviewTab
                row={row}
                grid={grid}
                categories={categories}
                onDirtyChange={setMetaDirty}
              />
            ),
          },
          {
            key: "rules",
            label: (
              <span>
                <ShieldOutlined style={{ marginInlineEnd: 6 }} />
                Rules
              </span>
            ),
            children: (
              <>
                <RuleEditor param={p} onEditDefault={editDefault} />
                <Divider style={{ margin: "16px 0 12px" }} />
                <DependenciesTab p={p} grid={grid} onSelect={selectParam} />
              </>
            ),
          },
          {
            key: "history",
            label: (
              <span>
                <HistoryOutlined style={{ marginInlineEnd: 6 }} />
                History
              </span>
            ),
            children: (
              <>
                <VersionsTab row={row} grid={grid} />
                <Divider style={{ margin: "16px 0 12px" }} />
                <ParamHistoryTab paramId={p.id} instances={grid.instances} />
              </>
            ),
          },
        ]}
      />
      <Divider style={{ margin: "10px 0" }} />
      {canEdit && (
      <Popconfirm
        title={`Retire ${p.name}?`}
        description="Removes it from the catalog and deletes the key/element from every file it lives in, across all instances. Committed to Git with attribution."
        okText="Retire"
        okButtonProps={{ danger: true }}
        onConfirm={() => retire.mutate(p.id)}
      >
        <Button block danger icon={<DeleteOutlined />} style={{ marginTop: 8 }} loading={retire.isPending}>
          Retire Parameter
        </Button>
      </Popconfirm>
      )}
    </div>
  );
}
