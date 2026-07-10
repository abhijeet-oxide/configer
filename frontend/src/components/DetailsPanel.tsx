import { Tabs, Descriptions, Tag, Typography, Empty, Divider, Button, Statistic, Row as ARow, Col, Popconfirm, Select, Switch, Form, Input, AutoComplete, Space, App as AntApp } from "antd";
import { SafetyOutlined, DeleteOutlined, EditOutlined, LinkOutlined, CheckOutlined, CloseOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Grid, type Parameter, type Scope } from "../api";
import { useUI } from "../store";
import RuleEditor from "./RuleEditor";
import PathPicker from "./PathPicker";

// Right-hand Parameter Details panel: metadata, schema/validation, and a small
// value summary across instances. One overall Edit button turns every major
// field into a form (saved as a single attributed catalog commit); the source
// file/path change only through the interactive attach picker, never as free
// text. A parameter without a source is in the design phase: fully editable
// and valued, rendered nowhere until attached.

const scopeOptions: Scope[] = ["global", "environment", "site", "zone", "instance"];
const typeOptions = ["string", "integer", "number", "boolean", "enum", "ipv4", "cidr", "list"];

interface EditValues {
  displayName?: string;
  description?: string;
  category: string;
  type: string;
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

function DetailsTab({ p, categories, grid }: { p: Parameter; categories: string[]; grid: Grid }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [form] = Form.useForm<EditValues>();
  const design = !p.source.file;

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

  const startEdit = () => {
    form.setFieldsValue({
      displayName: p.displayName,
      description: p.description,
      category: p.category,
      type: p.type,
      scope: p.scope,
      secret: p.secret,
      default: p.default === undefined || p.default === null ? "" : Array.isArray(p.default) ? (p.default as unknown[]).join(", ") : String(p.default),
    });
    setEditing(true);
  };

  const save = (v: EditValues) => {
    const d = coerceDefault(v.default, v.type);
    patch.mutate({
      displayName: v.displayName ?? "",
      description: v.description ?? "",
      category: v.category,
      type: v.type,
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
    <Space direction="vertical" size={2}>
      <span className="mono" style={{ fontSize: 12 }}>{p.source.file}</span>
      <span className="mono" style={{ fontSize: 11, opacity: 0.65 }}>{p.source.path}</span>
      <Button size="small" icon={<LinkOutlined />} onClick={() => setPickerOpen(true)}>
        Re-map…
      </Button>
    </Space>
  );

  if (editing) {
    return (
      <Form form={form} layout="vertical" size="small" onFinish={save}>
        <Form.Item name="displayName" label="Display name" style={{ marginBottom: 8 }}>
          <Input placeholder="Human-friendly name" />
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
        <Space>
          <Button type="primary" size="small" icon={<CheckOutlined />} htmlType="submit" loading={patch.isPending}>
            Save all
          </Button>
          <Button size="small" icon={<CloseOutlined />} onClick={() => setEditing(false)} disabled={patch.isPending}>
            Cancel
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginTop: 8 }}>
          Saving makes one commit to the catalog with your attribution. The file and path are
          changed separately via {design ? "Attach" : "Re-map"}, so they stay validated.
        </Typography.Paragraph>
      </Form>
    );
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
        <Button size="small" icon={<EditOutlined />} onClick={startEdit}>
          Edit
        </Button>
      </div>
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
        { key: "scope", label: "Scope", children: <Tag>{p.scope}</Tag> },
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

// ProjectOverview fills the details panel with useful, live numbers when no
// parameter is selected, no dead space on big monitors.
function ProjectOverview({ grid }: { grid: Grid }) {
  let invalid = 0;
  let overridden = 0;
  let deprecated = 0;
  let fresh = 0;
  for (const r of grid.rows) {
    for (const c of Object.values(r.cells)) {
      if (!c.valid) invalid++;
      if (c.set && c.source === "instance") overridden++;
      if (c.state === "deprecated") deprecated++;
      if (c.state === "new") fresh++;
    }
  }
  const envs = new Map<string, number>();
  for (const i of grid.instances) {
    const e = i.environment ?? "unknown";
    envs.set(e, (envs.get(e) ?? 0) + 1);
  }

  return (
    <div style={{ padding: 14, height: "100%", overflow: "auto" }}>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {grid.project}
      </Typography.Title>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Project overview: select a parameter row for details and rules.
      </Typography.Text>
      <Divider style={{ margin: "12px 0" }} />
      <ARow gutter={[8, 14]}>
        <Col span={12}><Statistic title="Parameters" value={grid.rows.length} valueStyle={{ fontSize: 20 }} /></Col>
        <Col span={12}><Statistic title="Instances" value={grid.instances.length} valueStyle={{ fontSize: 20 }} /></Col>
        <Col span={12}><Statistic title="Instance overrides" value={overridden} valueStyle={{ fontSize: 20 }} /></Col>
        <Col span={12}>
          <Statistic
            title="Invalid cells"
            value={invalid}
            valueStyle={{ fontSize: 20, color: invalid ? "#cf1322" : undefined }}
          />
        </Col>
        <Col span={12}><Statistic title="Newly introduced" value={fresh} valueStyle={{ fontSize: 20, color: fresh ? "#389e0d" : undefined }} /></Col>
        <Col span={12}><Statistic title="Deprecated" value={deprecated} valueStyle={{ fontSize: 20 }} /></Col>
      </ARow>
      <Divider style={{ margin: "12px 0" }} />
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>ENVIRONMENTS</Typography.Text>
      <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
        {[...envs.entries()].map(([e, n]) => (
          <Tag key={e}>{e} × {n}</Tag>
        ))}
      </div>
      <Divider style={{ margin: "12px 0" }} />
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>INSTANCES</Typography.Text>
      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
        {grid.instances.map((i) => (
          <div key={i.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span>{i.name}</span>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {i.softwareVersion} · {i.region ?? "-"}
            </Typography.Text>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DetailsPanel({ grid }: { grid: Grid }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { selectedParamId, selectParam } = useUI();
  const row = grid.rows.find((r) => r.param.id === selectedParamId);

  const retire = useMutation({
    mutationFn: (id: string) => api.deleteParameter(id, "demo-user"),
    onSuccess: () => {
      message.success("Parameter retired: removed from the catalog, all overlays, and every generated file");
      selectParam(null);
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  if (!row) return <ProjectOverview grid={grid} />;
  const p = row.param;
  const categories = [...new Set(grid.rows.map((r) => r.param.category))].sort();

  // small cross-instance summary
  const values = grid.instances.map((i) => row.cells[i.name]);
  const set = values.filter((c) => c?.set).length;
  const invalid = values.filter((c) => c && !c.valid).length;

  return (
    <div style={{ padding: 12, height: "100%", overflow: "auto" }}>
      <Typography.Title level={5} style={{ marginBottom: 0 }}>{p.name}</Typography.Title>
      <Tag color="geekblue">{p.type}</Tag>
      {p.secret && <Tag color="gold">secret</Tag>}
      {!p.source.file && <Tag color="purple">design</Tag>}
      <Divider style={{ margin: "10px 0" }} />
      <Tabs
        size="small"
        items={[
          { key: "details", label: "Details", children: <DetailsTab p={p} categories={categories} grid={grid} /> },
          { key: "schema", label: "Schema", children: <RuleEditor param={p} /> },
          { key: "history", label: "History", children: <Empty description="Git history (backend endpoint TODO)" /> },
          { key: "depends", label: "Depends On", children:
            (p.dependsOn?.length ? p.dependsOn.map((d) => <Tag key={d}>{d}</Tag>) : <Empty description="No dependencies" />) },
        ]}
      />
      <Divider style={{ margin: "10px 0" }} />
      <ARow gutter={8}>
        <Col span={8}><Statistic title="Set" value={set} valueStyle={{ fontSize: 18 }} /></Col>
        <Col span={8}><Statistic title="Instances" value={grid.instances.length} valueStyle={{ fontSize: 18 }} /></Col>
        <Col span={8}><Statistic title="Invalid" value={invalid} valueStyle={{ fontSize: 18, color: invalid ? "#cf1322" : undefined }} /></Col>
      </ARow>
      <Button block icon={<SafetyOutlined />} style={{ marginTop: 12 }}>View Parameter Schema</Button>
      <Popconfirm
        title={`Retire ${p.name}?`}
        description="Removes it from the catalog and every overlay; the key/element disappears from all generated files. Committed to Git with attribution."
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
