import { Select, Segmented, Switch, Space, Table, Tag, Typography, Empty, Input } from "antd";
import { SwapOutlined, SearchOutlined, ArrowRightOutlined, BranchesOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type DiffChange, type Grid } from "../api";
import { DiffMiniBar } from "./charts";
import { useUI } from "../store";
import { CompareSkeleton } from "./Skeletons";

// Compare view: pick two sides, each an instance at a git ref (branch/tag or the
// working tree), and read a parameter-level diff. This compares not just two
// instances but two versions: the same instance across releases, or two
// instances across two refs. Instance pickers are grouped by environment.

const WORKING = "";

export default function ComparePanel({ grid }: { grid: Grid }) {
  const { compareLeft, compareRight, setCompare } = useUI();
  const left = compareLeft || grid.instances[0]?.name;
  const right = compareRight || grid.instances[2]?.name || grid.instances[1]?.name;
  const [leftRef, setLeftRef] = useState<string>(WORKING);
  const [rightRef, setRightRef] = useState<string>(WORKING);
  const [changesOnly, setChangesOnly] = useState(true);
  const [layout, setLayout] = useState<"Inline" | "Side by Side">("Side by Side");
  const [q2, setQ2] = useState("");

  const refsQ = useQuery({ queryKey: ["refs"], queryFn: api.refs, staleTime: 60_000 });

  const sameSide = left === right && leftRef === rightRef;
  const q = useQuery({
    queryKey: ["compare", left, leftRef, right, rightRef],
    queryFn: () => api.compare(left, right, { leftRef, rightRef }),
    enabled: !!left && !!right && !sameSide,
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

  // Instance options grouped by environment (the tree-like picker).
  const instOptions = useMemo(() => {
    const byEnv = new Map<string, typeof grid.instances>();
    for (const i of grid.instances) byEnv.set(i.environment || "other", [...(byEnv.get(i.environment || "other") ?? []), i]);
    return [...byEnv.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([env, list]) => ({
        label: env,
        title: env,
        options: list.map((i) => ({ value: i.name, label: `${i.name}  ·  ${i.softwareVersion || "-"}` })),
      }));
  }, [grid]);

  const refOptions = useMemo(() => {
    const opts: { label: string; title?: string; value?: string; options?: { value: string; label: string }[] }[] = [
      { value: WORKING, label: "Working tree (current)" },
    ];
    const branches = refsQ.data?.branches ?? [];
    const tags = refsQ.data?.tags ?? [];
    if (branches.length) opts.push({ label: "Branches", title: "Branches", options: branches.map((b) => ({ value: b, label: b })) });
    if (tags.length) opts.push({ label: "Tags", title: "Tags", options: tags.map((t) => ({ value: t, label: t })) });
    return opts;
  }, [refsQ.data]);

  const refLabel = (ref: string) => (ref === WORKING ? "working" : ref);

  const side = (
    value: string,
    ref: string,
    onInstance: (v: string) => void,
    onRef: (v: string) => void,
  ) => (
    <Space.Compact size="small">
      <Select
        size="small"
        style={{ width: 190 }}
        value={value}
        showSearch
        optionFilterProp="label"
        options={instOptions}
        onChange={onInstance}
      />
      <Select
        size="small"
        style={{ width: 150 }}
        value={ref}
        options={refOptions}
        onChange={onRef}
        suffixIcon={<BranchesOutlined />}
      />
    </Space.Compact>
  );

  const leftHead = `${left} @ ${refLabel(leftRef)}`;
  const rightHead = `${right} @ ${refLabel(rightRef)}`;

  // The diff must be visible in the values themselves, not inferred from a
  // status word: the outgoing side tints red, the incoming side green.
  const tint = (side: "left" | "right", c: DiffChange): React.CSSProperties => {
    if (c.status === "modified")
      return { background: side === "left" ? "rgba(208,59,59,0.07)" : "rgba(12,163,12,0.07)" };
    if (c.status === "added" && side === "right") return { background: "rgba(12,163,12,0.07)" };
    if (c.status === "removed" && side === "left") return { background: "rgba(208,59,59,0.07)" };
    return {};
  };

  const valueColumns =
    layout === "Side by Side"
      ? [
          {
            title: leftHead,
            dataIndex: "left" as const,
            onCell: (c: DiffChange) => ({ style: tint("left", c) }),
            render: (v: unknown, c: DiffChange) => (
              <span
                className="mono"
                style={c.status === "modified" ? { textDecoration: "line-through", opacity: 0.75 } : undefined}
              >
                {String(v ?? "-")}
              </span>
            ),
          },
          {
            title: rightHead,
            dataIndex: "right" as const,
            onCell: (c: DiffChange) => ({ style: tint("right", c) }),
            render: (v: unknown) => <span className="mono">{String(v ?? "-")}</span>,
          },
        ]
      : [
          {
            title: `${leftHead}  vs  ${rightHead}`,
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
      <Space wrap style={{ marginBottom: 8 }} align="center">
        <Typography.Text strong>Compare</Typography.Text>
        {side(left, leftRef, (v) => setCompare(v, right), setLeftRef)}
        <SwapOutlined
          onClick={() => {
            setCompare(right, left);
            setLeftRef(rightRef);
            setRightRef(leftRef);
          }}
          style={{ cursor: "pointer" }}
        />
        {side(right, rightRef, (v) => setCompare(left, v), setRightRef)}
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
          style={{ width: 160 }}
        />
        {q.data && (
          <Space size={6} align="center">
            <DiffMiniBar
              modified={q.data.summary.modified}
              added={q.data.summary.added}
              removed={q.data.summary.removed}
              unchanged={q.data.summary.unchanged}
            />
            {/* zero counts are noise: only name what actually happened */}
            {q.data.summary.modified > 0 && <Tag color="orange">{q.data.summary.modified} modified</Tag>}
            {q.data.summary.added > 0 && <Tag color="green">{q.data.summary.added} added</Tag>}
            {q.data.summary.removed > 0 && <Tag color="red">{q.data.summary.removed} removed</Tag>}
            {q.data.summary.modified + q.data.summary.added + q.data.summary.removed === 0 && (
              <Tag color="default">no differences</Tag>
            )}
          </Space>
        )}
      </Space>
      <div style={{ flex: 1, overflow: "auto" }}>
        {sameSide ? (
          <Empty description="Pick two different sides (a different instance or a different version)" />
        ) : q.isLoading ? (
          // consistent loading language: the diff-table skeleton, no spinner
          <CompareSkeleton toolbar={false} />
        ) : (
          <Table<DiffChange>
            rowKey="paramId"
            size="small"
            dataSource={rows}
            pagination={false}
            // change kind reads from the row accent + cell tints, not a
            // status word repeated down a column
            rowClassName={(c) => (c.status === "unchanged" ? "" : `diff-row-${c.status}`)}
            columns={[
              { title: "Parameter", dataIndex: "name", width: 240 },
              ...valueColumns,
            ]}
          />
        )}
      </div>
    </div>
  );
}
