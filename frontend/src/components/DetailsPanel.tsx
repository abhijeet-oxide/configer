import { Tabs, Descriptions, Tag, Typography, Divider, Button, Statistic, Row as ARow, Col, Popconfirm, Select, Switch, Form, Input, AutoComplete, Space, Tooltip, App as AntApp } from "antd";
import { DeleteOutlined, EditOutlined, LinkOutlined, CheckOutlined, CloseOutlined, FileTextOutlined, ScopeGlobalOutlined, ScopeInstanceOutlined, UndoOutlined } from "../icons";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bindingsOf, expandBinding, type Grid, type Parameter, type Scope, type Row as GridRow, type Cell } from "../api";
import { fmtValue } from "../rules";
import { useUI } from "../store";
import RuleEditor from "./RuleEditor";
import PathPicker from "./PathPicker";
import { relTime } from "./DashboardView";

// Right-hand Parameter Details panel: metadata, schema/validation, and a small
// value summary across instances. One overall Edit button turns every major
// field into a form (saved as a single attributed catalog commit); the source
// file/path change only through the interactive attach picker, never as free
// text. A parameter without a source is in the design phase: fully editable
// and valued, rendered nowhere until attached.

const scopeOptions: Scope[] = ["global", "instance"];
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
      api.updateParameter(p.id, { ...v, author: "demo-user" }),
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
          <Tooltip title="Open this file in the Files workspace">
            <Button
              size="small"
              type="text"
              icon={<FileTextOutlined />}
              onClick={() => {
                const inst =
                  grid.instances.find((x) => x.name === selectedInstance) ?? grid.instances[0];
                setFileFocus({ path: expandBinding(s, inst), instance: inst?.name });
                setSection("files");
              }}
              aria-label="Open in Files"
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
          children: (
            <Tag>
              {p.scope === "global" ? (
                <ScopeGlobalOutlined style={{ marginInlineEnd: 4 }} />
              ) : (
                <ScopeInstanceOutlined style={{ marginInlineEnd: 4 }} />
              )}
              {p.scope}
            </Tag>
          ),
        },
        { key: "secret", label: "Secret", children: p.secret ? <Tag color="gold">yes</Tag> : "no" },
        { key: "default", label: "Default Value", children: <span className="mono">{p.default === undefined || p.default === null ? "-" : Array.isArray(p.default) ? (p.default as unknown[]).join(", ") : String(p.default)}</span> },
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
  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft });
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
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
              >
                <a onClick={() => jumpTo(it.paramId)} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {it.paramId} · {it.instance || "global"}
                  </span>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {fmtValue(it.old)} → {fmtValue(it.new)}
                  </Typography.Text>
                </a>
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
      <span className="mono" style={{ fontSize: 12, color: cell.valid ? undefined : "#cf1322" }}>
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
function OverviewTab({ row, grid }: { row: GridRow; grid: Grid }) {
  const values = grid.instances.map((i) => ({ inst: i, cell: row.cells[i.name] }));
  const set = values.filter((v) => v.cell?.set).length;
  const invalid = values.filter((v) => v.cell && !v.cell.valid).length;
  return (
    <div>
      <ARow gutter={8} style={{ marginBottom: 12 }}>
        <Col span={8}><Statistic title="Set" value={set} valueStyle={{ fontSize: 18 }} /></Col>
        <Col span={8}><Statistic title="Instances" value={grid.instances.length} valueStyle={{ fontSize: 18 }} /></Col>
        <Col span={8}><Statistic title="Invalid" value={invalid} valueStyle={{ fontSize: 18, color: invalid ? "#cf1322" : undefined }} /></Col>
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

// HISTORY tab: how this parameter's value changed over time, drawn as a small
// git-graph timeline (VS-Code / GitHub style). Commits where the value actually
// changed are emphasized; unchanged commits are dimmed. When an instance is
// selected the timeline resolves that instance's effective value, otherwise the
// catalog default (base value).
function ParamHistoryTab({ paramId }: { paramId: string }) {
  const { selectedInstance } = useUI();
  const q = useQuery({
    queryKey: ["paramHistory", paramId, selectedInstance],
    queryFn: () => api.parameterHistory(paramId, selectedInstance ? { instance: selectedInstance } : undefined),
  });
  const entries = q.data?.entries ?? [];
  const supported = q.data?.supported ?? true;

  if (q.isLoading) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>Loading history…</Typography.Text>;
  if (!supported)
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        History is available for repositories cloned or opened on the server.
      </Typography.Text>
    );
  if (entries.length === 0)
    return <Typography.Text type="secondary" style={{ fontSize: 12 }}>No recorded changes for this parameter.</Typography.Text>;

  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: 0.4 }}>
        VALUE OVER TIME{selectedInstance ? ` · ${selectedInstance}` : " · default"}
      </Typography.Text>
      <div style={{ marginTop: 10 }}>
        {entries.map((e, i) => {
          const last = i === entries.length - 1;
          const dim = !e.changed;
          return (
            <div key={e.sha} style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 14 }}>
                <span
                  style={{
                    width: e.changed ? 11 : 8,
                    height: e.changed ? 11 : 8,
                    borderRadius: "50%",
                    background: e.changed ? "#2f6bff" : "rgba(127,137,160,0.6)",
                    marginTop: 4,
                    flexShrink: 0,
                  }}
                />
                {!last && <span style={{ flex: 1, width: 2, background: "rgba(127,137,160,0.3)", marginTop: 2 }} />}
              </div>
              <div style={{ paddingBottom: 14, minWidth: 0, flex: 1, opacity: dim ? 0.6 : 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontSize: 12.5, fontWeight: e.changed ? 600 : 400 }}>
                    {e.present ? (e.value === "" ? "(empty)" : e.value) : "(not defined)"}
                  </span>
                  {e.changed && i !== entries.length - 1 && (
                    <Tag color="blue" style={{ fontSize: 10, margin: 0 }}>changed</Tag>
                  )}
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {e.short} · {e.author} · {relTime(e.date)}
                </Typography.Text>
                <div style={{ fontSize: 11, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.message}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DetailsPanel({ grid }: { grid: Grid }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { selectedParamId, selectParam } = useUI();
  const row = grid.rows.find((r) => r.param.id === selectedParamId);
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  // A newly selected parameter always opens read-only.
  useEffect(() => setEditing(false), [selectedParamId]);

  const retire = useMutation({
    mutationFn: (id: string) => api.deleteParameter(id, "demo-user"),
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
        <Button
          size="small"
          type={editing ? "primary" : "text"}
          icon={<EditOutlined />}
          onClick={() => {
            setTab("details");
            setEditing(true);
          }}
          style={{ flexShrink: 0 }}
        >
          Edit
        </Button>
      </div>
      <Divider style={{ margin: "10px 0" }} />
      <Tabs
        size="small"
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: "overview", label: "Overview", children: <OverviewTab row={row} grid={grid} /> },
          { key: "details", label: "Details", children: <DetailsTab p={p} categories={categories} grid={grid} editing={editing} setEditing={setEditing} /> },
          { key: "validation", label: "Validation", children: <RuleEditor param={p} /> },
          { key: "depends", label: "Dependencies", children: <DependenciesTab p={p} grid={grid} onSelect={selectParam} /> },
          { key: "versions", label: "Versions", children: <VersionsTab row={row} grid={grid} /> },
          { key: "history", label: "History", children: <ParamHistoryTab paramId={p.id} /> },
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
