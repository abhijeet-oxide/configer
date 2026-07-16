import {
  Alert,
  Button,
  Card,
  Dropdown,
  Empty,
  Modal,
  Space,
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
  InfoCircleOutlined,
  MoreOutlined,
  SyncOutlined,
  RightOutlined,
  StarOutlined,
  StarFilled,
  WarningFilled,
} from "@ant-design/icons";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RepoSummary } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { WorkspaceSkeleton } from "./Skeletons";
import { STEP_HANDOFF } from "./ImportWizard";
import AppDetailsDrawer from "./AppDetailsDrawer";
import EditApplicationModal from "./EditApplicationModal";
import NewApplicationWizard from "./NewApplicationWizard";
import EnvTag from "./EnvTag";

// WorkspaceView is the landing page: every application as a light,
// quick-glance card. Clicking a card (or its arrow button) goes straight
// into the application's Configuration page; the info button opens the
// details side panel. Anything that needs a human is flagged in the
// attention rail on the side - which only appears when something does.

const FAV_KEY = "configer.favRepos";

function loadFavs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

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

// What (if anything) about an application needs a human right now, in plain
// words, for the attention rail.
function attentionOf(r: RepoSummary): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = [];
  if (r.error) out.push({ text: "unavailable", color: "var(--c-danger)" });
  if (r.syncError) out.push({ text: "sync issue", color: "var(--c-pending)" });
  if ((r.behind ?? 0) > 0) out.push({ text: `${r.behind} commit${r.behind === 1 ? "" : "s"} behind`, color: "var(--c-review)" });
  if (r.needsSetup) out.push({ text: "not set up yet - finish setup", color: "var(--c-pending)" });
  if (r.openChanges > 0)
    out.push({ text: `${r.openChanges} waiting for approval`, color: "var(--c-review)" });
  if (r.drafts > 0) out.push({ text: "unsent draft edits", color: "var(--c-pending)" });
  return out;
}

function RepoCard({
  r,
  active,
  fav,
  onToggleFav,
  onOpen,
  onDetails,
  onEdit,
  onDisconnect,
}: {
  r: RepoSummary;
  active: boolean;
  fav: boolean;
  onToggleFav: () => void;
  /** go inside: the application's Configuration page */
  onOpen: () => void;
  /** open the details side panel (the info button) */
  onDetails: () => void;
  onEdit: () => void;
  onDisconnect: () => void;
}) {
  const { setSection } = useUI();
  const switchRepo = useSwitchRepo();

  const goto = (section: string) => {
    if (!active) switchRepo(r.id);
    setSection(section);
  };

  return (
    <Card
      hoverable
      onClick={onOpen}
      style={{ borderColor: active ? "var(--ant-color-primary, #2a78d6)" : undefined }}
      styles={{ body: { padding: 14, display: "flex", flexDirection: "column", gap: 10, height: "100%" } }}
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
                { key: "open", label: "Open configuration" },
                { key: "edit", label: "Edit details" },
                { key: "import", label: "Import settings" },
                { type: "divider" },
                { key: "disconnect", danger: true, label: "Disconnect from workspace" },
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === "open") goto("overview");
                if (key === "edit") onEdit();
                if (key === "import") goto("import");
                if (key === "disconnect") onDisconnect();
              },
            }}
          >
            <Button size="small" type="text" icon={<MoreOutlined />} />
          </Dropdown>
        </span>
      </div>

      {r.error ? (
        <Alert type="error" showIcon message={r.error} />
      ) : r.needsSetup ? (
        <Alert
          type="warning"
          showIcon
          message="Not set up yet"
          description="Configer hasn't scanned this repository into an application. Open it to finish setup."
        />
      ) : (
        <>
          <Space size={4} wrap>
            {active && <Tag color="blue">active</Tag>}
            {r.branch && (
              <Tag icon={<BranchesOutlined />} className="mono" style={{ fontSize: 11 }}>
                {r.branch}
              </Tag>
            )}
            <SyncTag r={r} />
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            {r.params} parameter{r.params === 1 ? "" : "s"} · {r.instances} instance{r.instances === 1 ? "" : "s"}
            {r.openChanges > 0 && (
              <>
                {" · "}
                <span style={{ color: "var(--c-review)", fontWeight: 600 }}>{r.openChanges} in review</span>
              </>
            )}
            {r.drafts > 0 && (
              <>
                {" · "}
                <span style={{ color: "var(--c-pending)", fontWeight: 600 }}>draft edits</span>
              </>
            )}
          </Typography.Text>
          <Space size={4} wrap style={{ minHeight: 22 }}>
            {Object.entries(r.environments ?? {})
              .sort()
              .map(([env, n]) => (
                <EnvTag key={env} env={env} count={n} />
              ))}
          </Space>
        </>
      )}
      {/* Footer actions: info opens the side panel; the arrow (like the card
          itself) goes straight inside the application. */}
      <div
        style={{ marginTop: "auto", display: "flex", justifyContent: "flex-end", gap: 6 }}
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip title="Details: health, environments, recent activity">
          <Button size="small" icon={<InfoCircleOutlined />} onClick={onDetails} aria-label="Application details" />
        </Tooltip>
        <Button size="small" type="primary" ghost={!r.needsSetup} onClick={onOpen}>
          {r.needsSetup ? "Finish setup" : "Open"} <RightOutlined style={{ fontSize: 10 }} />
        </Button>
      </div>
    </Card>
  );
}

export default function WorkspaceView() {
  const { message } = AntApp.useApp();
  const { repoId, setSection } = useUI();
  const switchRepo = useSwitchRepo();
  const qc = useQueryClient();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
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

  const remove = useMutation({
    mutationFn: (id: string) => api.removeRepo(id),
    onSuccess: (_, id) => {
      const name = repos.find((r) => r.id === id)?.name ?? id;
      message.info(`"${name}" was disconnected. The repository itself is untouched on Git.`);
      qc.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const confirmDisconnect = (r: RepoSummary) =>
    Modal.confirm({
      title: `Disconnect "${r.name}"?`,
      content:
        "It disappears from this workspace only. The Git repository and its history stay exactly as they are, and you can reconnect any time.",
      okText: "Disconnect",
      okButtonProps: { danger: true },
      onOk: () => remove.mutate(r.id),
    });

  // Open the details side panel for one application; it always describes the
  // active repository, so switch first.
  const openDetails = (r: RepoSummary) => {
    if (r.id !== repoId) switchRepo(r.id);
    setDetailsId(r.id);
  };

  // Go inside: the application's Configuration page (card click / arrow).
  const openConfig = (r: RepoSummary) => {
    if (r.id !== repoId) switchRepo(r.id);
    setSection("overview");
  };

  // Edit details always edits the ACTIVE repository (the endpoint is
  // repo-scoped), so switch first.
  const openEdit = (r: RepoSummary) => {
    if (r.id !== repoId) switchRepo(r.id);
    setEditId(r.id);
  };

  const needsAttention = repos
    .map((r) => ({ r, issues: attentionOf(r) }))
    .filter((x) => x.issues.length > 0);
  const detailsRepo = repos.find((r) => r.id === detailsId) ?? null;

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "16px 24px" }}>
      <div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              Applications
            </Typography.Title>
            <Typography.Text type="secondary">
              Every configuration you manage, straight from Git. Click a card to open it, or its{" "}
              <InfoCircleOutlined /> for a quick view.
            </Typography.Text>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setWizardOpen(true)}>
            New application
          </Button>
        </div>

        {wsQ.isLoading && repos.length === 0 ? (
          // Loading: the full page shape (cards grid), so nothing jumps and the
          // empty state never flashes for connected workspaces.
          <WorkspaceSkeleton />
        ) : repos.length === 0 ? (
          <Card style={{ marginTop: 20 }}>
            <Empty
              description={
                <>
                  <Typography.Paragraph style={{ marginBottom: 4 }}>
                    No applications yet.
                  </Typography.Paragraph>
                  <Typography.Text type="secondary">
                    Create an application to start managing its configuration in Git.
                  </Typography.Text>
                </>
              }
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setWizardOpen(true)}>
                New application
              </Button>
            </Empty>
          </Card>
        ) : (
          <div style={{ display: "flex", gap: 20, marginTop: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div
              style={{
                flex: "1 1 620px",
                minWidth: 0,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                gap: 14,
              }}
            >
              {repos.map((r) => (
                <RepoCard
                  key={r.id}
                  r={r}
                  active={r.id === repoId}
                  fav={favs.includes(r.id)}
                  onToggleFav={() => toggleFav(r.id)}
                  onOpen={() => openConfig(r)}
                  onDetails={() => openDetails(r)}
                  onEdit={() => openEdit(r)}
                  onDisconnect={() => confirmDisconnect(r)}
                />
              ))}
              <Card
                style={{ borderStyle: "dashed", minHeight: 170 }}
                styles={{
                  body: {
                    height: "100%", display: "flex", flexDirection: "column",
                    alignItems: "center", justifyContent: "center", textAlign: "center",
                  },
                }}
                hoverable
                onClick={() => setWizardOpen(true)}
              >
                <PlusOutlined style={{ fontSize: 26, opacity: 0.5 }} />
                <div style={{ marginTop: 8, fontWeight: 500 }}>New application</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  From a Git repository or a local folder
                </Typography.Text>
              </Card>
            </div>

            {/* The attention rail: only what needs a human, in plain words.
                When nothing does, it simply isn't there - no reassurance
                banner taking up space. */}
            {needsAttention.length > 0 && (
              <Card
                size="small"
                title="Needs attention"
                style={{ flex: "0 1 300px", minWidth: 260 }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {needsAttention.map(({ r, issues }) => (
                    <div
                      key={r.id}
                      className="card-clickable"
                      style={{ cursor: "pointer" }}
                      onClick={() => openDetails(r)}
                    >
                      <Space size={6}>
                        <WarningFilled style={{ color: issues[0].color }} />
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          {r.name}
                        </Typography.Text>
                      </Space>
                      <div style={{ marginTop: 2, marginInlineStart: 20 }}>
                        {issues.map((it) => (
                          <div key={it.text} style={{ fontSize: 12, color: it.color }}>
                            {it.text}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}
      </div>

      <AppDetailsDrawer
        repo={detailsRepo}
        open={!!detailsRepo}
        onClose={() => setDetailsId(null)}
        onEdit={() => detailsRepo && openEdit(detailsRepo)}
      />

      {editId && (
        <EditApplicationModal open repoId={editId} onClose={() => setEditId(null)} />
      )}

      <NewApplicationWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={(r) => {
          setWizardOpen(false);
          // Creating an application flows straight into the scan/import step,
          // so the repository is parsed and its settings offered for
          // management right away.
          sessionStorage.setItem(STEP_HANDOFF, "1");
          switchRepo(r.id);
          setSection("import");
        }}
      />
    </div>
  );
}
