import {
  Table,
  Tag,
  Typography,
  Button,
  Space,
  Popconfirm,
  Empty,
  Tooltip,
  App as AntApp,
} from "antd";
import {
  PullRequestOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  BranchesOutlined,
  ReloadOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import { EditOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChangeItem, type ChangeRequest, type ChangeState } from "../api";
import { useUI } from "../store";
import CrSteps, { StateTag } from "./CrSteps";
import { TableSkeleton } from "./Skeletons";

// ChangeRequestsView is the workflow home: every draft, in-review, published
// and rejected change request, with its parameter-level diff and the actions
// that drive the git-native lifecycle. Everything here can equally be done on
// GitHub directly; Configer reflects external merges/closes on refresh.

export const categoryColor: Record<string, string> = {
  hotfix: "red",
  feature: "blue",
  bugfix: "orange",
  maintenance: "default",
  security: "purple",
  other: "default",
};

export function ItemsTable({ items }: { items: ChangeItem[] | null }) {
  if (!items?.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No changes" />;
  return (
    <Table<ChangeItem>
      size="small"
      rowKey={(it) => `${it.paramId}|${it.instance}`}
      dataSource={items}
      pagination={false}
      columns={[
        { title: "Parameter", dataIndex: "paramId", render: (v) => <span className="mono">{v}</span> },
        {
          title: "Instance",
          dataIndex: "instance",
          render: (v: string, it: ChangeItem) =>
            it.scope === "global" ? <Tag color="purple">everyone (global)</Tag> : <Tag>{v}</Tag>,
        },
        {
          title: "Old value",
          dataIndex: "old",
          render: (v) => <span className="mono" style={{ opacity: 0.65 }}>{String(v ?? "-")}</span>,
        },
        {
          title: "New value",
          dataIndex: "new",
          render: (v) => <span className="mono" style={{ color: "#389e0d" }}>{String(v ?? "-")}</span>,
        },
      ]}
    />
  );
}

export default function ChangeRequestsView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { setSection } = useUI();
  const q = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 15_000 });

  const invalidate = () => qc.invalidateQueries();

  const merge = useMutation({
    mutationFn: (id: number) => api.mergeChange(id),
    onSuccess: (cr) => {
      message.success(`Change request #${cr.id} published to ${cr.targetBranch}`);
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });
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
      <Space style={{ marginBottom: 12, width: "100%", justifyContent: "space-between" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          <PullRequestOutlined /> Release history
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
        locale={{ emptyText: <Empty description="No change requests yet. Edit some cells in the Editor to start a draft." /> }}
        expandable={{
          expandedRowRender: (cr) => (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <CrSteps state={cr.state} />
              <ItemsTable items={cr.items} />
            </div>
          ),
        }}
        columns={[
          { title: "#", dataIndex: "id", width: 56, render: (id) => <b>#{id}</b> },
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
            title: "State",
            dataIndex: "state",
            width: 130,
            render: (s: ChangeState) => <StateTag state={s} />,
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
                {cr.branch && (
                  <Tag icon={<BranchesOutlined />} className="mono" style={{ fontSize: 11 }}>
                    {cr.branch}
                  </Tag>
                )}
                {cr.prUrl && (
                  <a href={cr.prUrl} target="_blank" rel="noreferrer">
                    <Tag icon={<LinkOutlined />} color="geekblue">PR #{cr.prNumber}</Tag>
                  </a>
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
                return (
                  <Space size={4}>
                    <Popconfirm
                      title={`Publish #${cr.id} to ${cr.targetBranch}?`}
                      description="The changes become the live configuration on the target branch."
                      onConfirm={() => merge.mutate(cr.id)}
                    >
                      <Button size="small" type="primary" icon={<CheckCircleOutlined />} loading={merge.isPending}>
                        Approve &amp; publish
                      </Button>
                    </Popconfirm>
                    <Popconfirm title={`Reject #${cr.id}?`} onConfirm={() => reject.mutate(cr.id)}>
                      <Button size="small" danger icon={<CloseCircleOutlined />} />
                    </Popconfirm>
                    <Tooltip title="Sync state from the pull request">
                      <Button size="small" icon={<ReloadOutlined />} onClick={() => refresh.mutate(cr.id)} />
                    </Tooltip>
                  </Space>
                );
              }
              if (cr.state === "draft") {
                return (
                  <Space size={4}>
                    <Tooltip title="Review the pending edits and submit for approval in the Configuration editor">
                      <Button
                        size="small"
                        type="primary"
                        icon={<EditOutlined />}
                        onClick={() => {
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
