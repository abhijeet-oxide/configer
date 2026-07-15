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
  CheckCircleFilled,
  DisconnectOutlined,
  DownloadOutlined,
  EditOutlined,
  FormOutlined,
  GithubOutlined,
  HddOutlined,
  RightOutlined,
  SyncOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RepoSummary } from "../api";
import { useUI } from "../store";
import { StateTag } from "./CrSteps";
import EnvTag from "./EnvTag";
import { relTime } from "./DashboardView";
import { InlineListSkeleton } from "./Skeletons";

// AppDetailsDrawer is the quick-glance side panel for one application: the
// card on the Applications page stays lightweight, and everything deeper —
// health per system (with a straight jump to any problem cell), description
// and metadata from Git, environments, recent activity — lives here, one
// click away. The deep dive is one more click, on the Configuration page.

export default function AppDetailsDrawer({
  repo,
  open,
  onClose,
  onEdit,
}: {
  repo: RepoSummary | null;
  open: boolean;
  onClose: () => void;
  onEdit?: () => void;
}) {
  const { message } = AntApp.useApp();
  const { setSection, selectParam, selectInstance, setJump } = useUI();
  const qc = useQueryClient();
  // The drawer always describes the ACTIVE repository (selecting a card
  // switches first), so the repo-scoped queries below hit the right one. A
  // not-yet-initialized repository has no grid/changes/application to load.
  const enabled = open && !!repo && !repo.error && !repo.needsSetup;
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, enabled });
  const appQ = useQuery({ queryKey: ["application", repo?.id], queryFn: api.application, enabled });
  const gridQ = useQuery({ queryKey: ["grid"], queryFn: api.grid, enabled });

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

  // Per-system health from the real grid: how many values break a rule in
  // each instance, plus the first offending parameter so a click can land
  // the user straight on the problem cell.
  const health = (gridQ.data?.instances ?? []).map((inst) => {
    let invalid = 0;
    let firstParam: string | null = null;
    for (const row of gridQ.data?.rows ?? []) {
      const c = row.cells[inst.name];
      if (c && !c.valid) {
        invalid++;
        if (!firstParam) firstParam = row.param.id;
      }
    }
    return { inst, invalid, firstParam };
  });
  const totalInvalid = health.reduce((s, h) => s + h.invalid, 0);

  const jumpToProblem = (h: (typeof health)[number]) => {
    if (!h.firstParam) return;
    onClose();
    selectParam(h.firstParam);
    selectInstance(h.inst.name);
    setJump("cell", h.firstParam, h.inst.name);
    setSection("config");
  };

  const metadata = Object.entries(appQ.data?.metadata ?? {});

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
        // Primary action first and full width; secondary actions share a row
        // beneath it, with the destructive one kept apart as an icon.
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Button type="primary" block icon={<EditOutlined />} onClick={() => goto("overview")}>
            {r.needsSetup ? "Finish setup" : "Open configuration"}
          </Button>
          <div style={{ display: "flex", gap: 8 }}>
            <Button block icon={<FormOutlined />} onClick={onEdit}>
              Edit details
            </Button>
            <Button block icon={<DownloadOutlined />} onClick={() => goto("import")}>
              Import settings
            </Button>
            <Tooltip title="Disconnect from this workspace (the Git repository is untouched)">
              <Button
                danger
                icon={<DisconnectOutlined />}
                aria-label="Disconnect from workspace"
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
              />
            </Tooltip>
          </div>
        </div>
      }
    >
      <div className="mono" style={{ fontSize: 12, opacity: 0.6, overflowWrap: "anywhere", marginBottom: 14 }}>
        {r.origin}
      </div>

      {r.error ? (
        <Alert type="error" showIcon message="This application is unavailable" description={r.error} />
      ) : r.needsSetup ? (
        <Alert
          type="info"
          showIcon
          message="Not set up yet"
          description="This repository is connected but hasn't been scanned into a Configer application. Finish setup to detect its instances and settings."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {appQ.data?.description && (
            <Typography.Paragraph style={{ margin: 0, fontSize: 13 }}>
              {appQ.data.description}
            </Typography.Paragraph>
          )}

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
            <StatCard title="Invalid values" value={totalInvalid} tone={totalInvalid ? "#cf1322" : undefined} />
            <StatCard title="Waiting for approval" value={r.openChanges} tone={r.openChanges ? "#1677ff" : undefined} />
          </div>

          {/* System health: the same signal as the Overview's health map, so
              the quick view never hides a problem the inside would show. */}
          {health.length > 0 && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                System health
              </Typography.Text>
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {health.map((h) => (
                  <div
                    key={h.inst.name}
                    className={h.invalid ? "card-clickable" : undefined}
                    onClick={h.invalid ? () => jumpToProblem(h) : undefined}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 12.5,
                      padding: "3px 6px",
                      borderRadius: 6,
                      cursor: h.invalid ? "pointer" : undefined,
                    }}
                  >
                    {h.invalid ? (
                      <WarningFilled style={{ color: "var(--c-danger)" }} />
                    ) : (
                      <CheckCircleFilled style={{ color: "var(--c-ok)" }} />
                    )}
                    <span style={{ flex: 1 }}>{h.inst.name}</span>
                    {h.invalid ? (
                      <span style={{ color: "var(--c-danger)", fontWeight: 600 }}>
                        {h.invalid} invalid <RightOutlined style={{ fontSize: 10 }} />
                      </span>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        all valid
                      </Typography.Text>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

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

          {metadata.length > 0 && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Metadata
              </Typography.Text>
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
                {metadata.map(([k, v]) => (
                  <div key={k} style={{ display: "flex", gap: 10, fontSize: 12.5 }}>
                    <Typography.Text type="secondary" className="mono" style={{ fontSize: 12, minWidth: 110 }}>
                      {k}
                    </Typography.Text>
                    <span style={{ overflowWrap: "anywhere" }}>{v}</span>
                  </div>
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
