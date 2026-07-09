import { Select, Segmented, Switch, Space, Table, Tag, Typography, Empty } from "antd";
import { SwapOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type DiffChange, type Grid } from "../api";
import { useUI } from "../store";

// Bottom compare panel: pick two instances and see a parameter-level diff with
// a change summary, mirroring the reference layout's Diff view.
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

  const q = useQuery({
    queryKey: ["compare", left, right],
    queryFn: () => api.compare(left, right),
    enabled: !!left && !!right && left !== right,
  });

  const rows = useMemo(() => {
    const changes = q.data?.changes ?? [];
    return changesOnly ? changes.filter((c) => c.status !== "unchanged") : changes;
  }, [q.data, changesOnly]);

  const options = grid.instances.map((i) => ({ value: i.name, label: `${i.name} (${i.softwareVersion})` }));

  return (
    <div style={{ padding: "8px 12px", height: "100%", display: "flex", flexDirection: "column" }}>
      <Space wrap style={{ marginBottom: 8 }}>
        <Typography.Text strong>Compare</Typography.Text>
        <Select size="small" style={{ width: 200 }} value={left} options={options}
          onChange={(v) => setCompare(v, right)} />
        <SwapOutlined onClick={() => setCompare(right, left)} style={{ cursor: "pointer" }} />
        <Select size="small" style={{ width: 200 }} value={right} options={options}
          onChange={(v) => setCompare(left, v)} />
        <Segmented size="small" options={["Inline", "Side by Side"]} />
        <span>
          <Switch size="small" checked={changesOnly} onChange={setChangesOnly} /> Changes only
        </span>
        {q.data && (
          <Space size={4}>
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
              { title: left, dataIndex: "left", render: (v) => <span className="mono">{String(v ?? "—")}</span> },
              { title: right, dataIndex: "right", render: (v) => <span className="mono">{String(v ?? "—")}</span> },
              { title: "Change", dataIndex: "status", width: 120,
                render: (s: string) => <Tag color={statusColor[s]}>{s}</Tag> },
            ]}
          />
        )}
      </div>
    </div>
  );
}
