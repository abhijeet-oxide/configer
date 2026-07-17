import { Button } from "antd";
import { useQueries, useQuery } from "@tanstack/react-query";
import { BranchesOutlined, GithubOutlined, HddOutlined, ExportOutlined } from "../icons";
import { api } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { WorkspaceSkeleton } from "./Skeletons";
import { SectionCard, EmptyState, StatusPill, MonoChip } from "./ui";
import { EmptyArt } from "./illustrations";

// RepositoriesOverview is the WORKSPACE-WIDE repository list behind the rail's
// Repositories entry: one card per application repository with its Git
// reality - branch, local vs remote, sync state and repository-changes
// (drift) count - and a jump into that application's Repository changes view.
// It answers "what is the Git health of my whole estate" in one screen.

export default function RepositoriesOverview() {
  const { repoId, setSection } = useUI();
  const switchRepo = useSwitchRepo();
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const repos = wsQ.data?.repos ?? [];

  // Per-repo drift count, fetched lazily (best effort; a repo with no
  // committed baseline simply reports zero).
  const findingQs = useQueries({
    queries: repos.map((r) => ({
      queryKey: ["repo-findings", r.id],
      queryFn: () => api.findingsOf(r.id),
      staleTime: 60_000,
      retry: false,
    })),
  });

  const open = (id: string, section: string) => {
    if (id !== repoId) switchRepo(id);
    setSection(section);
  };

  if (wsQ.isLoading)
    return (
      <div className="h-full overflow-auto bg-canvas p-6">
        <WorkspaceSkeleton />
      </div>
    );

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-canvas px-6 py-5">
      <div>
        <div className="text-xl font-semibold text-ink">Repositories</div>
        <div className="text-[13px] text-ink-2">
          The Git repository behind each application, with its branch and sync state.
        </div>
      </div>

      {repos.length === 0 ? (
        <SectionCard>
          <EmptyState art={<EmptyArt size={104} />} title="No repositories connected" hint="Connect a Git repository to manage an application." />
        </SectionCard>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
          {repos.map((r, i) => {
            const drift = findingQs[i]?.data?.findings?.length ?? 0;
            const gitUrl = r.origin?.startsWith("http") ? r.origin : undefined;
            return (
              <SectionCard key={r.id}>
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 text-ink-2">{r.local ? <HddOutlined /> : <GithubOutlined />}</span>
                  <div className="min-w-0 flex-1">
                    <button
                      className="truncate text-left text-sm font-semibold text-ink hover:text-brand"
                      onClick={() => open(r.id, "overview")}
                    >
                      {r.name}
                    </button>
                    {r.origin && (
                      <div className="mono truncate text-[11px] text-ink-3" title={r.origin}>
                        {r.origin}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {r.branch && <MonoChip icon={<BranchesOutlined style={{ fontSize: 10 }} />}>{r.branch}</MonoChip>}
                  {r.local ? (
                    <StatusPill tone="neutral">Local</StatusPill>
                  ) : r.syncError ? (
                    <StatusPill tone="danger">Sync issue</StatusPill>
                  ) : (r.behind ?? 0) > 0 ? (
                    <StatusPill tone="pending">{r.behind} behind</StatusPill>
                  ) : (
                    <StatusPill tone="ok">Synced</StatusPill>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
                  <button onClick={() => open(r.id, "config")}>
                    <div className="text-sm font-semibold text-ink">{r.params}</div>
                    <div className="text-[11px] text-ink-3">parameters</div>
                  </button>
                  <button onClick={() => open(r.id, "instances")}>
                    <div className="text-sm font-semibold text-ink">{r.instances}</div>
                    <div className="text-[11px] text-ink-3">instances</div>
                  </button>
                  <button onClick={() => open(r.id, "drift")}>
                    <div className={`text-sm font-semibold ${drift ? "text-[color:var(--c-pending)]" : "text-ink"}`}>{drift}</div>
                    <div className="text-[11px] text-ink-3">repo changes</div>
                  </button>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <Button size="small" onClick={() => open(r.id, "drift")}>
                    Repository changes
                  </Button>
                  {gitUrl && (
                    <Button size="small" icon={<ExportOutlined />} href={gitUrl} target="_blank">
                      View in Git
                    </Button>
                  )}
                </div>
              </SectionCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
