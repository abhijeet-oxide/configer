import { PlusOutlined, AppstoreOutlined, CheckCircleFilled } from "../icons";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { attentionOf } from "../attention";
import { StatTile, SectionCard, AttentionCard, EmptyState, Stagger, StaggerItem } from "./ui";
import { HomeAppCard } from "./AppCard";
import NewApplicationWizard from "./NewApplicationWizard";
import { STEP_HANDOFF } from "./ImportWizard";
import { WorkspaceSkeleton } from "./Skeletons";

// HomeView is the operational start page: what needs attention, how the
// estate is doing, and the applications you manage, in that order. It reads
// only the workspace summary (one request), so it is fast and honest.

function greeting(name?: string): string {
  const h = new Date().getHours();
  const day = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  return name ? `Good ${day}, ${name}` : `Good ${day}`;
}

export default function HomeView() {
  const { repoId, setSection } = useUI();
  const switchRepo = useSwitchRepo();
  const [wizardOpen, setWizardOpen] = useState(false);
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, refetchInterval: 20_000 });
  const meQ = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });

  const repos = wsQ.data?.repos ?? [];
  const instances = repos.reduce((n, r) => n + (r.instances || 0), 0);
  const synced = repos.filter((r) => !r.error && !r.syncError && !(r.behind ?? 0)).length;
  const attention = repos
    .flatMap((r) => attentionOf(r).map((it) => ({ r, it })))
    .sort((a, b) => (a.it.severity === "danger" ? -1 : 0) - (b.it.severity === "danger" ? -1 : 0));
  const firstName = meQ.data?.user?.name?.split(" ")[0] || meQ.data?.user?.login;

  const goto = (repoIdTarget: string, section: string) => {
    if (repoIdTarget !== repoId) switchRepo(repoIdTarget);
    setSection(section);
  };

  if (wsQ.isLoading)
    return (
      <div className="h-full overflow-auto bg-canvas p-6">
        <WorkspaceSkeleton />
      </div>
    );

  return (
    <div className="h-full overflow-auto bg-canvas px-6 py-5">
      <div className="mx-auto max-w-[1240px]">
        {/* Greeting + estate numbers, restrained like the reference. */}
        <div className="mb-5 flex flex-wrap items-start gap-4">
          <div className="min-w-60 flex-1">
            <div className="text-xl font-semibold text-ink">{greeting(firstName)}</div>
            <div className="mt-0.5 text-[13px] text-ink-2">
              An overview of your applications and anything requiring attention.
            </div>
          </div>
          <div className="flex gap-3">
            <StatTile label="Applications" value={repos.length} onClick={() => setSection("workspace")} />
            <StatTile label="Instances" value={instances} />
          </div>
        </div>

        {repos.length === 0 ? (
          <SectionCard>
            <EmptyState
              icon={<AppstoreOutlined />}
              title="Connect your first application"
              hint="Connect a Git repository or local folder to begin managing its configuration."
              actionLabel="New application"
              onAction={() => setWizardOpen(true)}
            />
          </SectionCard>
        ) : (
          <Stagger>
            {/* Attention is shown ONLY when something actually needs the
                user; a clean estate simply omits the card (no "nothing needs
                you" noise) and leads with system health. */}
            {attention.length > 0 && (
              <StaggerItem className="mb-5">
                <SectionCard title="Needs your attention">
                  <div className="flex flex-col gap-2">
                    {attention.slice(0, 5).map(({ r, it }) => (
                      <AttentionCard
                        key={`${r.id}-${it.key}`}
                        severity={it.severity}
                        title={r.name}
                        sub={it.text}
                        actionLabel={it.actionLabel}
                        onAction={() => goto(r.id, it.section)}
                        primary={it.severity !== "danger"}
                      />
                    ))}
                  </div>
                </SectionCard>
              </StaggerItem>
            )}

            <StaggerItem className="mb-5">
              <SectionCard title="System health">
                <div className="mb-3 flex items-center gap-2.5">
                  {attention.length === 0 ? (
                    <>
                      <CheckCircleFilled style={{ color: "var(--c-ok)", fontSize: 18 }} />
                      <div>
                        <div className="text-[13px] font-semibold">All systems operational</div>
                        <div className="text-[11px] text-ink-3">All applications synchronized with Git</div>
                      </div>
                    </>
                  ) : (
                    <div>
                      <div className="text-[13px] font-semibold">
                        {attention.length} item{attention.length === 1 ? "" : "s"} to look at
                      </div>
                      <div className="text-[11px] text-ink-3">Listed above, each with its next step</div>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3 border-t border-line pt-3">
                  {[
                    { label: "Applications", value: `${synced} synced` },
                    { label: "Instances", value: String(instances) },
                    { label: "Waiting review", value: String(repos.reduce((n, r) => n + r.openChanges, 0)) },
                  ].map((s) => (
                    <div key={s.label}>
                      <div className="text-[11px] text-ink-3">{s.label}</div>
                      <div className="text-sm font-semibold">{s.value}</div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </StaggerItem>

            {/* The application collection, compact. */}
            <StaggerItem className="mb-3 text-[13px] font-semibold text-ink">Your applications</StaggerItem>
            <StaggerItem className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
              {repos.map((r) => (
                <HomeAppCard key={r.id} r={r} onOpen={() => goto(r.id, "overview")} />
              ))}
              <div
                className="card-clickable flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-card border border-dashed border-line-strong bg-surface/60 text-center text-ink-2"
                onClick={() => setWizardOpen(true)}
                role="button"
              >
                <PlusOutlined style={{ fontSize: 22, color: "var(--brand)" }} />
                <div className="mt-1.5 font-medium text-brand">New application</div>
                <div className="text-xs text-ink-3">Import or create a new application</div>
              </div>
            </StaggerItem>
          </Stagger>
        )}
      </div>

      <NewApplicationWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={(r) => {
          setWizardOpen(false);
          sessionStorage.setItem(STEP_HANDOFF, "1");
          switchRepo(r.id);
          setSection("import");
        }}
      />
    </div>
  );
}
