import { Card, Input, Tag, Typography, Empty } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useMemo } from "react";
import type { Grid, Row } from "../api";
import { fmtValue } from "../rules";
import { useUI } from "../store";

// MobileParamList is the phone-tier view of the grid: one card per parameter
// showing every instance's value with its state marks. Optimized for reading
// and checking on the go; editing lives on tablet and up.
function CardFor({ row, instances }: { row: Row; instances: Grid["instances"] }) {
  const p = row.param;
  return (
    <Card size="small" style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <Typography.Text strong className="mono" style={{ fontSize: 13 }}>
          {p.name}
        </Typography.Text>
        <Tag style={{ fontSize: 10, marginInlineEnd: 0 }}>{p.type}</Tag>
      </div>
      {(p.displayName || p.description) && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 2 }}>
          {p.displayName || p.description}
        </Typography.Text>
      )}
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
        {instances.map((inst) => {
          const c = row.cells[inst.name];
          if (!c) return null;
          const cls = c.excluded
            ? "cell-excluded"
            : !c.valid
              ? "cell-invalid"
              : c.pending
                ? "cell-pending"
                : c.state === "deprecated"
                  ? "cell-deprecated"
                  : c.state === "na"
                    ? "cell-na"
                    : "";
          return (
            <div key={inst.name} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{inst.name}</Typography.Text>
              <span className={`mono ${cls}`}>
                {c.excluded ? "∅ excluded" : c.state === "na" ? "n/a" : fmtValue(c.value)}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default function MobileParamList({ grid }: { grid: Grid }) {
  const { search, setSearch } = useUI();
  const q = search.trim().toLowerCase();

  const rows = useMemo(
    () =>
      grid.rows.filter((r) => {
        if (!q) return true;
        const hay = [r.param.name, r.param.displayName, r.param.description, r.param.category]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (hay.includes(q)) return true;
        return Object.values(r.cells).some((c) => c.value != null && String(c.value).toLowerCase().includes(q));
      }),
    [grid.rows, q],
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 12px 6px" }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder="Search settings and values…"
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {rows.length} settings · read-only on phones — edit on a tablet or computer
        </Typography.Text>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "4px 12px 12px" }}>
        {rows.length === 0 ? (
          <Empty description="No settings match your search" style={{ marginTop: 48 }} />
        ) : (
          rows.map((r) => <CardFor key={r.param.id} row={r} instances={grid.instances} />)
        )}
      </div>
    </div>
  );
}
