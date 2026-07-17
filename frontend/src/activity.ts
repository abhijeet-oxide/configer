import { useQuery } from "@tanstack/react-query";
import { api, type ChangeRequest } from "./api";
import { useUI } from "./store";

// A composed, honest activity feed for the active application. There is no
// single backend feed, so this merges the sources that carry timestamps:
// change-request lifecycle events, repository commits (when the backend
// supports history) and audit events. Repository drift findings carry no
// timestamp, so they are deliberately NOT mixed in here; they surface in the
// attention cards instead.

export interface ActivityItem {
  at: string;
  kind: "change" | "commit" | "audit";
  actor?: string;
  text: string;
  /** where clicking should go (a section within the app) */
  section?: string;
  crId?: number;
}

const CR_EVENT: Record<string, string> = {
  draft: "started a draft",
  under_review: "submitted for review",
  approved: "approved",
  published: "published",
  rejected: "rejected",
};

export function crEvents(crs: ChangeRequest[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const cr of crs) {
    out.push({
      at: cr.createdAt,
      kind: "change",
      actor: cr.author,
      text: `created a draft change request`,
      section: "changes",
      crId: cr.id,
    });
    if (cr.state !== "draft" && cr.updatedAt !== cr.createdAt) {
      out.push({
        at: cr.updatedAt,
        kind: "change",
        actor: cr.author,
        text: `${CR_EVENT[cr.state]}: ${cr.title}`,
        section: cr.state === "under_review" ? "approvals" : "changes",
        crId: cr.id,
      });
    }
  }
  return out;
}

export function useActivity(limit = 8): { items: ActivityItem[]; loading: boolean } {
  const repoId = useUI((s) => s.repoId);
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 20_000 });
  const historyQ = useQuery({ queryKey: ["history"], queryFn: () => api.history(20), staleTime: 30_000 });
  const auditQ = useQuery({
    queryKey: ["audit", repoId],
    queryFn: () => api.audit({ repo: repoId ?? undefined, limit: 30 }),
    staleTime: 30_000,
  });

  const items: ActivityItem[] = [
    ...crEvents(changesQ.data ?? []),
    ...(historyQ.data?.supported
      ? (historyQ.data.commits ?? []).map((c) => ({
          at: c.date,
          kind: "commit" as const,
          actor: c.author,
          text: c.message.split("\n")[0],
          section: "changes",
        }))
      : []),
    ...(auditQ.data?.events ?? []).map((e) => ({
      at: e.at,
      kind: "audit" as const,
      actor: e.login || "anonymous",
      text: e.action.replace(/^[A-Z]+ /, (m) => m.toLowerCase()),
      section: undefined,
    })),
  ]
    .filter((i) => i.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, limit);

  return { items, loading: changesQ.isLoading };
}
