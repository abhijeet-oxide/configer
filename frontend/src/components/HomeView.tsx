import { PlusOutlined, AppstoreOutlined, CheckCircleFilled, EditOutlined, ArrowRightOutlined } from "../icons";
import { Button } from "antd";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { attentionOf } from "../attention";
import { SectionCard, AttentionCard, EmptyState, Stagger, StaggerItem } from "./ui";
import { HomeAppCard } from "./AppCard";
import NewApplicationWizard from "./NewApplicationWizard";
import { STEP_HANDOFF } from "./ImportWizard";
import { WorkspaceSkeleton } from "./Skeletons";

// HomeView is the operational start page. It answers, in order, the only three
// questions someone has when they open Configer: can I pick up where I left
// off, does anything need me, and which application do I open. It reads only
// the workspace summary (one request), so it is fast and honest - and it never
// restates the same count in two cards.

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
  const attention = repos
    .flatMap((r) => attentionOf(r).map((it) => ({ r, it })))
    .sort((a, b) => (a.it.severity === "danger" ? -1 : 0) - (b.it.severity === "danger" ? -1 : 0));
  const firstName = meQ.data?.user?.name?.split(" ")[0] || meQ.data?.user?.login;

  // "Continue where you left off": the application with unsent edits (work
  // literally in progress) leads; a draft is the one thing worth resuming
  // without being asked. Nothing in progress means no resume card at all.
  const resume = [...repos].filter((r) => (r.drafts ?? 0) > 0).sort((a, b) => (b.drafts ?? 0) - (a.drafts ?? 0))[0];
  // Attention, minus the resume app's own draft item (the resume card already
  // owns that), so the same work never appears twice.
  const attentionRest = attention.filter((a) => !(resume && a.r.id === resume.id && a.it.key === "drafts"));

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
      <div>
        {/* Greeting only - no estate counters here; the numbers live where
            they are actionable (on each application and its Overview). */}
        <div className="mb-5">
          <div className="text-xl font-semibold text-ink">{greeting(firstName)}</div>
          <div className="mt-0.5 text-[13px] text-ink-2">
            {resume
              ? "Pick up where you left off, or open an application below."
              : attentionRest.length > 0
                ? "A few things need your attention."
                : "Everything is synced and nothing is waiting. Open an application to make a change."}
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
            {/* Continue where you left off: one clear primary action to resume
                an in-progress draft. Shown only when there is one. */}
            {resume && (
              <StaggerItem className="mb-5">
                <div className="flex flex-wrap items-center gap-4 rounded-card border border-brand-border bg-brand-soft px-5 py-4">
                  <EditOutlined style={{ fontSize: 20, color: "var(--brand)" }} />
                  <div className="min-w-40 flex-1">
                    <div className="text-[13px] font-semibold text-ink">
                      Continue in {resume.name}
                    </div>
                    <div className="text-[12px] text-ink-2">
                      {resume.drafts} change{resume.drafts === 1 ? "" : "s"} not yet submitted for review.
                    </div>
                  </div>
                  <Button type="primary" onClick={() => goto(resume.id, "config")}>
                    Continue editing <ArrowRightOutlined />
                  </Button>
                </div>
              </StaggerItem>
            )}

            {/* Anything that needs the user, each with its own next step. A
                clean estate omits the section entirely - no "nothing needs
                you" noise. */}
            {attentionRest.length > 0 && (
              <StaggerItem className="mb-5">
                <SectionCard title="Needs your attention">
                  <div className="flex flex-col gap-2">
                    {attentionRest.slice(0, 5).map(({ r, it }) => (
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

            {!resume && attentionRest.length === 0 && (
              <StaggerItem className="mb-5">
                <div className="flex items-center gap-2.5 rounded-card border border-line bg-surface px-4 py-3">
                  <CheckCircleFilled style={{ color: "var(--c-ok)", fontSize: 16 }} />
                  <span className="text-[13px] text-ink-2">All clear. Everything is synced and nothing is waiting for review.</span>
                </div>
              </StaggerItem>
            )}

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
