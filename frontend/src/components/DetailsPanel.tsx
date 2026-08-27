import { Tabs, Descriptions, Tag, Typography, Divider, Button, Statistic, Row as ARow, Col, Popconfirm, Select, Switch, Form, Input, AutoComplete, Space, Tooltip, App as AntApp } from "antd";
import {
  DeleteOutlined, EditOutlined, HistoryOutlined, InfoCircleOutlined, LinkOutlined,
  CheckOutlined, CloseOutlined, ScopeGlobalOutlined, ScopeSiteOutlined, ScopeInstanceOutlined,
  ShieldOutlined, UndoOutlined,
} from "../icons";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { api, bindingsOf, expandBinding, type Grid, type Parameter, type Scope, type Row as GridRow, type Cell } from "../api";
import { fmtValue } from "../rules";
import { effectiveScope, SCOPE_META } from "../scope";
import { useUI } from "../store";
import ValueDiff from "./ui/ValueDiff";
import RuleEditor from "./RuleEditor";
import { ParamHistorySkeleton } from "./Skeletons";
import PathPicker from "./PathPicker";
import { relTime } from "./DashboardView";
import { useIdentity } from "../identity";
import { c } from "../uikit";
import ParameterFlow from "./ParameterFlow";

// Right-hand Parameter Details panel: metadata, schema/validation, and a small
// value summary across instances. One overall Edit button turns every major
// field into a form (saved as a single attributed catalog commit); the source
// file/path change only through the interactive attach picker, never as free
// text. A parameter without a source is in the design phase: fully editable
// and valued, rendered nowhere until attached.

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

function DetailsTab({
  p,
  categories,
  grid,
  editing,
  setEditing,
}: {
  p: Parameter;
  categories: string[];
  grid: Grid;
  editing: boolean;
  setEditing: (v: boolean) => void;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { selectedInstance, setFileFocus, setSection } = useUI();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [form] = Form.useForm<EditValues>();
  // A parameter can map to several locations (its bindings). It is in the
  // design phase only when it maps to none.
  const allSources = bindingsOf(p).filter((b) => b.file);
  const design = allSources.length === 0;

  const patch = useMutation({
    mutationFn: (v: Parameters<typeof api.updateParameter>[1]) =>
      api.updateParameter(p.id, { ...v, author: "Local user" }),
    onSuccess: () => {
      message.success("Saved to the catalog (committed to Git with attribution)");
      setEditing(false);
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  // The Edit action now lives in the panel header (see DetailsPanel); when it
  // flips `editing` on, populate the form from the current parameter.
  useEffect(() => {
    if (!editing) return;
    form.setFieldsValue({
      displayName: p.displayName,
      description: p.description,
      category: p.category,
      type: p.type,
      itemType: p.itemType ?? "string",
      scope: p.scope,
      secret: p.secret,
      default: p.default === undefined || p.default === null ? "" : Array.isArray(p.default) ? (p.default as unknown[]).join(", ") : String(p.default),
      derived: p.derived ?? "",
    });
  }, [editing, p, form]);

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
      ...(d !== undefined ? { default: d } : {}),
      derived: (v.derived ?? "").trim(),
    });
  };

  const sourceRow = design ? (
    <Space direction="vertical" size={4}>
      <Tag color="purple">design phase: not attached yet</Tag>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        Values can be set and reviewed now; they render into files once attached.
      </Typography.Text>
      <Button size="small" type="primary" icon={<LinkOutlined />} onClick={() => setPickerOpen(true)}>
        Attach to a file…
      </Button>
    </Space>
  ) : (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {allSources.length > 1 && (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          Mapped to {allSources.length} locations · one edit updates all
        </Typography.Text>
      )}
      {allSources.map((s, i) => (
        <div key={`${s.file}|${s.path}`} style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <span className="mono" style={{ fontSize: 12 }}>{s.file}</span>
            {i === 0 && allSources.length > 1 && (
              <Tag style={{ marginInlineStart: 6, fontSize: 10 }}>primary</Tag>
            )}
            <div className="mono" style={{ fontSize: 11, opacity: 0.65 }}>{s.path}</div>
          </div>
          <Tooltip title="Open the file and jump to this line">
            <Button
              size="small"
              type="link"
              icon={<LinkOutlined />}
              onClick={async () => {
                const inst =
                  grid.instances.find((x) => x.name === selectedInstance) ?? grid.instances[0];
                const file = expandBinding(s, inst);
                // Resolve the exact line first (best effort; YAML/JSON/XML), then
                // open the file focused on it. A miss just opens at the top.
                let line: number | undefined;
                try {
                  line = (await api.locate(file, s.path, s.format)).line || undefined;
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
      <Button size="small" icon={<LinkOutlined />} onClick={() => setPickerOpen(true)}>
        Re-map…
      </Button>
    </Space>
  );

  if (editing) {
    return (
      <Form form={form} layout="vertical" size="small" onFinish={save}>
        <Form.Item name="displayName" label="Display name" style={{ marginBottom: 8 }}>
          <Input placeholder="Human-friendly name" autoFocus />
        </Form.Item>
        <Form.Item name="description" label="Description" style={{ marginBottom: 8 }}>
          <Input.TextArea rows={3} placeholder="What does this parameter control?" />
        </Form.Item>
        <div style={{ display: "flex", gap: 8 }}>
          <Form.Item name="category" label="Category" style={{ flex: 1, marginBottom: 8 }} rules={[{ required: true }]}>
            <AutoComplete
              options={categories.map((c) => ({ value: c }))}
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
          <Form.Item name="scope" label="Scope" style={{ flex: 1, marginBottom: 8 }}>
            <Select options={scopeOptions.map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="secret" label="Secret" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Switch size="small" />
          </Form.Item>
        </div>
        <Form.Item
          name="default"
          label="Default value (lists comma-separated)"
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
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button size="small" icon={<CloseOutlined />} onClick={() => setEditing(false)} disabled={patch.isPending}>
            Cancel
          </Button>
          <Button type="primary" size="small" icon={<CheckOutlined />} htmlType="submit" loading={patch.isPending}>
            Save all
          </Button>
        </div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginTop: 8 }}>
          Saving makes one commit to the catalog with your attribution. The file and path are
          changed separately via {design ? "Attach" : "Re-map"}, so they stay validated.
        </Typography.Paragraph>
      </Form>
    );
  }

  return (
    <>
      <Descriptions column={1} size="small" bordered items={[
        { key: "display", label: "Display Name", children: p.displayName || <span style={{ opacity: 0.45 }}>-</span> },
        {
          key: "desc",
          label: "Description",
          children: p.description
            ? <Typography.Paragraph style={{ margin: 0, fontSize: 12 }}>{p.description}</Typography.Paragraph>
            : <span style={{ opacity: 0.45 }}>-</span>,
        },
        { key: "type", label: "Data Type", children: <Tag>{p.type}{p.type === "list" && p.itemType ? ` of ${p.itemType}` : ""}</Tag> },
        { key: "category", label: "Category", children: p.category },
        {
          key: "scope",
          label: "Scope",
          children: (() => {
            // The facet says what an edit DOES; the declared word is kept
            // beside it when it says more (which grouping a site scope means),
            // and dropped when it would only repeat the tag.
            const f = effectiveScope(p);
            const Icon = f === "global" ? ScopeGlobalOutlined : f === "site" ? ScopeSiteOutlined : ScopeInstanceOutlined;
            return (
              <Tooltip title={SCOPE_META[f].explain}>
                <Tag color={SCOPE_META[f].color}>
                  <Icon style={{ marginInlineEnd: 4 }} />
                  {SCOPE_META[f].label}
                  {p.scope && p.scope !== f ? ` · ${p.scope}` : ""}
                </Tag>
              </Tooltip>
            );
          })(),
        },
        { key: "secret", label: "Secret", children: p.secret ? <Tag color="gold">yes</Tag> : "no" },
        { key: "default", label: "Default Value", children: <span className="mono">{p.default === undefined || p.default === null ? "-" : Array.isArray(p.default) ? (p.default as unknown[]).join(", ") : String(p.default)}</span> },
        ...(p.derived ? [{ key: "derived", label: "Derived from", children: <span className="mono">{p.derived}</span> }] : []),
        ...(p.source ? [{ key: "srcmap", label: "Linked source", children: (
          <span><Tag color="geekblue">{p.source.sourceId}</Tag><span className="mono">{p.source.key}</span>{p.source.instance ? <Tag style={{ marginInlineStart: 4 }}>{p.source.instance}</Tag> : null}</span>
        ) }] : []),
        { key: "required", label: "Required", children: p.validation?.required ? "Yes" : "No" },
        { key: "intro", label: "Version Introduced", children: p.versionIntroduced || "-" },
        { key: "dep", label: "Version Deprecated", children: p.versionDeprecated || "-" },
        { key: "source", label: "Defined In", children: sourceRow },
      ]} />
      <PathPicker open={pickerOpen} onClose={() => setPickerOpen(false)} param={p} grid={grid} />
    </>
  );
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
    mutationFn: (it: { paramId: string; instance: string; scope?: string }) =>
      api.revertValue(it.paramId, it.scope === "global" ? "" : it.instance),
    onSuccess: refetchAll,
  });
  const discardAll = useMutation({
    mutationFn: async () => {
      for (const it of allDraftItems)
        await api.revertValue(
          it.action === "edit-file" ? `file:${it.file}` : it.paramId,
          it.scope === "global" ? "" : it.instance,
        );
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

// OVERVIEW tab: the value story for this parameter across every instance, plus
// the set/invalid summary that used to sit in the panel footer.
// OVERVIEW: what this parameter IS and what it is set to, in that order.
//
// These were two tabs, "Overview" and "Details", and nobody could say in
// advance which drawer an answer had been filed in - they are the same
// question asked twice. Editing opens the metadata form in place of the
// read-only half; the values stay on screen underneath, because "what am I
// changing this from" is the first thing anyone wants while they type.
function OverviewTab({
  row,
  grid,
  categories,
  editing,
  setEditing,
}: {
  row: GridRow;
  grid: Grid;
  categories: string[];
  editing: boolean;
  setEditing: (v: boolean) => void;
}) {
  const values = grid.instances.map((i) => ({ inst: i, cell: row.cells[i.name] }));
  const set = values.filter((v) => v.cell?.set).length;
  const invalid = values.filter((v) => v.cell && !v.cell.valid).length;
  return (
    <div>
      <ARow gutter={8} style={{ marginBottom: 12 }}>
        <Col span={8}><Statistic title="Set" value={set} valueStyle={{ fontSize: 18 }} /></Col>
        <Col span={8}><Statistic title="Instances" value={grid.instances.length} valueStyle={{ fontSize: 18 }} /></Col>
        <Col span={8}><Statistic title="Invalid" value={invalid} valueStyle={{ fontSize: 18, color: invalid ? c.danger : undefined }} /></Col>
      </ARow>
      <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: 0.4 }}>VALUE PER INSTANCE</Typography.Text>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        {values.map(({ inst, cell }) => (
          <div key={inst.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12 }}>{inst.name}</span>
            <CellValue cell={cell} />
          </div>
        ))}
      </div>
      <Divider style={{ margin: "16px 0 12px" }} />
      <DetailsTab
        p={row.param}
        categories={categories}
        grid={grid}
        editing={editing}
        setEditing={setEditing}
      />
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
function ParamHistoryTab({ paramId }: { paramId: string }) {
  const { selectedInstance, setSection } = useUI();
  const { canEdit } = useIdentity();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const q = useRepoQuery({
    queryKey: ["paramHistory", paramId, selectedInstance],
    queryFn: () => api.parameterHistory(paramId, selectedInstance ? { instance: selectedInstance } : undefined),
  });
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
          HOW THIS VALUE GOT HERE{selectedInstance ? ` · ${selectedInstance}` : " · default"}
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
  const [editing, setEditing] = useState(false);
  // A newly selected parameter always opens read-only.
  useEffect(() => setEditing(false), [selectedParamId]);

  // The one way into the metadata form, wherever it is asked for. The rules
  // editor shows the default but does not own it: a field edited from two forms
  // is a field two forms can disagree about, so the second one sends the reader
  // to the first rather than leaving them at a value they cannot change.
  const editDefault = () => {
    setTab("overview");
    setEditing(true);
  };

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
        {canEdit && (
          <Button
            size="small"
            type={editing ? "primary" : "text"}
            icon={<EditOutlined />}
            onClick={editDefault}
            style={{ flexShrink: 0 }}
          >
            Edit
          </Button>
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
                editing={editing}
                setEditing={setEditing}
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
                <ParamHistoryTab paramId={p.id} />
              </>
            ),
          },
        ]}
      />
      <Divider style={{ margin: "10px 0" }} />
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
    </div>
  );
}
