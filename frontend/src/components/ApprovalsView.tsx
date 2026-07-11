import { Card, Col, Row, Statistic, Typography, Space, Button, Popconfirm, Empty, Tag, List, App as AntApp } from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LinkOutlined,
  BranchesOutlined,
  SmileOutlined,
  InboxOutlined,
  ClockCircleOutlined,
  HistoryOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import CrSteps, { StateTag } from "./CrSteps";
import { ItemsTable } from "./ChangeRequestsView";
import { relTime } from "./DashboardView";

// ApprovalsView is the approver's inbox: every change request waiting for a
// decision, shown as a human before→after summary with one-click actions.
// Even when nothing is pending the page stays useful, leading with review
// throughput stats and a timeline of recent decisions. The same approval can
// always be done directly on GitHub via the PR link.

function humanDuration(ms: number): string {
  const m = ms / 60000;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export default function ApprovalsView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 15_000 });
  const all = q.data ?? [];
  const waiting = all.filter((c) => c.state === "under_review" || c.state === "approved");

  // Review throughput, derived from the change-request history so the page is
  // informative even with an empty inbox.
  const today = new Date().toISOString().slice(0, 10);
  const publishedToday = all.filter((c) => c.state === "published" && c.updatedAt?.slice(0, 10) === today).length;
  const decided = all
    .filter((c) => c.state === "published" || c.state === "rejected")
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const durations = all
    .filter((c) => c.state === "published" && c.createdAt && c.updatedAt)
    .map((c) => new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime())
    .filter((d) => d >= 0);
  const avgReview = durations.length ? humanDuration(durations.reduce((s, d) => s + d, 0) / durations.length) : "—";

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

  const stat = (title: string, value: React.ReactNode, icon: React.ReactNode, accent: string, color?: string) => (
    <Col xs={12} sm={6}>
      <Card size="small" className="stat-accent" style={{ "--accent": accent } as React.CSSProperties}>
        <Statistic title={title} value={value as string} prefix={icon} valueStyle={{ fontSize: 20, color }} />
      </Card>
    </Col>
  );

  return (
    <div style={{ padding: 20, height: "100%", overflow: "auto", maxWidth: 1040, margin: "0 auto" }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        Approvals
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        Changes waiting for your decision. Approving publishes them to Git; you can also review on
        GitHub via the pull request link; both work.
      </Typography.Paragraph>

      <Row gutter={[14, 14]} style={{ marginBottom: 18 }}>
        {stat("Pending", waiting.length, <InboxOutlined />, "#1677ff", waiting.length ? "#1677ff" : undefined)}
        {stat("Published today", publishedToday, <CheckCircleOutlined />, "#0ca30c", publishedToday ? "#389e0d" : undefined)}
        {stat("Avg review time", avgReview, <ClockCircleOutlined />, "#fa8c16")}
        {stat("Decided (total)", decided.length, <HistoryOutlined />, "#6c3df4")}
      </Row>

      {waiting.length === 0 && (
        <Empty
          image={<SmileOutlined style={{ fontSize: 48, color: "#52c41a" }} />}
          description="Nothing is waiting for approval. All caught up!"
          style={{ margin: "12px 0 24px" }}
        />
      )}

      <Space direction="vertical" size={14} style={{ width: "100%" }}>
        {waiting.map((cr) => (
          <Card
            key={cr.id}
            size="small"
            title={
              <Space wrap>
                <b>#{cr.id}</b> {cr.title}
                <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>
                  by {cr.author} · {relTime(cr.updatedAt)}
                </Typography.Text>
              </Space>
            }
            extra={
              <Space size={4}>
                {cr.branch && (
                  <Tag icon={<BranchesOutlined />} className="mono" style={{ fontSize: 11 }}>{cr.branch}</Tag>
                )}
                {cr.prUrl && (
                  <a href={cr.prUrl} target="_blank" rel="noreferrer">
                    <Tag icon={<LinkOutlined />} color="geekblue">Review on GitHub</Tag>
                  </a>
                )}
              </Space>
            }
          >
            <CrSteps state={cr.state} />
            {cr.description && (
              <Typography.Paragraph style={{ margin: "10px 0 0" }} type="secondary">
                “{cr.description}”
              </Typography.Paragraph>
            )}
            <div style={{ margin: "12px 0" }}>
              <ItemsTable items={cr.items} />
            </div>
            <Space>
              <Popconfirm
                title={`Publish these changes to ${cr.targetBranch}?`}
                description="They will become the live configuration."
                okText="Publish"
                onConfirm={() => merge.mutate(cr.id)}
              >
                <Button type="primary" icon={<CheckCircleOutlined />} loading={merge.isPending}>
                  Approve &amp; Publish
                </Button>
              </Popconfirm>
              <Popconfirm title="Reject this change request?" onConfirm={() => reject.mutate(cr.id)}>
                <Button danger icon={<CloseCircleOutlined />} loading={reject.isPending}>
                  Reject
                </Button>
              </Popconfirm>
            </Space>
          </Card>
        ))}
      </Space>

      {decided.length > 0 && (
        <Card size="small" title="Recent decisions" style={{ marginTop: 18 }}>
          <List
            size="small"
            dataSource={decided.slice(0, 8)}
            renderItem={(cr) => (
              <List.Item
                extra={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {relTime(cr.updatedAt)}
                  </Typography.Text>
                }
              >
                <Space wrap size={8}>
                  <StateTag state={cr.state} />
                  <span>
                    <b>#{cr.id}</b> {cr.title}
                    <Typography.Text type="secondary"> · by {cr.author}</Typography.Text>
                  </span>
                </Space>
              </List.Item>
            )}
          />
        </Card>
      )}
    </div>
  );
}
