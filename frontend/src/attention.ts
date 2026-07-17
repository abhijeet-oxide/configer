import type { RepoSummary } from "./api";
import type { AttentionSeverity } from "./components/ui";

// What (if anything) about an application needs a human right now, in plain
// words, with the action that resolves it. Consumed by Home, the
// Applications rail and the Application Overview.

export interface AttentionItem {
  key: string;
  severity: AttentionSeverity;
  text: string;
  /** the button label that resolves it ("Review changes") */
  actionLabel: string;
  /** the section the action routes to (within the app) */
  section: string;
}

export function attentionOf(r: RepoSummary): AttentionItem[] {
  const out: AttentionItem[] = [];
  if (r.error)
    out.push({
      key: "error",
      severity: "danger",
      text: "Unavailable: " + r.error,
      actionLabel: "View details",
      section: "overview",
    });
  if (r.syncError)
    out.push({
      key: "sync",
      severity: "warn",
      text: "Git synchronization issue",
      actionLabel: "View details",
      section: "overview",
    });
  if ((r.behind ?? 0) > 0)
    out.push({
      key: "behind",
      severity: "warn",
      text: `${r.behind} repository change${r.behind === 1 ? "" : "s"} on Git`,
      actionLabel: "Review changes",
      section: "drift",
    });
  if (r.needsSetup)
    out.push({
      key: "setup",
      severity: "warn",
      text: "Setup incomplete",
      actionLabel: "Finish setup",
      section: "overview",
    });
  if (r.openChanges > 0)
    out.push({
      key: "review",
      severity: "info",
      text: `${r.openChanges} change request${r.openChanges === 1 ? "" : "s"} waiting for approval`,
      actionLabel: "Review",
      section: "approvals",
    });
  if (r.drafts > 0)
    out.push({
      key: "drafts",
      severity: "warn",
      text: "Unsubmitted local edits",
      actionLabel: "Review edits",
      section: "config",
    });
  return out;
}
