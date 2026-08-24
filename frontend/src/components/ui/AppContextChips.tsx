import { useQuery } from "@tanstack/react-query";
import { useRepoQuery } from "../../repoQuery";
import { Tooltip } from "antd";
import { BranchesOutlined, ClusterOutlined, EyeOutlined } from "../../icons";
import { api } from "../../api";
import { useIdentity } from "../../identity";
import { useUI } from "../../store";
import { StatusPill, type PillTone } from "../../uikit";

// AppContextChips is the persistent application context from the reference:
// branch (monospace), live git synchronization state, instance count, and a
// pending-edits pill when a draft exists. Shared by the top context bar and
// the Application Overview header so the story reads the same everywhere.

function syncPill(st: {
  remote?: string;
  behind: number;
  syncError?: string;
  upstreamGone?: boolean;
}): { tone: PillTone; label: string; title: string } {
  if (st.upstreamGone)
    return {
      tone: "danger",
      label: "Branch removed",
      title: "The branch no longer exists on the remote. Your local work is safe.",
    };
  if (st.syncError)
    return { tone: "pending", label: "Sync issue", title: `Synchronization problem: ${st.syncError}` };
  if (!st.remote) return { tone: "neutral", label: "Local", title: "Local repository (no remote configured)" };
  if (st.behind > 0)
    return {
      tone: "pending",
      label: `${st.behind} behind`,
      title: `${st.behind} commit(s) on the remote are not in this workspace yet.`,
    };
  return { tone: "ok", label: "Git synced", title: "Synchronized with the Git remote." };
}

export function MonoChip({ icon, children, title }: { icon?: React.ReactNode; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="mono inline-flex h-[22px] items-center gap-1 rounded-full border border-line bg-surface-2 px-2 leading-none whitespace-nowrap text-ink-2"
      style={{ fontSize: "var(--fs-11)" }}
    >
      {icon}
      {children}
    </span>
  );
}

export default function AppContextChips({ showDraft = true }: { showDraft?: boolean }) {
  const repoId = useUI((s) => s.repoId);
  const setSection = useUI((s) => s.setSection);
  const statusQ = useRepoQuery({
    queryKey: ["repo-status"],
    queryFn: api.repoStatus,
    refetchInterval: 30_000,
    enabled: !!repoId,
  });
  const draftQ = useRepoQuery({ queryKey: ["draft"], queryFn: api.draft, enabled: !!repoId && showDraft });
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });

  // Access is part of the application context, like the branch: someone with
  // view access sees no edit affordances anywhere, and this is the one place
  // that says why - once, quietly, rather than a banner on every screen.
  const { canEdit, authEnabled, loading } = useIdentity();
  // Say WHY, in the same breath. "Viewer" on its own is a question, not an
  // answer, and the answer is usually "because that is your access to this
  // repository in GitHub" - which tells the user exactly where to fix it.
  const roleQ = useQuery({
    queryKey: ["my-role", repoId],
    queryFn: () => api.myRole(repoId!),
    enabled: !!repoId && authEnabled,
    staleTime: 60_000,
  });
  const whyViewOnly =
    (roleQ.data?.detail ? `You can read this application; ${roleQ.data.detail}. ` : "") +
    "Changing a value, submitting for review or publishing needs edit access.";
  const st = statusQ.data;
  const repo = wsQ.data?.repos.find((r) => r.id === repoId);
  const pending = draftQ.data?.draft?.items?.length ?? 0;
  if (!repoId) return null;

  // Object-importance hierarchy: context (branch, instance count) is quiet
  // text; only state (git sync) and the one actionable item (pending changes)
  // earn a pill.
  return (
    <span className="inline-flex min-w-0 items-center gap-3">
      {st?.branch && (
        <span
          className="mono inline-flex items-center gap-1 whitespace-nowrap text-ink-3"
          title={`Branch ${st.branch}`}
          style={{ fontSize: "var(--fs-11)" }}
        >
          <BranchesOutlined style={{ fontSize: 11 }} />
          {st.branch}
        </span>
      )}
      {st && !st.remote ? null : st ? (
        <Tooltip title={syncPill(st).title}>
          <span style={{ display: "inline-flex" }}>
            <StatusPill tone={syncPill(st).tone}>{syncPill(st).label}</StatusPill>
          </span>
        </Tooltip>
      ) : null}
      {repo && (
        <span
          className="inline-flex items-center gap-1 whitespace-nowrap text-ink-3"
          title="Instances in this application"
          style={{ fontSize: "var(--fs-11)" }}
        >
          <ClusterOutlined style={{ fontSize: 11 }} />
          {repo.instances} instance{repo.instances === 1 ? "" : "s"}
        </span>
      )}
      {authEnabled && !loading && !canEdit && (
        <Tooltip title={whyViewOnly}>
          <span style={{ display: "inline-flex" }}>
            <StatusPill tone="neutral" icon={<EyeOutlined style={{ fontSize: 11 }} />}>
              View only
            </StatusPill>
          </span>
        </Tooltip>
      )}
      {showDraft && pending > 0 && (
        <span onClick={() => setSection("config")} style={{ cursor: "pointer", display: "inline-flex" }}>
          <StatusPill tone="pending" title="Changes not yet submitted for review">
            {pending} change{pending === 1 ? "" : "s"}
          </StatusPill>
        </span>
      )}
    </span>
  );
}
