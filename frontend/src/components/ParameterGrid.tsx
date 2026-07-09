import { Table, Tag, Tooltip, Space, Button, Typography } from "antd";
import {
  FilterOutlined,
  GroupOutlined,
  EyeOutlined,
  UndoOutlined,
  RedoOutlined,
  EditOutlined,
  LockOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useMemo } from "react";
import type { Cell, Grid, Instance, Row } from "../api";
import { useUI } from "../store";

// Short abbreviations for the scope source badge on each cell.
const scopeAbbrev: Record<string, string> = {
  default: "def",
  global: "glb",
  environment: "env",
  site: "site",
  zone: "zone",
  instance: "inst",
};

function CellView({ cell }: { cell: Cell | undefined }) {
  if (!cell) return <span style={{ opacity: 0.3 }}>—</span>;
  if (cell.state === "na") return <span className="cell-na">n/a</span>;

  const cls: string[] = [];
  if (cell.state === "deprecated") cls.push("cell-deprecated");
  if (cell.state === "new") cls.push("cell-new");
  if (!cell.valid) cls.push("cell-invalid");

  let display: React.ReactNode;
  if (cell.value === undefined || cell.value === null || cell.value === "") {
    display = <span style={{ opacity: 0.3 }}>—</span>;
  } else if (typeof cell.value === "boolean") {
    display = <Tag color={cell.value ? "green" : "default"}>{cell.value ? "on" : "off"}</Tag>;
  } else {
    display = <span className="mono">{String(cell.value)}</span>;
  }

  const inner = (
    <span className={cls.join(" ")}>
      {display}
      {cell.set && cell.source !== "instance" && (
        <span className="source-badge">{scopeAbbrev[cell.source]}</span>
      )}
    </span>
  );
  return !cell.valid && cell.message ? <Tooltip title={cell.message}>{inner}</Tooltip> : inner;
}

function GridToolbar({ shown, total }: { shown: number; total: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
      <Typography.Text strong>IP Configuration</Typography.Text>
      <Tag>{shown} parameters</Tag>
      <div style={{ flex: 1 }} />
      <Space size={4}>
        <Button size="small" icon={<FilterOutlined />}>Filter</Button>
        <Button size="small" icon={<GroupOutlined />}>Group</Button>
        <Button size="small" icon={<EyeOutlined />}>View</Button>
        <Button size="small" type="primary" ghost icon={<EditOutlined />}>Bulk Edit</Button>
        <Button size="small" type="text" icon={<UndoOutlined />} />
        <Button size="small" type="text" icon={<RedoOutlined />} />
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {shown} of {total}
      </Typography.Text>
    </div>
  );
}

function instanceHeader(inst: Instance) {
  return (
    <div style={{ lineHeight: 1.2 }}>
      <div>{inst.name}</div>
      <div style={{ fontSize: 10, fontWeight: 400, opacity: 0.6 }}>{inst.softwareVersion}</div>
    </div>
  );
}

export default function ParameterGrid({ grid }: { grid: Grid }) {
  const { categoryKey, selectedParamId, selectParam } = useUI();

  const rows = useMemo(
    () =>
      grid.rows.filter((r) =>
        !categoryKey ? true : r.param.category === categoryKey || r.param.category.startsWith(categoryKey + "/"),
      ),
    [grid.rows, categoryKey],
  );

  const columns: ColumnsType<Row> = useMemo(() => {
    const base: ColumnsType<Row> = [
      {
        title: "Parameter",
        dataIndex: ["param", "name"],
        key: "param",
        fixed: "left",
        width: 230,
        render: (_v, r) => (
          <Space size={4}>
            {r.param.secret && <LockOutlined style={{ color: "#faad14" }} />}
            <span>{r.param.name}</span>
          </Space>
        ),
      },
      {
        title: "Type",
        key: "type",
        width: 90,
        render: (_v, r) => <Tag>{r.param.type}</Tag>,
      },
      {
        title: "Description",
        key: "desc",
        width: 190,
        ellipsis: true,
        render: (_v, r) => (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.param.displayName || r.param.description}
          </Typography.Text>
        ),
      },
    ];
    const instCols: ColumnsType<Row> = grid.instances.map((inst) => ({
      title: instanceHeader(inst),
      key: inst.name,
      width: 130,
      render: (_v, r) => <CellView cell={r.cells[inst.name]} />,
    }));
    return [...base, ...instCols];
  }, [grid.instances]);

  const scrollX = 230 + 90 + 190 + grid.instances.length * 130;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <GridToolbar shown={rows.length} total={grid.rows.length} />
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Table<Row>
          rowKey={(r) => r.param.id}
          columns={columns}
          dataSource={rows}
          size="small"
          virtual
          scroll={{ x: scrollX, y: 520 }}
          pagination={false}
          onRow={(r) => ({
            onClick: () => selectParam(r.param.id),
            style:
              r.param.id === selectedParamId
                ? { background: "rgba(47,107,255,0.08)", cursor: "pointer" }
                : { cursor: "pointer" },
          })}
        />
      </div>
    </div>
  );
}
