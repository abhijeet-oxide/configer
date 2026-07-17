import { Select, Table } from "antd";
import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, type ChangeRequest, type ChangeState } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { StatePill } from "./CrSteps";
import { relTime } from "./DashboardView";
import { ApprovalsSkeleton } from "./Skeletons";
import { SectionCard, EmptyState } from "./ui";
import { EmptyArt } from "./illustrations";

// ChangesOverview is the WORKSPACE-WIDE change history behind the rail's
// Changes entry: every change request (any state) across every application
// in one filterable list, so "what has been changing everywhere" is one
// screen instead of one per application. Opening a row goes to that
// application's Releases view.

type StateFilter = "all" | "draft" | "under_review" | "published" | "rejected";

const FILTERS: { key: StateFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "under_review", label: "In review" },
  { key: "published", label: "Published" },
  { key: "rejected", label: "Rejected" },
];

interface Row {
  key: string;
  repoId: string;
  repoName: string;
  cr: ChangeRequest;
}

export default function ChangesOverview() {
  const { repoId, setSection } = useUI();
  const switchRepo = useSwitchRepo();
  const [filter, setFilter] = useState<StateFilter>("all");
  const [app, setApp] = useState("");

  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const repos = wsQ.data?.repos ?? [];
  const changeQs = useQueries({
    queries: repos.map((r) => ({
      queryKey: ["inbox-changes", r.id],
      queryFn: () => api.changesOf(r.id),
      refetchInterval: 20_000,
    })),
  });

  const all: Row[] = [];
  repos.forEach((r, i) => {
    for (const cr of changeQs[i]?.data ?? [])
      all.push({ key: `${r.id}:${cr.id}`, repoId: r.id, repoName: r.name, cr });
  });
  const inApp = app ? all.filter((r) => r.repoId === app) : all;
  const counts = Object.fromEntries(
    FILTERS.map((f) => [
      f.key,
      f.key === "all" ? inApp.length : inApp.filter((r) => r.cr.state === (f.key as ChangeState)).length,
    ]),
  ) as Record<StateFilter, number>;
  const shown = inApp
    .filter((r) => filter === "all" || r.cr.state === (filter as ChangeState))
    .sort((a, b) => (b.cr.updatedAt ?? "").localeCompare(a.cr.updatedAt ?? ""));

  const loading = wsQ.isLoading || (repos.length > 0 && changeQs.some((q) => q.isLoading));

  const open = (row: Row) => {
    if (row.repoId !== repoId) switchRepo(row.repoId);
    setSection("changes");
  };

  if (loading) return <ApprovalsSkeleton />;

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-canvas px-6 py-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xl font-semibold text-ink">Changes</div>
          <div className="text-[13px] text-ink-2">
            Every change request across your applications. Open one to see its release history.
          </div>
        </div>
        <Select
          size="small"
          value={app}
          onChange={setApp}
          style={{ width: 200 }}
          options={[{ value: "", label: "All applications" }, ...repos.map((r) => ({ value: r.id, label: r.name }))]}
        />
      </div>

      <div className="app-tabs" style={{ padding: 0, background: "transparent" }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`app-tab${filter === f.key ? " app-tab-active" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {counts[f.key] > 0 && <span className="text-[11px] text-ink-3">({counts[f.key]})</span>}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <SectionCard>
          <EmptyState
            art={<EmptyArt size={104} />}
            title="No change requests yet"
            hint={
              app
                ? "This application has no change requests in this state."
                : "Edit some cells in an application's editor to start a draft; it appears here immediately."
            }
          />
        </SectionCard>
      ) : (
        <SectionCard padded={false}>
          <Table<Row>
            className="cr-table"
            rowKey="key"
            size="small"
            dataSource={shown}
            pagination={false}
            onRow={(row) => ({ onClick: () => open(row), style: { cursor: "pointer" } })}
            columns={[
              {
                title: "Change request",
                width: 110,
                render: (_v, r) => <span className="mono font-semibold text-brand">CR-{r.cr.id}</span>,
              },
              { title: "Title", ellipsis: true, render: (_v, r) => r.cr.title },
              {
                title: "Application",
                width: 180,
                ellipsis: true,
                render: (_v, r) => <span className="text-ink-2">{r.repoName}</span>,
              },
              { title: "Created by", width: 130, ellipsis: true, render: (_v, r) => r.cr.author },
              { title: "Changes", width: 80, render: (_v, r) => r.cr.items?.length ?? 0 },
              { title: "Status", width: 150, render: (_v, r) => <StatePill state={r.cr.state} size="sm" /> },
              { title: "Updated", width: 100, render: (_v, r) => relTime(r.cr.updatedAt ?? r.cr.createdAt) },
            ]}
          />
        </SectionCard>
      )}
    </div>
  );
}
