import { Tabs, Descriptions, Tag, Typography, Empty, Divider, Button, Statistic, Row as ARow, Col, Popconfirm, Select, Switch, Tooltip, App as AntApp } from "antd";
import { SafetyOutlined, DeleteOutlined, LockOutlined } from "@ant-design/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Grid, type Parameter, type Scope } from "../api";
import { useUI } from "../store";
import RuleEditor from "./RuleEditor";

// Right-hand Parameter Details panel: metadata, schema/validation, and a small
// value summary across instances. Descriptive metadata (description, display
// name, category, scope, secret) is editable in place; the source file/path
// is locked because it is the parameter's identity in the repository.

const scopeOptions: Scope[] = ["global", "environment", "site", "zone", "instance"];

function Locked({ text }: { text: string }) {
  return (
    <Tooltip title="Fixed: this is where the parameter lives in the repository. Re-import to change it.">
      <span className="mono" style={{ opacity: 0.75 }}>
        {text} <LockOutlined style={{ fontSize: 11, opacity: 0.6 }} />
      </span>
    </Tooltip>
  );
}

function DetailsTab({ p, categories }: { p: Parameter; categories: string[] }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const patch = useMutation({
    mutationFn: (v: Parameters<typeof api.updateParameter>[1]) =>
      api.updateParameter(p.id, { ...v, author: "demo-user" }),
    onSuccess: () => {
      message.success("Saved to the catalog (committed to Git with attribution)");
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Descriptions column={1} size="small" bordered items={[
      {
        key: "desc",
        label: "Description",
        children: (
          <Typography.Paragraph
            style={{ margin: 0, fontSize: 12 }}
            editable={{
              tooltip: "Edit description",
              onChange: (v) => {
                if (v !== (p.description ?? "")) patch.mutate({ description: v });
              },
            }}
          >
            {p.description || ""}
          </Typography.Paragraph>
        ),
      },
      {
        key: "display",
        label: "Display Name",
        children: (
          <Typography.Paragraph
            style={{ margin: 0, fontSize: 12 }}
            editable={{
              tooltip: "Edit display name",
              onChange: (v) => {
                if (v !== (p.displayName ?? "")) patch.mutate({ displayName: v });
              },
            }}
          >
            {p.displayName || ""}
          </Typography.Paragraph>
        ),
      },
      { key: "type", label: "Data Type", children: <Tag>{p.type}</Tag> },
      {
        key: "category",
        label: "Category",
        children: (
          <Select
            size="small"
            variant="borderless"
            style={{ width: "100%", marginInlineStart: -8 }}
            value={p.category}
            options={categories.map((c) => ({ value: c, label: c }))}
            showSearch
            onChange={(v) => patch.mutate({ category: v })}
          />
        ),
      },
      {
        key: "scope",
        label: "Scope",
        children: (
          <Select
            size="small"
            variant="borderless"
            style={{ width: "100%", marginInlineStart: -8 }}
            value={p.scope}
            options={scopeOptions.map((s) => ({ value: s, label: s }))}
            onChange={(v) => patch.mutate({ scope: v })}
          />
        ),
      },
      {
        key: "secret",
        label: "Secret",
        children: (
          <Switch
            size="small"
            checked={p.secret}
            onChange={(v) => patch.mutate({ secret: v })}
          />
        ),
      },
      { key: "default", label: "Default Value", children: <span className="mono">{String(p.default ?? "-")}</span> },
      { key: "required", label: "Required", children: p.validation?.required ? "Yes" : "No" },
      { key: "intro", label: "Version Introduced", children: p.versionIntroduced || "-" },
      { key: "dep", label: "Version Deprecated", children: p.versionDeprecated || "-" },
      { key: "file", label: "Defined In", children: <Locked text={p.source.file} /> },
      { key: "path", label: "Path", children: <Locked text={p.source.path} /> },
    ]} />
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
      <Divider style={{ margin: "10px 0" }} />
      <Tabs
        size="small"
        items={[
          { key: "details", label: "Details", children: <DetailsTab p={p} categories={categories} /> },
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
