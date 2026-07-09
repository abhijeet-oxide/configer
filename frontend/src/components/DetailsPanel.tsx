import { Tabs, Descriptions, Tag, Typography, Empty, Divider, Button, Statistic, Row as ARow, Col } from "antd";
import { SafetyOutlined } from "@ant-design/icons";
import type { Grid, Parameter } from "../api";
import { useUI } from "../store";

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

function SchemaTab({ p }: { p: Parameter }) {
  const v = p.validation;
  if (!v) return <Empty description="No validation rules" />;
  return (
    <Descriptions column={1} size="small" bordered items={[
      ...(v.pattern ? [{ key: "pat", label: "Pattern", children: <span className="mono">{v.pattern}</span> }] : []),
      ...(v.enum ? [{ key: "enum", label: "Allowed", children: v.enum.map((e) => <Tag key={e}>{e}</Tag>) }] : []),
      ...(v.min !== undefined ? [{ key: "min", label: "Min", children: v.min }] : []),
      ...(v.max !== undefined ? [{ key: "max", label: "Max", children: v.max }] : []),
      ...(v.schemaRef ? [{ key: "ref", label: "Schema Ref", children: <span className="mono">{v.schemaRef}</span> }] : []),
    ]} />
  );
}

export default function DetailsPanel({ grid }: { grid: Grid }) {
  const selectedParamId = useUI((s) => s.selectedParamId);
  const row = grid.rows.find((r) => r.param.id === selectedParamId);

  if (!row) {
    return (
      <div style={{ padding: 16 }}>
        <Empty description="Select a parameter to see details" />
      </div>
    );
  }
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
          { key: "schema", label: "Schema", children: <SchemaTab p={p} /> },
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
