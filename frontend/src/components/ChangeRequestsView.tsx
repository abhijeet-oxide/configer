import {
  Table,
  Tag,
  Typography,
  Button,
  Space,
  Popconfirm,
  Tooltip,
  App as AntApp,
} from "antd";
import {
  PullRequestOutlined,
  CloseCircleOutlined,
  BranchesOutlined,
  ReloadOutlined,
  LinkOutlined,
  EyeOutlined,
  RightOutlined,
} from "../icons";
import { EditOutlined } from "../icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { api, type ChangeItem, type ChangeRequest, type ChangeState } from "../api";
import { useUI } from "../store";
import CrSteps, { StatePill } from "./CrSteps";
import { TableSkeleton } from "./Skeletons";
import PrChecksBadge from "./PrChecksBadge";
import { ChangeItemsTable } from "./ChangeItemsTable";
import { EmptyArt, StatePanel } from "./illustrations";

// ChangeRequestsView is the Release history: every draft, in-review,
// published and rejected change request with its parameter-level diff. It is
// deliberately read-only for reviews; approving or rejecting is Approvals'
// job (one place, one audit trail); rows under review link there. Drafts are
// authoring, not reviewing, so their submit/discard actions stay here.

export const categoryColor: Record<string, string> = {
  hotfix: "red",
  feature: "blue",
  bugfix: "orange",
  maintenance: "default",
  security: "purple",
  other: "default",
};

export function ItemsTable({ items }: { items: ChangeItem[] | null }) {
  return <ChangeItemsTable items={items} />;
}

export default function ChangeRequestsView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { setSection, setReviewCr, setOpenSubmit } = useUI();
  const q = useRepoQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 15_000 });

  const invalidate = () => qc.invalidateQueries();

  const reject = useMutation({
    mutationFn: (id: number) => api.rejectChange(id),
    onSuccess: (cr) => {
      message.info(`Change request #${cr.id} ${cr.state === "rejected" ? "rejected" : "discarded"}`);
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const refresh = useMutation({
    mutationFn: (id: number) => api.change(id),
    onSuccess: invalidate,
  });

  // First load: a table-shaped skeleton rather than AntD's spinner overlay, so
  // the layout matches what arrives and stays consistent with the other pages.
  if (q.isLoading) return <TableSkeleton />;

  return (
    <div style={{ padding: 16, height: "100%", overflow: "auto" }}>
      <Space style={{ marginBottom: 12, width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          <PullRequestOutlined /> Changes
        </Typography.Title>
        <Button size="small" icon={<ReloadOutlined />} loading={q.isFetching} onClick={invalidate}>
          Refresh
        </Button>
      </Space>
      <Table<ChangeRequest>
        rowKey="id"
        size="middle"
        dataSource={q.data}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{
          emptyText: (
            <StatePanel
              art={<EmptyArt size={104} />}
              title="No changes yet"
              subtitle="Edit some cells in Parameters to start a draft; submitting it sends your first change for review."
            />
          ),
        }}
        expandable={{
          expandedRowRender: (cr) => (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <CrSteps state={cr.state} />
              <ItemsTable items={cr.items} />
            </div>
          ),
        }}
        columns={[
          {
            title: "Change request",
            dataIndex: "id",
            width: 130,
            // A draft has no CR number yet: it gets one at submit, so that the
            // numbers a team reviews are the changes a team reviewed, with no
            // gaps where somebody started an edit and thought better of it.
            render: (_id, cr) =>
              cr.number ? (
                <span className="mono font-semibold text-brand">CR-{cr.number}</span>
              ) : (
                <Tooltip title="Not submitted yet. It gets a CR number when you send it for review.">
                  <Tag style={{ marginInlineEnd: 0 }}>Your draft</Tag>
                </Tooltip>
              ),
          },
          {
            title: "Title",
            dataIndex: "title",
            render: (t, cr) => (
              <>
                <div>
                  {t}
                  {cr.category && (
                    <Tag color={categoryColor[cr.category] ?? "default"} style={{ marginInlineStart: 8, fontSize: 11 }}>
                      {cr.category}
                    </Tag>
                  )}
                  {cr.reference && (
                    <Tag style={{ fontSize: 11 }} className="mono">{cr.reference}</Tag>
                  )}
                </div>
                {cr.description && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{cr.description}</Typography.Text>
                )}
              </>
            ),
          },
          {
            title: "Status",
            dataIndex: "state",
            width: 140,
            render: (s: ChangeState) => <StatePill state={s} size="sm" />,
          },
          {
            title: "Changes",
            width: 90,
            render: (_v, cr) => <Tag>{cr.items?.length ?? 0}</Tag>,
          },
          {
            title: "Branch / PR",
            width: 240,
            render: (_v, cr) => (
              <Space size={4} wrap>
                {cr.branch ? (
                  <Tag icon={<BranchesOutlined />} className="mono" style={{ fontSize: 11 }}>
                    {cr.branch}
                  </Tag>
                ) : cr.state === "draft" ? (
                  // Saying nothing here is better than naming a branch that does
                  // not exist: a placeholder read as a decision already taken.
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Branch created when you submit
                  </Typography.Text>
                ) : null}
                {cr.prUrl && (
                  <a href={cr.prUrl} target="_blank" rel="noreferrer">
                    <Tag icon={<LinkOutlined />} color="geekblue">PR #{cr.prNumber}</Tag>
                  </a>
                )}
                {(cr.state === "under_review" || cr.state === "approved") && (
                  <PrChecksBadge changeId={cr.id} hasPr={!!cr.prNumber} />
                )}
              </Space>
            ),
          },
          { title: "Author", dataIndex: "author", width: 130, ellipsis: true },
          {
            title: "Actions",
            width: 230,
            render: (_v, cr) => {
              if (cr.state === "under_review" || cr.state === "approved") {
                // Deciding happens in Approvals: one place for approvals,
                // one audit trail. History only links there.
                return (
                  <Space size={4}>
                    <Button
                      size="small"
                      icon={<EyeOutlined />}
                      onClick={() => {
                        setReviewCr(cr.id);
                        setSection("approvals");
                      }}
                    >
                      Review <RightOutlined style={{ fontSize: 10 }} />
                    </Button>
                    <Tooltip title="Sync state from the pull request">
                      <Button size="small" icon={<ReloadOutlined />} onClick={() => refresh.mutate(cr.id)} />
                    </Tooltip>
                  </Space>
                );
              }
              if (cr.state === "draft") {
                return (
                  <Space size={4}>
                    <Tooltip title="Review the pending edits and submit them for approval">
                      <Button
                        size="small"
                        type="primary"
                        icon={<EditOutlined />}
                        onClick={() => {
                          // Take them to the editor AND open the review dialog.
                          // Switching tabs alone landed on a grid with no sign
                          // of the thing they had just clicked.
                          setOpenSubmit(true);
                          setSection("config");
                        }}
                      >
                        Review &amp; submit
                      </Button>
                    </Tooltip>
                    <Popconfirm title="Discard this draft and all pending edits?" onConfirm={() => reject.mutate(cr.id)}>
                      <Button size="small" danger icon={<CloseCircleOutlined />}>Discard</Button>
                    </Popconfirm>
                  </Space>
                );
              }
              return null;
            },
          },
        ]}
      />
    </div>
  );
}
