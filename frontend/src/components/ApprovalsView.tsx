import {
  Button,
  Input,
  List,
  Popconfirm,
  Select,
  Table,
  Tabs,
  Tooltip,
  App as AntApp,
} from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LinkOutlined,
  BranchesOutlined,
  SendOutlined,
} from "../icons";
import UserAvatar from "./UserAvatar";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChangeRequest, type ChangeState } from "../api";
import { useUI } from "../store";
import CrSteps, { StatePill } from "./CrSteps";
import { ItemsTable } from "./ChangeRequestsView";
import { relTime } from "./DashboardView";
import { ApprovalsSkeleton } from "./Skeletons";
import { SectionCard, EmptyState, MonoChip, FadeIn } from "./ui";
import { EmptyArt, InboxZeroArt } from "./illustrations";

// ApprovalsView is the review workspace: state tabs over a compact queue
// table, and the selected change request in full underneath: its changes,
// details and activity, with the discussion (comments) and reviewers beside
// them, and the decision at the bottom. The same approval can always be done
// on GitHub via the pull request link.

type StateFilter = "waiting" | "approved" | "published" | "rejected";

const FILTERS: { key: StateFilter; label: string; states: ChangeState[] }[] = [
  { key: "waiting", label: "Waiting for review", states: ["under_review", "approved"] },
  { key: "approved", label: "Approved", states: ["approved"] },
  { key: "published", label: "Published", states: ["published"] },
  { key: "rejected", label: "Rejected", states: ["rejected"] },
];

// The lifecycle events we can honestly reconstruct for one change request:
// creation, each comment, and its latest state transition.
function crActivity(cr: ChangeRequest): { at: string; actor: string; text: string }[] {
  const out = [{ at: cr.createdAt, actor: cr.author, text: "created the draft" }];
  for (const c of cr.comments ?? []) out.push({ at: c.createdAt, actor: c.author, text: `commented: "${c.body}"` });
  if (cr.state !== "draft" && cr.updatedAt !== cr.createdAt) {
    const what: Record<string, string> = {
      under_review: "submitted it for review",
      approved: "approved it",
      published: "published it",
      rejected: "rejected it",
    };
    out.push({ at: cr.updatedAt, actor: cr.author, text: what[cr.state] ?? cr.state });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}

// CommentsPanel: the in-app discussion, plus the PR link for the Git-native
// version of the same conversation.
function CommentsPanel({ cr }: { cr: ChangeRequest }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const add = useMutation({
    mutationFn: () => api.addComment(cr.id, body.trim(), "demo-user"),
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: ["changes"] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const comments = cr.comments ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px] font-semibold text-ink">Comments</div>
      {comments.length === 0 ? (
        <div className="text-xs text-ink-3">No comments yet.</div>
      ) : (
        <div className="flex max-h-56 flex-col gap-2 overflow-auto">
          {comments.map((c) => (
            <div key={c.id} className="rounded-card bg-surface-2 p-2 shadow-neu-inset">
              <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
                <UserAvatar name={c.author} size={18} />
                <b className="text-ink-2">{c.author || "Unknown"}</b> · {relTime(c.createdAt)}
              </div>
              <div className="mt-0.5 text-xs whitespace-pre-wrap text-ink">{c.body}</div>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Input
          size="small"
          placeholder="Add a comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPressEnter={() => body.trim() && add.mutate()}
        />
        <Button
          size="small"
          type="primary"
          icon={<SendOutlined />}
          disabled={!body.trim()}
          loading={add.isPending}
          onClick={() => add.mutate()}
          aria-label="Send comment"
        />
      </div>
      {cr.prUrl && (
        <a href={cr.prUrl} target="_blank" rel="noreferrer" className="text-xs">
          <LinkOutlined /> Discussion also lives on the pull request
        </a>
      )}
    </div>
  );
}

// ReviewersPanel: who was asked to look. Assignment is informational; the
// approver role still gates publishing.
function ReviewersPanel({ cr, repoId }: { cr: ChangeRequest; repoId: string | null }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const meQ = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
  const membersQ = useQuery({
    queryKey: ["members", repoId],
    queryFn: () => api.members(repoId!),
    enabled: !!repoId && !!meQ.data?.enabled,
  });
  const set = useMutation({
    mutationFn: (logins: string[]) => api.setReviewers(cr.id, logins),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["changes"] }),
    onError: (e: Error) => message.error(e.message),
  });
  const known = (membersQ.data?.users ?? []).map((u) => ({ value: u.login, label: u.name || u.login }));
  const me = meQ.data?.user?.login;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px] font-semibold text-ink">Reviewers</div>
      <div className="text-[11px] text-ink-3">Assign reviewers</div>
      <Select
        size="small"
        mode={known.length ? "multiple" : "tags"}
        allowClear
        placeholder="Search users…"
        value={cr.reviewers ?? []}
        options={known}
        onChange={(v) => set.mutate(v)}
        loading={set.isPending}
        style={{ width: "100%" }}
      />
      <div className="flex flex-col gap-1.5">
        {(cr.reviewers ?? []).map((login) => (
          <div key={login} className="flex items-center gap-2 text-xs">
            <UserAvatar name={login} size={20} />
            <span className="text-ink">
              {login}
              {login === me && " (You)"}
            </span>
            <span className="ml-auto text-[11px] text-ink-3">Reviewer</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ApprovalsView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { reviewCrId, setReviewCr, repoId, setSection } = useUI();
  const q = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 15_000 });
  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft });
  const [filter, setFilter] = useState<StateFilter>("waiting");
  const [selId, setSelId] = useState<number | null>(null);

  const all = useMemo(() => q.data ?? [], [q.data]);

  // Arriving from Releases' "Review" action: select that change request and
  // the tab it lives on, then clear the one-shot handoff.
  useEffect(() => {
    if (reviewCrId != null) {
      setSelId(reviewCrId);
      const cr = all.find((c) => c.id === reviewCrId);
      if (cr) setFilter(cr.state === "published" ? "published" : cr.state === "rejected" ? "rejected" : "waiting");
      setReviewCr(null);
    }
  }, [reviewCrId, setReviewCr, all]);

  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.key, all.filter((c) => f.states.includes(c.state)).length]),
  ) as Record<StateFilter, number>;
  const shown = all
    .filter((c) => FILTERS.find((f) => f.key === filter)!.states.includes(c.state))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const selected = shown.find((c) => c.id === selId) ?? shown[0];
  const hasDraft = (draftQ.data?.draft?.items?.length ?? 0) > 0;

  const merge = useMutation({
    mutationFn: (id: number) => api.mergeChange(id),
    onSuccess: (cr) => {
      message.success(`Change request CR-${cr.id} is now live on ${cr.targetBranch}`);
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const reject = useMutation({
    mutationFn: (id: number) => api.rejectChange(id),
    onSuccess: (cr) => {
      message.info(`Change request CR-${cr.id} was rejected`);
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  // First load: match the workspace layout instead of flashing the empty
  // "all caught up" state before the data has arrived.
  if (q.isLoading) return <ApprovalsSkeleton />;

  const decidable = selected && (selected.state === "under_review" || selected.state === "approved");

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-canvas px-6 py-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xl font-semibold text-ink">Approvals</div>
          <div className="text-[13px] text-ink-2">
            Review and approve change requests. Approval publishes the change to Git.
          </div>
        </div>
        {hasDraft && (
          <Button type="primary" onClick={() => setSection("config")}>
            Create change request
          </Button>
        )}
      </div>

      {/* State tabs with counts (the reference's filter row). */}
      <div className="app-tabs" style={{ padding: 0, background: "transparent" }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`app-tab${filter === f.key ? " app-tab-active" : ""}`}
            onClick={() => {
              setFilter(f.key);
              setSelId(null);
            }}
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
            title={filter === "waiting" ? "No pending approvals" : "No change requests"}
            hint={
              filter === "waiting"
                ? "No change requests are awaiting approval in this application."
                : "Change requests in this state will appear here."
            }
          />
        </SectionCard>
      ) : (
        <>
          <SectionCard padded={false}>
            <Table<ChangeRequest>
              className="cr-table"
              rowKey="id"
              size="small"
              dataSource={shown}
              pagination={false}
              onRow={(cr) => ({
                onClick: () => setSelId(cr.id),
                style: { cursor: "pointer" },
              })}
              rowClassName={(cr) => (cr.id === selected?.id ? "row-selected" : "")}
              columns={[
                {
                  title: "Change request",
                  dataIndex: "id",
                  width: 110,
                  render: (id) => <span className="mono font-semibold text-brand">CR-{id}</span>,
                },
                { title: "Title", dataIndex: "title", ellipsis: true },
                { title: "Created by", dataIndex: "author", width: 140, ellipsis: true },
                { title: "Changes", width: 90, render: (_v, cr) => cr.items?.length ?? 0 },
                {
                  title: "Target",
                  dataIndex: "targetBranch",
                  width: 140,
                  render: (v) => <span className="mono text-xs">{v}</span>,
                },
                {
                  title: "Status",
                  dataIndex: "state",
                  width: 150,
                  render: (s: ChangeState) => <StatePill state={s} size="sm" />,
                },
                { title: "Created", width: 100, render: (_v, cr) => relTime(cr.createdAt) },
              ]}
            />
          </SectionCard>

          {selected && (
            <FadeIn key={selected.id} y={6}>
            <SectionCard>
              {/* Identity row of the selected change request. */}
              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <span className="mono text-sm font-semibold text-brand">CR-{selected.id}</span>
                <span className="text-sm font-semibold text-ink">{selected.title}</span>
                <StatePill state={selected.state} size="sm" />
                <span className="text-xs text-ink-3">
                  Created by {selected.author} · {relTime(selected.createdAt)} · Target:{" "}
                  <span className="mono">{selected.targetBranch}</span>
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {selected.branch && (
                    <MonoChip icon={<BranchesOutlined style={{ fontSize: 10 }} />}>{selected.branch}</MonoChip>
                  )}
                  {selected.prUrl && (
                    <a href={selected.prUrl} target="_blank" rel="noreferrer" className="text-xs">
                      <LinkOutlined /> PR{selected.prNumber ? ` #${selected.prNumber}` : ""}
                    </a>
                  )}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap gap-5">
                {/* Changes / Details / Activity */}
                <div className="min-w-[340px] flex-1">
                  <Tabs
                    size="small"
                    items={[
                      {
                        key: "changes",
                        label: `Changes (${selected.items?.length ?? 0})`,
                        children: <ItemsTable items={selected.items} />,
                      },
                      {
                        key: "details",
                        label: "Details",
                        children: (
                          <div className="flex flex-col gap-3">
                            {selected.description && (
                              <div className="text-[13px] text-ink-2">“{selected.description}”</div>
                            )}
                            <div className="flex flex-wrap gap-2 text-xs">
                              {selected.category && <MonoChip>{selected.category}</MonoChip>}
                              {selected.reference && <MonoChip>{selected.reference}</MonoChip>}
                              {selected.baseSha && <MonoChip title="Base commit">base {selected.baseSha.slice(0, 7)}</MonoChip>}
                              {selected.commitSha && (
                                <MonoChip title="Change commit">commit {selected.commitSha.slice(0, 7)}</MonoChip>
                              )}
                            </div>
                            <CrSteps state={selected.state} />
                          </div>
                        ),
                      },
                      {
                        key: "activity",
                        label: "Activity",
                        children: (
                          <List
                            size="small"
                            dataSource={crActivity(selected)}
                            renderItem={(a) => (
                              <List.Item style={{ paddingInline: 0 }}>
                                <div className="flex w-full items-start gap-2">
                                  <UserAvatar name={a.actor} size={20} />
                                  <div className="min-w-0 flex-1 text-xs">
                                    <b>{a.actor || "Unknown"}</b> {a.text}
                                  </div>
                                  <span className="shrink-0 text-[11px] text-ink-3">{relTime(a.at)}</span>
                                </div>
                              </List.Item>
                            )}
                          />
                        ),
                      },
                    ]}
                  />
                </div>

                {/* Discussion and reviewers beside the diff, like the reference. */}
                <div className="flex w-[260px] shrink-0 flex-col gap-4 border-l border-line pl-4">
                  <CommentsPanel cr={selected} />
                  <ReviewersPanel cr={selected} repoId={repoId} />
                </div>
              </div>

              {decidable && (
                <div className="mt-3 flex justify-end gap-2 border-t border-line pt-3">
                  <Popconfirm title="Reject this change request?" onConfirm={() => reject.mutate(selected.id)}>
                    <Button danger icon={<CloseCircleOutlined />} loading={reject.isPending}>
                      Reject
                    </Button>
                  </Popconfirm>
                  <Popconfirm
                    title={`Publish these changes to ${selected.targetBranch}?`}
                    description="They will become the live configuration."
                    okText="Publish"
                    onConfirm={() => merge.mutate(selected.id)}
                  >
                    <Tooltip title="Approving publishes (merges) to the target branch">
                      <Button type="primary" icon={<CheckCircleOutlined />} loading={merge.isPending}>
                        Approve
                      </Button>
                    </Tooltip>
                  </Popconfirm>
                </div>
              )}
            </SectionCard>
            </FadeIn>
          )}
        </>
      )}
    </div>
  );
}
