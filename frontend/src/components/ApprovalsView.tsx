import { Card, Typography, Space, Button, Popconfirm, Empty, Tag, App as AntApp } from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LinkOutlined,
  BranchesOutlined,
  SmileOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import CrSteps from "./CrSteps";
import { ItemsTable } from "./ChangeRequestsView";
import { relTime } from "./DashboardView";

// ApprovalsView is the approver's inbox: every change request waiting for a
// decision, shown as a human before→after summary with one-click actions.
// The same approval can always be done directly on GitHub via the PR link.
export default function ApprovalsView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 15_000 });
  const waiting = (q.data ?? []).filter((c) => c.state === "under_review" || c.state === "approved");

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

  return (
    <div style={{ padding: 20, height: "100%", overflow: "auto", maxWidth: 980 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        Approvals
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        Changes waiting for your decision. Approving publishes them to Git; you can also review on
        GitHub via the pull request link — both work.
      </Typography.Paragraph>

      {waiting.length === 0 && (
        <Empty
          image={<SmileOutlined style={{ fontSize: 48, color: "#52c41a" }} />}
          description="Nothing is waiting for approval. All caught up!"
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
    </div>
  );
}
