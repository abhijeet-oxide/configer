import {
  Badge,
  Button,
  Card,
  Empty,
  List,
  Popconfirm,
  Space,
  Statistic,
  Tag,
  Typography,
  App as AntApp,
} from "antd";
import {
  CheckCircleFilled,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LinkOutlined,
  BranchesOutlined,
  InboxOutlined,
  HistoryOutlined,
  RocketOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChangeRequest } from "../api";
import CrSteps, { StateTag } from "./CrSteps";
import { ItemsTable } from "./ChangeRequestsView";
import { relTime } from "./DashboardView";
import { ApprovalsSkeleton } from "./Skeletons";

// ApprovalsView is the approver's workspace: the review pipeline at a glance
// (stat strip), a queue of everything waiting on the left, and the selected
// change request in full on the right — before→after values, lifecycle, and
// one-click decisions. The same approval can always be done on GitHub via
// the pull request link. When nothing is waiting, the page shows the recent
// decision history instead of going blank.

function StatTile({
  title,
  value,
  accent,
  icon,
  active,
  onClick,
}: {
  title: string;
  value: number;
  accent: string;
  icon: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <Card
      size="small"
      hoverable={!!onClick}
      onClick={onClick}
      className="stat-accent"
      style={{
        "--accent": accent,
        borderColor: active ? accent : undefined,
      } as React.CSSProperties}
    >
      <Statistic
        title={title}
        value={value}
        prefix={<span style={{ color: accent }}>{icon}</span>}
        valueStyle={{ fontSize: 22, color: value ? accent : undefined }}
      />
    </Card>
  );
}

// One entry in the review queue on the left.
function QueueItem({
  cr,
  selected,
  onClick,
}: {
  cr: ChangeRequest;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="card-clickable"
      style={{
        border: `1px solid ${selected ? "var(--c-review)" : "rgba(127,137,160,0.25)"}`,
        background: selected ? "rgba(47,107,255,0.06)" : undefined,
        borderRadius: 10,
        padding: "10px 12px",
        cursor: "pointer",
      }}
    >
      <Space size={6} wrap>
        <StateTag state={cr.state} />
        <Typography.Text strong style={{ fontSize: 13 }}>
          #{cr.id} {cr.title}
        </Typography.Text>
      </Space>
      <div style={{ marginTop: 4, fontSize: 12, opacity: 0.65 }}>
        {cr.author} · {cr.items?.length ?? 0} change{(cr.items?.length ?? 0) === 1 ? "" : "s"} ·{" "}
        {relTime(cr.updatedAt)}
      </div>
    </div>
  );
}

export default function ApprovalsView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 15_000 });
  const [selId, setSelId] = useState<number | null>(null);

  const all = q.data ?? [];
  const waiting = all.filter((c) => c.state === "under_review" || c.state === "approved");
  const decided = all
    .filter((c) => c.state === "published" || c.state === "rejected")
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const counts = {
    review: all.filter((c) => c.state === "under_review").length,
    approved: all.filter((c) => c.state === "approved").length,
    published: all.filter((c) => c.state === "published").length,
    rejected: all.filter((c) => c.state === "rejected").length,
  };
  const selected = waiting.find((c) => c.id === selId) ?? waiting[0];

  const merge = useMutation({
    mutationFn: (id: number) => api.mergeChange(id),
    onSuccess: (cr) => {
      message.success(`Change request #${cr.id} is now live on ${cr.targetBranch}`);
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const reject = useMutation({
    mutationFn: (id: number) => api.rejectChange(id),
    onSuccess: (cr) => {
      message.info(`Change request #${cr.id} was rejected`);
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  // First load: match the workspace layout instead of flashing the empty
  // "all caught up" state before the data has arrived.
  if (q.isLoading) return <ApprovalsSkeleton />;

  const decisionsList = (
    <List
      size="small"
      dataSource={decided.slice(0, 10)}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No decisions yet." /> }}
      renderItem={(cr) => (
        <List.Item style={{ paddingInline: 0 }}>
          <Space direction="vertical" size={0} style={{ width: "100%" }}>
            <Space size={6} wrap>
              <StateTag state={cr.state} />
              <Typography.Text strong style={{ fontSize: 13 }}>
                #{cr.id} {cr.title}
              </Typography.Text>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {cr.author} · {cr.items?.length ?? 0} change{(cr.items?.length ?? 0) === 1 ? "" : "s"} · {relTime(cr.updatedAt)}
            </Typography.Text>
          </Space>
        </List.Item>
      )}
    />
  );

  return (
    <div style={{ padding: "16px 24px", height: "100%", overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Approvals
        </Typography.Title>
        <Typography.Text type="secondary">
          Changes waiting for your decision. Approving publishes them to Git; reviewing on GitHub
          via the pull request works just as well.
        </Typography.Text>
      </div>

      {/* The review pipeline at a glance. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        <StatTile title="Waiting for review" value={counts.review} accent="var(--c-review)" icon={<InboxOutlined />} />
        <StatTile title="Approved, not yet published" value={counts.approved} accent="#08979c" icon={<CheckCircleOutlined />} />
        <StatTile title="Published" value={counts.published} accent="var(--c-ok)" icon={<RocketOutlined />} />
        <StatTile title="Rejected" value={counts.rejected} accent="var(--c-danger)" icon={<StopOutlined />} />
      </div>

      {waiting.length === 0 ? (
        // Nothing pending: a calm all-clear plus the decision history, so the
        // page stays informative instead of a lone smiley in white space.
        <div style={{ display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap", flex: 1 }}>
          <Card style={{ flex: "1 1 340px", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ textAlign: "center", padding: "28px 16px" }}>
              <CheckCircleFilled style={{ fontSize: 52, color: "var(--c-ok)" }} />
              <Typography.Title level={4} style={{ marginTop: 16, marginBottom: 6 }}>
                All caught up
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ maxWidth: 380, margin: "0 auto" }}>
                Nothing is waiting for approval. When someone submits a change request it appears
                here immediately — and in the badge on the Approvals tab.
              </Typography.Paragraph>
            </div>
          </Card>
          <Card
            size="small"
            title={
              <Space size={8}>
                <HistoryOutlined /> Recent decisions
              </Space>
            }
            style={{ flex: "1 1 380px" }}
          >
            {decisionsList}
          </Card>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          {/* The queue: everything waiting, most recent first. */}
          <div style={{ flex: "0 0 330px", display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4 }}>
              <Badge count={waiting.length} size="small" color="var(--c-review)" offset={[10, 0]}>
                Review queue
              </Badge>
            </Typography.Text>
            {waiting.map((cr) => (
              <QueueItem key={cr.id} cr={cr} selected={cr.id === selected?.id} onClick={() => setSelId(cr.id)} />
            ))}
            {decided.length > 0 && (
              <Card size="small" title={<Space size={8}><HistoryOutlined /> Recent decisions</Space>} style={{ marginTop: 8 }}>
                {decisionsList}
              </Card>
            )}
          </div>

          {/* The selected change request, in full. */}
          {selected && (
            <Card
              style={{ flex: 1, minWidth: 0 }}
              title={
                <Space wrap>
                  <b>#{selected.id}</b> {selected.title}
                  <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>
                    by {selected.author} · {relTime(selected.updatedAt)}
                  </Typography.Text>
                </Space>
              }
              extra={
                <Space size={4}>
                  {selected.branch && (
                    <Tag icon={<BranchesOutlined />} className="mono" style={{ fontSize: 11 }}>
                      {selected.branch}
                    </Tag>
                  )}
                  {selected.prUrl && (
                    <a href={selected.prUrl} target="_blank" rel="noreferrer">
                      <Tag icon={<LinkOutlined />} color="geekblue">
                        Review on GitHub
                      </Tag>
                    </a>
                  )}
                </Space>
              }
            >
              <CrSteps state={selected.state} />
              {selected.description && (
                <Typography.Paragraph style={{ margin: "12px 0 0" }} type="secondary">
                  “{selected.description}”
                </Typography.Paragraph>
              )}
              <div style={{ margin: "14px 0" }}>
                <ItemsTable items={selected.items} />
              </div>
              <Space>
                <Popconfirm
                  title={`Publish these changes to ${selected.targetBranch}?`}
                  description="They will become the live configuration."
                  okText="Publish"
                  onConfirm={() => merge.mutate(selected.id)}
                >
                  <Button type="primary" size="large" icon={<CheckCircleOutlined />} loading={merge.isPending}>
                    Approve &amp; publish
                  </Button>
                </Popconfirm>
                <Popconfirm title="Reject this change request?" onConfirm={() => reject.mutate(selected.id)}>
                  <Button danger size="large" icon={<CloseCircleOutlined />} loading={reject.isPending}>
                    Reject
                  </Button>
                </Popconfirm>
              </Space>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
