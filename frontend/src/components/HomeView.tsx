import { PlusOutlined, AppstoreOutlined, CheckCircleFilled } from "@ant-design/icons";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { attentionOf } from "../attention";
import { StatTile, SectionCard, AttentionCard, EmptyState } from "./ui";
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
      <div style={{ height: "100%", overflow: "auto", padding: "var(--sp-5) var(--sp-6)", background: "var(--canvas)" }}>
        <WorkspaceSkeleton />
      </div>
    );

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "var(--sp-5) var(--sp-6)", background: "var(--canvas)" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto" }}>
        {/* Greeting + estate numbers, restrained like the reference. */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-4)", flexWrap: "wrap", marginBottom: "var(--sp-5)" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: "var(--fs-20)", fontWeight: 650, color: "var(--text)" }}>
              {greeting(firstName)} <span aria-hidden>👋</span>
            </div>
            <div style={{ fontSize: "var(--fs-13)", color: "var(--text-2)", marginTop: 2 }}>
              Here's what's happening across your applications.
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--sp-3)" }}>
            <StatTile label="Applications" value={repos.length} onClick={() => setSection("workspace")} />
            <StatTile label="Instances" value={instances} />
          </div>
        </div>

        {repos.length === 0 ? (
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
          <>
            {/* Attention + system health, side by side like the reference. */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                gap: "var(--sp-4)",
                marginBottom: "var(--sp-5)",
              }}
            >
              <SectionCard title="Needs your attention">
                {attention.length === 0 ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "var(--sp-2) 0", color: "var(--text-2)" }}>
                    <CheckCircleFilled style={{ color: "var(--c-ok)", fontSize: 16 }} />
                    Nothing needs you right now.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {attention.slice(0, 4).map(({ r, it }) => (
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
                )}
              </SectionCard>

              <SectionCard title="System health">
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "var(--sp-3)" }}>
                  {attention.length === 0 ? (
                    <>
                      <CheckCircleFilled style={{ color: "var(--c-ok)", fontSize: 18 }} />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "var(--fs-13)" }}>All systems operational</div>
                        <div style={{ fontSize: "var(--fs-11)", color: "var(--text-3)" }}>
                          Everything synchronized with Git
                        </div>
                      </div>
                    </>
                  ) : (
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "var(--fs-13)" }}>
                        {attention.length} item{attention.length === 1 ? "" : "s"} to look at
                      </div>
                      <div style={{ fontSize: "var(--fs-11)", color: "var(--text-3)" }}>
                        Listed on the left, each with its next step
                      </div>
                    </div>
                  )}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: "var(--sp-3)",
                    borderTop: "1px solid var(--border)",
                    paddingTop: "var(--sp-3)",
                  }}
                >
                  {[
                    { label: "Applications", value: `${synced} synced` },
                    { label: "Instances", value: String(instances) },
                    { label: "Waiting review", value: String(repos.reduce((n, r) => n + r.openChanges, 0)) },
                  ].map((s) => (
                    <div key={s.label}>
                      <div style={{ fontSize: "var(--fs-11)", color: "var(--text-3)" }}>{s.label}</div>
                      <div style={{ fontSize: "var(--fs-14)", fontWeight: 600 }}>{s.value}</div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </div>

            {/* The application collection, compact. */}
            <div style={{ fontSize: "var(--fs-13)", fontWeight: 600, color: "var(--text)", marginBottom: "var(--sp-3)" }}>
              Your applications
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                gap: "var(--sp-4)",
              }}
            >
              {repos.map((r) => (
                <HomeAppCard key={r.id} r={r} onOpen={() => goto(r.id, "overview")} />
              ))}
              <div
                className="card-clickable"
                onClick={() => setWizardOpen(true)}
                role="button"
                style={{
                  border: "1px dashed var(--border-strong)",
                  borderRadius: "var(--r-lg)",
                  minHeight: 140,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  cursor: "pointer",
                  color: "var(--text-2)",
                }}
              >
                <PlusOutlined style={{ fontSize: 22, color: "var(--brand)" }} />
                <div style={{ marginTop: 6, fontWeight: 500, color: "var(--brand)" }}>New application</div>
                <div style={{ fontSize: 12, color: "var(--text-3)" }}>Import or create a new application</div>
              </div>
            </div>
          </>
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
