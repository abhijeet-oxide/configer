import {
  Alert,
  Button,
  Drawer,
  Empty,
  List,
  Modal,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
} from "antd";
import {
  BranchesOutlined,
  DisconnectOutlined,
  DownloadOutlined,
  EditOutlined,
  GithubOutlined,
  HddOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RepoSummary } from "../api";
import { useUI } from "../store";
import { StateTag } from "./CrSteps";
import EnvTag from "./EnvTag";
import { relTime } from "./DashboardView";
import { InlineListSkeleton } from "./Skeletons";

// AppDetailsDrawer is the quick-glance side panel for one application: the
// card on the Applications page stays lightweight, and everything deeper
// (health numbers, environments, recent activity) lives here, one click away.
// The deep dive — grid, history, approvals — is one more click, on the
// Configuration page.

export default function AppDetailsDrawer({
  repo,
  open,
  onClose,
}: {
  repo: RepoSummary | null;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const { setSection } = useUI();
  const qc = useQueryClient();
  // The drawer always describes the ACTIVE repository (selecting a card
  // switches first), so the repo-scoped queries below hit the right one.
  const changesQ = useQuery({
    queryKey: ["changes"],
    queryFn: api.changes,
    enabled: open && !!repo && !repo.error,
  });

  const remove = useMutation({
    mutationFn: () => api.removeRepo(repo!.id),
    onSuccess: () => {
      message.info(`"${repo?.name}" was disconnected. The repository itself is untouched on Git.`);
      qc.invalidateQueries({ queryKey: ["workspace"] });
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  if (!repo) return null;
  const r = repo;
  const recent = (changesQ.data ?? []).slice(0, 5);

  const goto = (section: string) => {
    onClose();
    setSection(section);
  };

  return (
    <Drawer
      width={440}
      open={open}
      onClose={onClose}
      title={
        <Space size={10}>
          <span style={{ fontSize: 18, opacity: 0.75 }}>{r.local ? <HddOutlined /> : <GithubOutlined />}</span>
          <span>{r.name}</span>
        </Space>
      }
      footer={
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Space>
            <Button type="primary" icon={<EditOutlined />} onClick={() => goto("overview")}>
              Open configuration
            </Button>
            <Button icon={<DownloadOutlined />} onClick={() => goto("import")}>
              Import settings
            </Button>
          </Space>
          <Button
            danger
            type="text"
            icon={<DisconnectOutlined />}
            onClick={() =>
              Modal.confirm({
                title: `Disconnect "${r.name}"?`,
                content:
                  "It disappears from this workspace only. The Git repository and its history stay exactly as they are, and you can reconnect any time.",
                okText: "Disconnect",
                okButtonProps: { danger: true },
                onOk: () => remove.mutate(),
              })
            }
          >
            Disconnect
          </Button>
        </Space>
      }
    >
      <div className="mono" style={{ fontSize: 12, opacity: 0.6, overflowWrap: "anywhere", marginBottom: 14 }}>
        {r.origin}
      </div>

      {r.error ? (
        <Alert type="error" showIcon message="This application is unavailable" description={r.error} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <Space size={6} wrap>
            {r.branch && (
              <Tag icon={<BranchesOutlined />} className="mono" style={{ fontSize: 11 }}>
                {r.branch}
              </Tag>
            )}
            {r.syncError ? (
              <Tooltip title={r.syncError}>
                <Tag color="warning">sync issue</Tag>
              </Tooltip>
            ) : (r.behind ?? 0) > 0 ? (
              <Tag color="processing">{r.behind} behind remote</Tag>
            ) : (
              <Tag color="success" icon={<SyncOutlined />}>
                git: live
              </Tag>
            )}
            {r.noClone && (
              <Tooltip title="Managed through the GitHub API with no clone on the server">
                <Tag color="geekblue">no clone</Tag>
              </Tooltip>
            )}
            {r.project && r.project !== r.name && <Tag color="geekblue">{r.project}</Tag>}
          </Space>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            <StatCard title="Parameters" value={r.params} />
            <StatCard title="Instances" value={r.instances} />
            <StatCard title="Waiting for approval" value={r.openChanges} tone={r.openChanges ? "#1677ff" : undefined} />
            <StatCard title="Draft edits" value={r.drafts} tone={r.drafts ? "#fa8c16" : undefined} />
          </div>

          {Object.keys(r.environments ?? {}).length > 0 && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Environments
              </Typography.Text>
              <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {Object.entries(r.environments ?? {})
                  .sort()
                  .map(([env, n]) => (
                    <EnvTag key={env} env={env} count={n} />
                  ))}
              </div>
            </div>
          )}

          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Recent activity
            </Typography.Text>
            {changesQ.isLoading ? (
              <InlineListSkeleton />
            ) : recent.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No changes yet."
                style={{ marginTop: 10 }}
              />
            ) : (
              <List
                size="small"
                dataSource={recent}
                renderItem={(cr) => (
                  <List.Item
                    style={{ cursor: "pointer", paddingInline: 0 }}
                    onClick={() => goto(cr.state === "under_review" ? "approvals" : "changes")}
                  >
                    <Space direction="vertical" size={0} style={{ width: "100%" }}>
                      <Space wrap size={6}>
                        <StateTag state={cr.state} />
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          {cr.title}
                        </Typography.Text>
                      </Space>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {cr.author} · {cr.items?.length ?? 0} change{(cr.items?.length ?? 0) === 1 ? "" : "s"} · {relTime(cr.updatedAt)}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function StatCard({ title, value, tone }: { title: string; value: number; tone?: string }) {
  return (
    <div
      style={{
        border: "1px solid rgba(127,137,160,0.18)",
        borderRadius: 10,
        padding: "10px 14px",
      }}
    >
      <Statistic title={title} value={value} valueStyle={{ fontSize: 20, color: tone }} />
    </div>
  );
}
