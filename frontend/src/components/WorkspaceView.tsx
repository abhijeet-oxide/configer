import {
  Alert,
  Button,
  Card,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
} from "antd";
import {
  PlusOutlined,
  BranchesOutlined,
  GithubOutlined,
  HddOutlined,
  MoreOutlined,
  SyncOutlined,
  DisconnectOutlined,
  RightOutlined,
  DownloadOutlined,
  StarOutlined,
  StarFilled,
  EditOutlined,
} from "@ant-design/icons";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Grid, type RepoSummary } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import DashboardView from "./DashboardView";

// WorkspaceView is the single landing page: every connected configuration as
// a card (favorites pinned first), and right below, the overview of the one
// currently selected: pick a configuration, read its health, press Edit to
// open the editor. One seamless flow instead of separate Workspace and Home.

const FAV_KEY = "configer.favRepos";

function loadFavs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

const envColor: Record<string, string> = {
  production: "red",
  staging: "orange",
  development: "green",
};

function SyncTag({ r }: { r: RepoSummary }) {
  if (r.error) return <Tag color="error">unavailable</Tag>;
  if (r.syncError)
    return (
      <Tooltip title={r.syncError}>
        <Tag color="warning">sync issue</Tag>
      </Tooltip>
    );
  if ((r.behind ?? 0) > 0) return <Tag color="processing">{r.behind} behind</Tag>;
  return (
    <Tag color="success" icon={<SyncOutlined />}>
      git: live
    </Tag>
  );
}

function RepoCard({
  r,
  active,
  fav,
  onToggleFav,
}: {
  r: RepoSummary;
  active: boolean;
  fav: boolean;
  onToggleFav: () => void;
}) {
  const { message } = AntApp.useApp();
  const { setSection } = useUI();
  const switchRepo = useSwitchRepo();
  const qc = useQueryClient();

  const open = (section: string) => {
    if (!active) switchRepo(r.id);
    setSection(section);
  };
  const remove = useMutation({
    mutationFn: () => api.removeRepo(r.id),
    onSuccess: () => {
      message.info(`"${r.name}" was disconnected. The repository itself is untouched on Git.`);
      qc.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Card
        hoverable
        onClick={() => {
          // Selecting a card switches the overview below to this
          // configuration; it does not yank the user to another page.
          if (!active) switchRepo(r.id);
        }}
        style={{
          width: 330,
          height: "100%",
          borderColor: active ? "var(--ant-color-primary, #2a78d6)" : undefined,
        }}
        styles={{ body: { padding: 14 } }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <div style={{ fontSize: 20, opacity: 0.75, marginTop: 2 }}>
            {r.local ? <HddOutlined /> : <GithubOutlined />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Typography.Text strong style={{ fontSize: 14.5 }}>
              {r.name}
            </Typography.Text>
            <div className="mono" style={{ fontSize: 11, opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.origin}
            </div>
          </div>
          <span onClick={(e) => e.stopPropagation()}>
            <Tooltip title={fav ? "Unpin from favorites" : "Mark as favorite (pinned first)"}>
              <Button
                size="small"
                type="text"
                icon={fav ? <StarFilled style={{ color: "#f5b301" }} /> : <StarOutlined />}
                onClick={onToggleFav}
              />
            </Tooltip>
          </span>
          <span onClick={(e) => e.stopPropagation()}>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "editor", label: "Open Config Editor" },
                  { key: "import", label: "Import parameters" },
                  { type: "divider" },
                  { key: "disconnect", danger: true, label: "Disconnect from workspace" },
                ],
                onClick: ({ key, domEvent }) => {
                  domEvent.stopPropagation();
                  if (key === "editor") open("config");
                  if (key === "import") open("import");
                  if (key === "disconnect")
                    Modal.confirm({
                      title: `Disconnect "${r.name}"?`,
                      content:
                        "It disappears from this workspace only. The Git repository and its history stay exactly as they are, and you can reconnect any time.",
                      okText: "Disconnect",
                      okButtonProps: { danger: true },
                      onOk: () => remove.mutate(),
                    });
                },
              }}
            >
              <Button size="small" type="text" icon={<MoreOutlined />} />
            </Dropdown>
          </span>
        </div>

        {r.error ? (
          <Alert type="error" showIcon message={r.error} style={{ marginTop: 12 }} />
        ) : (
          <>
            <Space size={4} wrap style={{ marginTop: 10 }}>
              {active && <Tag color="blue">active</Tag>}
              {r.branch && (
                <Tag icon={<BranchesOutlined />} className="mono" style={{ fontSize: 11 }}>
                  {r.branch}
                </Tag>
              )}
              <SyncTag r={r} />
              {r.project && <Tag color="geekblue">{r.project}</Tag>}
            </Space>
            <div style={{ display: "flex", gap: 24, marginTop: 12 }}>
              <Statistic title="Parameters" value={r.params} valueStyle={{ fontSize: 18 }} />
              <Statistic title="Instances" value={r.instances} valueStyle={{ fontSize: 18 }} />
              <Statistic
                title="In review"
                value={r.openChanges}
                valueStyle={{ fontSize: 18, color: r.openChanges ? "#eda100" : undefined }}
              />
            </div>
            <Space size={4} wrap style={{ marginTop: 10, minHeight: 22 }}>
              {Object.entries(r.environments ?? {})
                .sort()
                .map(([env, n]) => (
                  <Tag key={env} color={envColor[env] ?? "default"} style={{ fontSize: 11 }}>
                    {env} ×{n}
                  </Tag>
                ))}
            </Space>
          </>
        )}
        <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", gap: 6 }}>
          {active ? (
            <Button
              size="small"
              type="primary"
              icon={<EditOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                open("config");
              }}
            >
              Edit configuration
            </Button>
          ) : (
            <Button size="small">
              Select <RightOutlined />
            </Button>
          )}
        </div>
      </Card>
  );
}

// ConnectForm is shared by the workspace modal and the import wizard's
// connect step: a git URL (or a path on the server) plus optional branch,
// display name and access token.
export function ConnectForm({
  onDone,
  compact,
}: {
  onDone: (r: RepoSummary) => void;
  compact?: boolean;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ url: string; name?: string; branch?: string; token?: string }>();
  const connect = useMutation({
    mutationFn: (v: { url: string; name?: string; branch?: string; token?: string }) => api.connectRepo(v),
    onSuccess: (r) => {
      message.success(`Connected "${r.name}"${r.local ? "" : " (cloned on the server)"}.`);
      qc.invalidateQueries({ queryKey: ["workspace"] });
      form.resetFields();
      onDone(r);
    },
    onError: (e: Error) => message.error(e.message, 6),
  });
  return (
    <Form form={form} layout="vertical" onFinish={(v) => connect.mutate(v)} requiredMark={false}>
      <Form.Item
        name="url"
        label="Repository"
        rules={[{ required: true, message: "Give a git URL or a path on the server" }]}
        extra={compact ? undefined : "A GitHub/https git URL is cloned and kept in sync on the server; a directory path is opened in place."}
      >
        <Input placeholder="https://github.com/acme/network-config.git" className="mono" />
      </Form.Item>
      <div style={{ display: "flex", gap: 10 }}>
        <Form.Item name="name" label="Display name (optional)" style={{ flex: 1 }}>
          <Input placeholder="e.g. Network Platform" maxLength={60} />
        </Form.Item>
        <Form.Item name="branch" label="Branch (optional)" style={{ flex: 1 }}>
          <Input placeholder="default branch" className="mono" maxLength={80} />
        </Form.Item>
      </div>
      <Form.Item
        name="token"
        label="Access token (private repositories)"
        extra="Used by the server to clone, fetch and push. It never leaves the server and is never shown again."
      >
        <Input.Password placeholder="ghp_… (optional)" autoComplete="off" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={connect.isPending} icon={<PlusOutlined />}>
        Connect repository
      </Button>
    </Form>
  );
}

export default function WorkspaceView({ grid }: { grid?: Grid }) {
  const { repoId, setSection } = useUI();
  const switchRepo = useSwitchRepo();
  const [connectOpen, setConnectOpen] = useState(false);
  const [favs, setFavs] = useState<string[]>(loadFavs);
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, refetchInterval: 20_000 });
  // favorites pinned first, connection order otherwise
  const repos = [...(wsQ.data?.repos ?? [])].sort(
    (a, b) => Number(favs.includes(b.id)) - Number(favs.includes(a.id)),
  );
  const toggleFav = (id: string) =>
    setFavs((f) => {
      const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id];
      localStorage.setItem(FAV_KEY, JSON.stringify(next));
      return next;
    });

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "16px 24px" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              Workspace
            </Typography.Title>
            <Typography.Text type="secondary">
              Pick a configuration to see its overview below; everything stays in Git.
            </Typography.Text>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setConnectOpen(true)}>
            Connect repository
          </Button>
        </div>

        {repos.length === 0 && !wsQ.isLoading ? (
          <Card style={{ marginTop: 20 }}>
            <Empty
              description={
                <>
                  <Typography.Paragraph style={{ marginBottom: 4 }}>
                    No repositories are connected yet.
                  </Typography.Paragraph>
                  <Typography.Text type="secondary">
                    Connect a Git repository to start managing its configuration.
                  </Typography.Text>
                </>
              }
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setConnectOpen(true)}>
                Connect repository
              </Button>
            </Empty>
          </Card>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 16, alignItems: "stretch" }}>
            {repos.map((r) => (
              <RepoCard
                key={r.id}
                r={r}
                active={r.id === repoId}
                fav={favs.includes(r.id)}
                onToggleFav={() => toggleFav(r.id)}
              />
            ))}
            <Card
              style={{ width: 330, borderStyle: "dashed", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 200 }}
              styles={{ body: { textAlign: "center" } }}
              hoverable
              onClick={() => setConnectOpen(true)}
            >
              <PlusOutlined style={{ fontSize: 26, opacity: 0.5 }} />
              <div style={{ marginTop: 8, fontWeight: 500 }}>Connect repository</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                GitHub URL or a path on the server
              </Typography.Text>
            </Card>
          </div>
        )}

        <Typography.Paragraph type="secondary" style={{ marginTop: 14, fontSize: 12 }}>
          <DownloadOutlined /> Tip: after connecting, use <a onClick={() => setSection("import")}>Import</a> to
          bring the repository's settings under management. <DisconnectOutlined style={{ marginInlineStart: 10 }} />{" "}
          Disconnecting never deletes anything on Git.
        </Typography.Paragraph>

        {grid && repoId && (
          <div style={{ marginTop: 4, borderTop: "1px solid rgba(128,128,128,0.2)" }}>
            <DashboardView grid={grid} embedded />
          </div>
        )}
      </div>

      <Modal
        title="Connect a repository"
        open={connectOpen}
        onCancel={() => setConnectOpen(false)}
        footer={null}
        destroyOnClose
      >
        <ConnectForm
          onDone={(r) => {
            setConnectOpen(false);
            switchRepo(r.id);
          }}
        />
      </Modal>
    </div>
  );
}
