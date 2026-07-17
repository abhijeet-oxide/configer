import { Select, Segmented, Space, Table, Input } from "antd";
import { SwapOutlined, SearchOutlined, ArrowRightOutlined, BranchesOutlined, DiffOutlined } from "../icons";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type DiffChange, type Grid } from "../api";
import { DiffMiniBar } from "./charts";
import { useUI } from "../store";
import { CompareSkeleton } from "./Skeletons";
import { ChangeChip, EmptyState, LoadingStage } from "./ui";
import { InSyncArt, EmptyArt } from "./illustrations";
import CompareFiles, { COMMITTED } from "./CompareFiles";

// Compare view: pick two sides, each an instance at a version (working
// draft, committed baseline, or a git ref), and read the difference two
// ways: Parameters answers "which configuration values differ?", Files
// answers "what actual repository content differs?". The comparison context
// (sides, versions) stays stable while switching views.

const WORKING = "";

type CompareLayout = "Inline" | "Side by Side";
const LAYOUT_KEY = "configer.compareLayout";
type CompareMode = "parameters" | "files";
const MODE_KEY = "configer.compareMode";

// The user's layout and mode choices are stable personal preferences, so
// they are remembered across sessions rather than resetting to a default.
function loadLayout(): CompareLayout {
  return localStorage.getItem(LAYOUT_KEY) === "Inline" ? "Inline" : "Side by Side";
}
function loadMode(): CompareMode {
  return localStorage.getItem(MODE_KEY) === "files" ? "files" : "parameters";
}

type Pill = "changed" | "all" | "modified" | "added" | "removed";

export default function ComparePanel({ grid }: { grid: Grid }) {
  const { compareLeft, compareRight, setCompare } = useUI();
  const left = compareLeft || grid.instances[0]?.name;
  const right = compareRight || grid.instances[2]?.name || grid.instances[1]?.name;
  const [leftRef, setLeftRef] = useState<string>(WORKING);
  const [rightRef, setRightRef] = useState<string>(WORKING);
  const [pill, setPill] = useState<Pill>("changed");
  const [layout, setLayout] = useState<CompareLayout>(loadLayout);
  const [mode, setMode] = useState<CompareMode>(loadMode);
  const [q2, setQ2] = useState("");

  const changeLayout = (v: CompareLayout) => {
    localStorage.setItem(LAYOUT_KEY, v);
    setLayout(v);
  };
  const changeMode = (v: CompareMode) => {
    localStorage.setItem(MODE_KEY, v);
    setMode(v);
  };

  const refsQ = useQuery({ queryKey: ["refs"], queryFn: api.refs, staleTime: 60_000 });

  const sameSide = left === right && leftRef === rightRef;
  // The parameter diff understands real refs; the committed pseudo-ref only
  // exists for file mode, so parameters treat it as the working tree.
  const paramRef = (r: string) => (r === COMMITTED ? WORKING : r);
  const q = useQuery({
    queryKey: ["compare", left, paramRef(leftRef), right, paramRef(rightRef)],
    queryFn: () => api.compare(left, right, { leftRef: paramRef(leftRef), rightRef: paramRef(rightRef) }),
    enabled: !!left && !!right && !sameSide && mode === "parameters",
  });

  const rows = useMemo(() => {
    let changes = q.data?.changes ?? [];
    if (pill === "changed") changes = changes.filter((c) => c.status !== "unchanged");
    else if (pill !== "all") changes = changes.filter((c) => c.status === pill);
    const needle = q2.trim().toLowerCase();
    if (needle)
      changes = changes.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          String(c.left ?? "").toLowerCase().includes(needle) ||
          String(c.right ?? "").toLowerCase().includes(needle),
      );
    return changes;
  }, [q.data, pill, q2]);

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
      { value: COMMITTED, label: "Committed (no draft)" },
    ];
    const branches = refsQ.data?.branches ?? [];
    const tags = refsQ.data?.tags ?? [];
    if (branches.length) opts.push({ label: "Branches", title: "Branches", options: branches.map((b) => ({ value: b, label: b })) });
    if (tags.length) opts.push({ label: "Tags", title: "Tags", options: tags.map((t) => ({ value: t, label: t })) });
    return opts;
  }, [refsQ.data]);

  const refLabel = (ref: string) => (ref === WORKING ? "working" : ref === COMMITTED ? "committed" : ref);

  const side = (
    label: string,
    value: string,
    ref: string,
    onInstance: (v: string) => void,
    onRef: (v: string) => void,
  ) => (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[11px] font-semibold tracking-wide text-ink-3 uppercase">{label}</span>
      <Space.Compact size="small">
        <Select
          size="small"
          style={{ width: 185 }}
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
    </span>
  );

  const leftHead = `${left} @ ${refLabel(leftRef)}`;
  const rightHead = `${right} @ ${refLabel(rightRef)}`;

  // The diff must be visible in the values themselves, not inferred from a
  // status word: the outgoing side tints red, the incoming side green.
  const tint = (side: "left" | "right", c: DiffChange): React.CSSProperties => {
    if (c.status === "modified")
      return { background: side === "left" ? "var(--c-danger-bg)" : "var(--c-ok-bg)" };
    if (c.status === "added" && side === "right") return { background: "var(--c-ok-bg)" };
    if (c.status === "removed" && side === "left") return { background: "var(--c-danger-bg)" };
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
                  <span style={{ color: "var(--c-ok)" }}>{String(c.right ?? "-")}</span>
                </span>
              ),
          },
        ];

  const summary = q.data?.summary;
  const changedTotal = summary ? summary.modified + summary.added + summary.removed : 0;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* The comparison context: two sides, the view mode, and the outcome
          summary. Stays put while switching Parameters and Files. */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line bg-surface px-3 py-2">
        {side("Left", left, leftRef, (v) => setCompare(v, right), setLeftRef)}
        <SwapOutlined
          onClick={() => {
            setCompare(right, left);
            setLeftRef(rightRef);
            setRightRef(leftRef);
          }}
          className="cursor-pointer text-ink-3"
          title="Swap sides"
        />
        {side("Right", right, rightRef, (v) => setCompare(left, v), setRightRef)}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {mode === "parameters" && summary && (
            <span className="inline-flex items-center gap-1.5">
              <DiffMiniBar
                modified={summary.modified}
                added={summary.added}
                removed={summary.removed}
                unchanged={summary.unchanged}
              />
              <span className="text-xs font-semibold text-ink">
                {changedTotal} change{changedTotal === 1 ? "" : "s"}
              </span>
            </span>
          )}
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => changeMode(v as CompareMode)}
            options={[
              { value: "parameters", label: "Parameters" },
              { value: "files", label: "Files" },
            ]}
          />
        </div>
      </div>

      {sameSide ? (
        <EmptyState
          icon={<DiffOutlined />}
          title="Pick two different sides"
          hint="Compare a different instance, or the same instance at a different version."
        />
      ) : mode === "files" ? (
        <CompareFiles grid={grid} left={{ instance: left, ref: leftRef }} right={{ instance: right, ref: rightRef }} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Segmented
              size="small"
              value={pill}
              onChange={(v) => setPill(v as Pill)}
              options={[
                { value: "changed", label: `Changed${changedTotal ? ` (${changedTotal})` : ""}` },
                { value: "all", label: "All" },
                { value: "modified", label: `Modified${summary?.modified ? ` (${summary.modified})` : ""}` },
                { value: "added", label: `Added${summary?.added ? ` (${summary.added})` : ""}` },
                { value: "removed", label: `Removed${summary?.removed ? ` (${summary.removed})` : ""}` },
              ]}
            />
            <Segmented
              size="small"
              value={layout}
              options={["Inline", "Side by Side"]}
              onChange={(v) => changeLayout(v as CompareLayout)}
            />
            <div className="ml-auto">
              <Input
                size="small"
                allowClear
                prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
                placeholder="Search this diff"
                value={q2}
                onChange={(e) => setQ2(e.target.value)}
                style={{ width: 180 }}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
            {q.isLoading ? (
              <LoadingStage stage="Computing configuration differences…" skeleton={<CompareSkeleton toolbar={false} />} />
            ) : rows.length === 0 ? (
              <EmptyState
                art={pill === "changed" ? <InSyncArt size={112} /> : <EmptyArt size={96} />}
                title={pill === "changed" ? "No differences between these sides." : "Nothing matches."}
                hint={
                  pill === "changed" ? "Every parameter resolves to the same value on both sides." : undefined
                }
              />
            ) : (
              <Table<DiffChange>
                rowKey="paramId"
                size="small"
                dataSource={rows}
                pagination={false}
                rowClassName={(c) => (c.status === "unchanged" ? "" : `diff-row-${c.status}`)}
                columns={[
                  {
                    title: "Parameter",
                    dataIndex: "name",
                    width: 240,
                    render: (v: string) => <span className="mono">{v}</span>,
                  },
                  ...valueColumns,
                  {
                    title: "Change",
                    key: "change",
                    width: 110,
                    render: (_v, c) => <ChangeChip kind={c.status} />,
                  },
                ]}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
