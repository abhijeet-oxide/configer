import { Tabs, Descriptions, Tag, Typography, Empty, Divider, Button, Statistic, Row as ARow, Col } from "antd";
import { SafetyOutlined } from "@ant-design/icons";
import type { Grid, Parameter } from "../api";
import { useUI } from "../store";
import RuleEditor from "./RuleEditor";

// Right-hand Parameter Details panel: metadata, schema/validation, and a small
// value summary across instances.
function DetailsTab({ p }: { p: Parameter }) {
  return (
    <Descriptions column={1} size="small" bordered items={[
      { key: "desc", label: "Description", children: p.description || "—" },
      { key: "type", label: "Data Type", children: <Tag>{p.type}</Tag> },
      { key: "default", label: "Default Value", children: <span className="mono">{String(p.default ?? "—")}</span> },
      { key: "required", label: "Required", children: p.validation?.required ? "Yes" : "No" },
      { key: "scope", label: "Scope", children: <Tag color="blue">{p.scope}</Tag> },
      { key: "secret", label: "Secret", children: p.secret ? <Tag color="gold">secret</Tag> : "No" },
      { key: "intro", label: "Version Introduced", children: p.versionIntroduced || "—" },
      { key: "dep", label: "Version Deprecated", children: p.versionDeprecated || "—" },
      { key: "file", label: "Defined In", children: <span className="mono">{p.source.file}</span> },
      { key: "path", label: "Path", children: <span className="mono">{p.source.path}</span> },
    ]} />
  );
}

// ProjectOverview fills the details panel with useful, live numbers when no
// parameter is selected — no dead space on big monitors.
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
        Project overview — select a parameter row for details and rules.
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
              {i.softwareVersion} · {i.region ?? "—"}
            </Typography.Text>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DetailsPanel({ grid }: { grid: Grid }) {
  const selectedParamId = useUI((s) => s.selectedParamId);
  const row = grid.rows.find((r) => r.param.id === selectedParamId);

  if (!row) return <ProjectOverview grid={grid} />;
  const p = row.param;

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
          { key: "details", label: "Details", children: <DetailsTab p={p} /> },
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
    </div>
  );
}
