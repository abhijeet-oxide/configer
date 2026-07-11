import {
  Alert,
  Button,
  Card,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Radio,
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
import { api, type RepoSummary } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";

// WorkspaceView is the Applications portfolio: every connected application as a
// card (favorites pinned first). It is a launcher, not a dashboard: opening a
// card takes you into the application (its Configuration), where the per-app
// Overview, Instances, Change Requests, Compare and History live as tabs.

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
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameVal, setRenameVal] = useState(r.name);

  const rename = useMutation({
    mutationFn: (name: string) => api.renameRepo(r.id, name),
    onSuccess: (s) => {
      message.success(`Renamed to "${s.name}"`);
      qc.invalidateQueries({ queryKey: ["workspace"] });
      setRenameOpen(false);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const open = (section: string) => {
    if (!active) switchRepo(r.id);
    setSection(section);
  };
  // A normal click opens the application at its Overview (its command center);
  // the primary button below still jumps straight to editing the configuration.
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
        onClick={() => open("overview")}
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
                  { key: "overview", label: "Open overview" },
                  { key: "editor", label: "Open configuration" },
                  { key: "rename", icon: <EditOutlined />, label: "Rename application…" },
                  { key: "import", label: "Import parameters" },
                  { type: "divider" },
                  { key: "disconnect", danger: true, label: "Disconnect from workspace" },
                ],
                onClick: ({ key, domEvent }) => {
                  domEvent.stopPropagation();
                  if (key === "overview") open("overview");
                  if (key === "editor") open("config");
                  if (key === "rename") {
                    setRenameVal(r.name);
                    setRenameOpen(true);
                  }
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
              {r.noClone && (
                <Tooltip title="Managed through the GitHub API with no clone on the server">
                  <Tag color="geekblue">no clone</Tag>
                </Tooltip>
              )}
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
      <span onClick={(e) => e.stopPropagation()}>
        <Modal
          title="Rename application"
          open={renameOpen}
          onCancel={() => setRenameOpen(false)}
          onOk={() => rename.mutate(renameVal.trim())}
          okText="Rename"
          okButtonProps={{ disabled: !renameVal.trim() || renameVal.trim() === r.name, loading: rename.isPending }}
          destroyOnClose
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            This changes the display name only. The Git repository, its history and any shared links
            stay exactly as they are.
          </Typography.Paragraph>
          <Input
            value={renameVal}
            maxLength={80}
            autoFocus
            onChange={(e) => setRenameVal(e.target.value)}
            onPressEnter={() => renameVal.trim() && renameVal.trim() !== r.name && rename.mutate(renameVal.trim())}
            placeholder="Application name"
          />
        </Modal>
      </span>
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
  const [form] = Form.useForm<{ url: string; name?: string; branch?: string; token?: string; mode?: "clone" | "remote" }>();
  const connect = useMutation({
    mutationFn: (v: { url: string; name?: string; branch?: string; token?: string; mode?: "clone" | "remote" }) =>
      api.connectRepo({ ...v, mode: v.mode === "remote" ? "remote" : undefined }),
    onSuccess: (r) => {
      const how = r.local ? "opened in place" : r.noClone ? "connected via the GitHub API (no clone)" : "cloned on the server";
      message.success(`Connected "${r.name}" (${how}).`);
      qc.invalidateQueries({ queryKey: ["workspace"] });
      form.resetFields();
      onDone(r);
    },
    onError: (e: Error) => message.error(e.message, 6),
  });
  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={(v) => connect.mutate(v)}
      requiredMark={false}
      initialValues={{ mode: "clone" }}
    >
      <Form.Item
        name="url"
        label="Repository"
        rules={[{ required: true, message: "Give a git URL or a path on the server" }]}
        extra={compact ? undefined : "A GitHub/https git URL is cloned and kept in sync on the server; a directory path is opened in place."}
      >
        <Input placeholder="https://github.com/acme/network-config.git" className="mono" autoFocus />
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
        extra="Used by the server for Git operations. It never leaves the server and is never shown again."
      >
        <Input.Password placeholder="ghp_… (optional)" autoComplete="off" />
      </Form.Item>
      <Form.Item
        name="mode"
        label="How should the server manage it?"
        extra={
          compact
            ? undefined
            : "Clone keeps a working copy on the server. Remote uses the GitHub API for partial checkouts and commits with nothing cloned (a GitHub https URL and token are required)."
        }
      >
        <Radio.Group>
          <Radio.Button value="clone">Clone on server</Radio.Button>
          <Radio.Button value="remote">Remote via GitHub API (no clone)</Radio.Button>
        </Radio.Group>
      </Form.Item>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button type="primary" htmlType="submit" loading={connect.isPending} icon={<PlusOutlined />}>
          Connect repository
        </Button>
      </div>
    </Form>
  );
}

// PortfolioSignals leads with what actually needs a human at the portfolio
// level, not vanity totals. Counting applications, instances or parameters
// tells an operator nothing actionable; what matters across a fleet is what is
// waiting on a decision and what is unhealthy.
function needsAttention(r: RepoSummary): boolean {
  return !!r.error || !!r.syncError || (r.behind ?? 0) > 0;
}

function PortfolioSignals({ repos, onReview }: { repos: RepoSummary[]; onReview: () => void }) {
  const awaiting = repos.reduce((a, r) => a + (r.openChanges ?? 0), 0);
  const awaitingApps = repos.filter((r) => (r.openChanges ?? 0) > 0).length;
  const attention = repos.filter(needsAttention);
  const production = repos.reduce((a, r) => a + (r.environments?.production ?? 0), 0);

  const cards: {
    label: string;
    value: React.ReactNode;
    caption: string;
    accent: string;
    color?: string;
    onClick?: () => void;
  }[] = [
    {
      label: "Awaiting approval",
      value: awaiting,
      caption: awaiting
        ? `across ${awaitingApps} application${awaitingApps === 1 ? "" : "s"}`
        : "no changes in review",
      accent: "#fa8c16",
      color: awaiting ? "#d48806" : undefined,
      onClick: awaiting ? onReview : undefined,
    },
    {
      label: "Needs attention",
      value: attention.length,
      caption: attention.length
        ? attention
            .slice(0, 2)
            .map((r) => r.name)
            .join(", ") + (attention.length > 2 ? "…" : "")
        : "all applications healthy",
      accent: attention.length ? "#f5222d" : "#0ca30c",
      color: attention.length ? "#cf1322" : "#389e0d",
    },
    {
      label: "Production systems",
      value: production,
      caption: "live deployments under management",
      accent: "#6c3df4",
    },
  ];

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 16 }}>
      {cards.map((s) => (
        <Card
          key={s.label}
          size="small"
          className="stat-accent"
          hoverable={!!s.onClick}
          onClick={s.onClick}
          style={{ "--accent": s.accent, minWidth: 210, flex: "1 1 210px", maxWidth: 300, cursor: s.onClick ? "pointer" : "default" } as React.CSSProperties}
        >
          <Statistic title={s.label} value={s.value as string | number} valueStyle={{ fontSize: 22, color: s.color }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {s.caption}
          </Typography.Text>
        </Card>
      ))}
    </div>
  );
}

export default function WorkspaceView() {
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
    <div style={{ height: "100%", overflow: "auto", padding: "20px 28px" }}>
      <div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              Applications
            </Typography.Title>
            <Typography.Text type="secondary">
              Every application you manage. Open one to configure it; everything stays in Git.
            </Typography.Text>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setConnectOpen(true)}>
            Add application
          </Button>
        </div>

        {repos.length > 0 && <PortfolioSignals repos={repos} onReview={() => setSection("approvals")} />}

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
            // Onboarding: flow straight from connecting an application into
            // scanning/importing its configuration.
            setSection("import");
          }}
        />
      </Modal>
    </div>
  );
}
