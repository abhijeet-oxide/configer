import { Select, Segmented, Switch, Space, Table, Tag, Typography, Empty, Input } from "antd";
import { SwapOutlined, SearchOutlined, ArrowRightOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type DiffChange, type Grid } from "../api";
import { DiffMiniBar } from "./charts";
import { useUI } from "../store";

// Compare view: pick two instances and read a parameter-level diff. Two real
// layouts: Side by Side (a column per instance) and Inline (one unified
// column, old value struck through, arrow, new value). A search box makes
// large diffs navigable.
const statusColor: Record<string, string> = {
  added: "green",
  removed: "red",
  modified: "orange",
  unchanged: "default",
};

export default function ComparePanel({ grid }: { grid: Grid }) {
  const { compareLeft, compareRight, setCompare } = useUI();
  const left = compareLeft || grid.instances[0]?.name;
  const right = compareRight || grid.instances[2]?.name || grid.instances[1]?.name;
  const [changesOnly, setChangesOnly] = useState(true);
  const [layout, setLayout] = useState<"Inline" | "Side by Side">("Side by Side");
  const [q2, setQ2] = useState("");

  const q = useQuery({
    queryKey: ["compare", left, right],
    queryFn: () => api.compare(left, right),
    enabled: !!left && !!right && left !== right,
  });

  const rows = useMemo(() => {
    let changes = q.data?.changes ?? [];
    if (changesOnly) changes = changes.filter((c) => c.status !== "unchanged");
    const needle = q2.trim().toLowerCase();
    if (needle)
      changes = changes.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          String(c.left ?? "").toLowerCase().includes(needle) ||
          String(c.right ?? "").toLowerCase().includes(needle),
      );
    return changes;
  }, [q.data, changesOnly, q2]);

  const options = grid.instances.map((i) => ({ value: i.name, label: `${i.name} (${i.softwareVersion})` }));

  const valueColumns =
    layout === "Side by Side"
      ? [
          { title: left, dataIndex: "left" as const, render: (v: unknown) => <span className="mono">{String(v ?? "-")}</span> },
          { title: right, dataIndex: "right" as const, render: (v: unknown) => <span className="mono">{String(v ?? "-")}</span> },
        ]
      : [
          {
            title: `${left} vs ${right}`,
            key: "unified",
            render: (_v: unknown, c: DiffChange) =>
              c.status === "unchanged" ? (
                <span className="mono">{String(c.left ?? "-")}</span>
              ) : (
                <span className="mono">
                  <span style={{ textDecoration: "line-through", opacity: 0.55 }}>{String(c.left ?? "-")}</span>
                  <ArrowRightOutlined style={{ margin: "0 8px", opacity: 0.45, fontSize: 11 }} />
                  <span style={{ color: "#389e0d" }}>{String(c.right ?? "-")}</span>
                </span>
              ),
          },
        ];

  return (
    <div style={{ padding: "8px 12px", height: "100%", display: "flex", flexDirection: "column" }}>
      <Space wrap style={{ marginBottom: 8 }}>
        <Typography.Text strong>Compare</Typography.Text>
        <Select size="small" style={{ width: 200 }} value={left} options={options}
          onChange={(v) => setCompare(v, right)} />
        <SwapOutlined onClick={() => setCompare(right, left)} style={{ cursor: "pointer" }} />
        <Select size="small" style={{ width: 200 }} value={right} options={options}
          onChange={(v) => setCompare(left, v)} />
        <Segmented
          size="small"
          value={layout}
          options={["Inline", "Side by Side"]}
          onChange={(v) => setLayout(v as typeof layout)}
        />
        <span>
          <Switch size="small" checked={changesOnly} onChange={setChangesOnly} /> Changes only
        </span>
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
          placeholder="Search this diff"
          value={q2}
          onChange={(e) => setQ2(e.target.value)}
          style={{ width: 180 }}
        />
        {q.data && (
          <Space size={6} align="center">
            <DiffMiniBar
              modified={q.data.summary.modified}
              added={q.data.summary.added}
              removed={q.data.summary.removed}
              unchanged={q.data.summary.unchanged}
            />
            <Tag color="orange">{q.data.summary.modified} modified</Tag>
            <Tag color="green">{q.data.summary.added} added</Tag>
            <Tag color="red">{q.data.summary.removed} removed</Tag>
            <Tag>{q.data.summary.unchanged} unchanged</Tag>
          </Space>
        )}
      </Space>
      <div style={{ flex: 1, overflow: "auto" }}>
        {left === right ? (
          <Empty description="Pick two different instances" />
        ) : (
          <Table<DiffChange>
            rowKey="paramId"
            size="small"
            loading={q.isLoading}
            dataSource={rows}
            pagination={false}
            columns={[
              { title: "Parameter", dataIndex: "name", width: 240 },
              ...valueColumns,
              { title: "Change", dataIndex: "status", width: 120,
                render: (s: string) => <Tag color={statusColor[s]}>{s}</Tag> },
            ]}
          />
        )}
      </div>
    </div>
  );
}
