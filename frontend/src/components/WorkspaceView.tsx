import { Button, Modal, App as AntApp } from "antd";
import { PlusOutlined, AppstoreOutlined } from "../icons";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RepoSummary } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { attentionOf } from "../attention";
import { WorkspaceSkeleton } from "./Skeletons";
import { STEP_HANDOFF } from "./ImportWizard";
import { PageHeader, SectionCard, AttentionCard, EmptyState } from "./ui";
import AppCard from "./AppCard";
import AppDetailsDrawer from "./AppDetailsDrawer";
import EditApplicationModal from "./EditApplicationModal";
import NewApplicationWizard from "./NewApplicationWizard";

// WorkspaceView is the applications collection: every configuration you
// manage as a card. Clicking a card goes straight into the application;
// anything that needs a human is flagged in the attention rail, which only
// appears when something does.

const FAV_KEY = "configer.favRepos";

function loadFavs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
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
  const goto = (r: RepoSummary, section: string) => {
    if (r.id !== repoId) switchRepo(r.id);
    setSection(section);
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
    <div className="h-full overflow-auto bg-canvas px-6 py-5">
      <PageHeader
        title="Applications"
        description="Every configuration you manage, straight from Git. Click a card to open it."
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setWizardOpen(true)}>
            New application
          </Button>
        }
      />

      {wsQ.isLoading && repos.length === 0 ? (
        // Loading: the full page shape (cards grid), so nothing jumps and the
        // empty state never flashes for connected workspaces.
        <WorkspaceSkeleton />
      ) : repos.length === 0 ? (
        <SectionCard>
          <EmptyState
            icon={<AppstoreOutlined />}
            title="Connect your first application"
            hint="Point Configer at a Git repository or a local folder and it becomes a managed application: parameters, instances, drafts, reviews."
            actionLabel="New application"
            onAction={() => setWizardOpen(true)}
          />
        </SectionCard>
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          <div
            className="grid min-w-0 gap-3.5"
            style={{ flex: "1 1 620px", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
          >
            {repos.map((r) => (
              <AppCard
                key={r.id}
                r={r}
                active={r.id === repoId}
                fav={favs.includes(r.id)}
                onToggleFav={() => toggleFav(r.id)}
                onOpen={() => goto(r, "overview")}
                onDetails={() => openDetails(r)}
                onEdit={() => openEdit(r)}
                onImport={() => goto(r, "import")}
                onDisconnect={() => confirmDisconnect(r)}
              />
            ))}
            <div
              className="card-clickable flex min-h-[170px] cursor-pointer flex-col items-center justify-center rounded-card border border-dashed border-line-strong bg-surface/60 text-center text-ink-2"
              onClick={() => setWizardOpen(true)}
              role="button"
            >
              <PlusOutlined style={{ fontSize: 26, color: "var(--brand)" }} />
              <div className="mt-2 font-medium text-brand">New application</div>
              <div className="text-xs text-ink-3">From a Git repository or a local folder</div>
            </div>
          </div>

          {/* The attention rail: only what needs a human, in plain words.
              When nothing does, it simply isn't there. */}
          {needsAttention.length > 0 && (
            <SectionCard title="Needs attention" style={{ flex: "0 1 340px", minWidth: 280 }}>
              <div className="flex flex-col gap-2">
                {needsAttention.map(({ r, issues }) => (
                  <AttentionCard
                    key={r.id}
                    severity={issues[0].severity}
                    title={r.name}
                    sub={issues.map((it) => it.text).join(" · ")}
                    actionLabel={issues[0].actionLabel}
                    onAction={() => goto(r, issues[0].section)}
                    primary={issues[0].severity !== "danger"}
                  />
                ))}
              </div>
            </SectionCard>
          )}
        </div>
      )}

      <AppDetailsDrawer
        repo={detailsRepo}
        open={!!detailsRepo}
        onClose={() => setDetailsId(null)}
        onEdit={() => detailsRepo && openEdit(detailsRepo)}
      />

      {editId && <EditApplicationModal open repoId={editId} onClose={() => setEditId(null)} />}

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
