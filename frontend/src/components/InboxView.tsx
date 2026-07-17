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
import { EmptyArt, InboxZeroArt } from "./illustrations";

// InboxView is the WORKSPACE-WIDE approvals inbox behind the rail's
// Approvals entry: one queue of change requests across every application,
// filterable by application and state. Reviewing happens in the owning
// application's approvals workspace (one review surface, one audit trail);
// clicking a row switches there with the change request preselected.

type StateFilter = "waiting" | "approved" | "published" | "rejected";

const FILTERS: { key: StateFilter; label: string; states: ChangeState[] }[] = [
  { key: "waiting", label: "Waiting for review", states: ["under_review", "approved"] },
  { key: "approved", label: "Approved", states: ["approved"] },
  { key: "published", label: "Published", states: ["published"] },
  { key: "rejected", label: "Rejected", states: ["rejected"] },
];

interface InboxRow {
  key: string;
  repoId: string;
  repoName: string;
  cr: ChangeRequest;
}

export default function InboxView() {
  const { repoId, setSection, setReviewCr } = useUI();
  const switchRepo = useSwitchRepo();
  const [filter, setFilter] = useState<StateFilter>("waiting");
  const [app, setApp] = useState<string>("");

  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const repos = wsQ.data?.repos ?? [];
  const changeQs = useQueries({
    queries: repos.map((r) => ({
      queryKey: ["inbox-changes", r.id],
      queryFn: () => api.changesOf(r.id),
      refetchInterval: 20_000,
    })),
  });

  // Aggregation is cheap (a handful of repos, dozens of CRs); no memo needed.
  const all: InboxRow[] = [];
  repos.forEach((r, i) => {
    for (const cr of changeQs[i]?.data ?? [])
      all.push({ key: `${r.id}:${cr.id}`, repoId: r.id, repoName: r.name, cr });
  });
  const inApp = app ? all.filter((r) => r.repoId === app) : all;
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.key, inApp.filter((r) => f.states.includes(r.cr.state)).length]),
  ) as Record<StateFilter, number>;
  const shown = inApp
    .filter((r) => FILTERS.find((f) => f.key === filter)!.states.includes(r.cr.state))
    .sort((a, b) => (b.cr.updatedAt ?? "").localeCompare(a.cr.updatedAt ?? ""));

  const loading = wsQ.isLoading || (repos.length > 0 && changeQs.some((q) => q.isLoading));

  // Reviewing lives in the owning application's approvals workspace.
  const openReview = (row: InboxRow) => {
    setReviewCr(row.cr.id);
    if (row.repoId !== repoId) switchRepo(row.repoId);
    setSection("approvals");
  };

  if (loading) return <ApprovalsSkeleton />;

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-canvas px-6 py-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xl font-semibold text-ink">Approvals</div>
          <div className="text-[13px] text-ink-2">
            Change requests across all your applications. Open one to review it in its application's
            workspace.
          </div>
        </div>
        <Select
          size="small"
          value={app}
          onChange={setApp}
          style={{ width: 200 }}
          options={[
            { value: "", label: "All applications" },
            ...repos.map((r) => ({ value: r.id, label: r.name })),
          ]}
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
            art={filter === "waiting" ? <InboxZeroArt size={116} /> : <EmptyArt size={104} />}
            title={filter === "waiting" ? "All caught up" : "Nothing here yet"}
            hint={
              filter === "waiting"
                ? app
                  ? "Nothing is waiting for approval in this application."
                  : "Nothing is waiting for approval in any application. New change requests appear here immediately."
                : "Change requests in this state will appear here."
            }
          />
        </SectionCard>
      ) : (
        <SectionCard padded={false}>
          <Table<InboxRow>
            className="cr-table"
            rowKey="key"
            size="small"
            dataSource={shown}
            pagination={false}
            onRow={(row) => ({ onClick: () => openReview(row), style: { cursor: "pointer" } })}
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
              { title: "Changes", width: 90, render: (_v, r) => r.cr.items?.length ?? 0 },
              {
                title: "Status",
                width: 150,
                render: (_v, r) => <StatePill state={r.cr.state} size="sm" />,
              },
              { title: "Created", width: 100, render: (_v, r) => relTime(r.cr.createdAt) },
            ]}
          />
        </SectionCard>
      )}
    </div>
  );
}
