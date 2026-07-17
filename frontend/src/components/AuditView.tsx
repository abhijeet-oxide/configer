import { Table } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api, type AuditEvent } from "../api";
import { useUI } from "../store";
import { relTime } from "./DashboardView";
import { TableSkeleton } from "./Skeletons";
import { SectionCard, EmptyState } from "./ui";
import { EmptyArt } from "./illustrations";
import UserAvatar from "./UserAvatar";

// AuditView is the application's Audit tab: who did what, in plain language,
// newest first. The action reads as a sentence ("Submitted change request #3
// for review"); the underlying API call is kept as a quiet secondary detail
// for anyone who wants the technical truth. Actors show their avatar.

const HTTP = /^(GET|POST|PUT|PATCH|DELETE)\s/;

// Safety net for any legacy row whose action is still a raw "METHOD /path"
// (the backend humanizes new events at the source).
function humanize(e: AuditEvent): { action: string; detail?: string } {
  if (!HTTP.test(e.action)) return { action: e.action, detail: e.detail };
  const [method, rawPath = ""] = e.action.split(/\s+/, 2);
  // Legacy rows stored the full "/api/..." path; drop the routing prefix so we
  // key off the resource, matching the backend humanizer.
  const path = rawPath.replace(/^\/api(\/repos\/[^/]+)?/, "");
  const seg = path.replace(/^\//, "").split("/");
  const head = seg[0] ?? "";
  const arg = seg[1] ?? "";
  const tail = seg[2] ?? "";
  if (head === "values") return { action: "Edited a configuration value", detail: e.action };
  if (head === "files") return { action: "Edited a file in the draft", detail: e.action };
  if (head === "instances")
    return {
      action: method === "POST" ? "Added an instance" : method === "DELETE" ? `Retired instance ${arg}` : `Updated instance ${arg}`,
      detail: e.action,
    };
  if (head === "parameters")
    return {
      action: method === "POST" ? "Added a parameter" : method === "DELETE" ? "Retired a parameter" : "Updated a parameter",
      detail: e.action,
    };
  if (head === "changes") {
    const label: Record<string, string> = {
      submit: `Submitted change request #${arg} for review`,
      merge: `Published change request #${arg}`,
      reject: `Rejected change request #${arg}`,
      comments: `Commented on change request #${arg}`,
      reviewers: `Assigned reviewers on change request #${arg}`,
    };
    return { action: label[tail] ?? "Staged a draft change", detail: e.action };
  }
  if (head === "import") return { action: "Imported settings", detail: e.action };
  if (head === "init") return { action: "Initialized the application", detail: e.action };
  return { action: `${method} ${head || "a resource"}`, detail: e.action };
}

export default function AuditView() {
  const repoId = useUI((s) => s.repoId);
  const auditQ = useQuery({
    queryKey: ["audit", repoId],
    queryFn: () => api.audit({ repo: repoId ?? undefined, limit: 200 }),
  });
  const events = auditQ.data?.events ?? [];

  if (auditQ.isLoading) {
    return (
      <div className="h-full overflow-auto bg-canvas px-6 py-5">
        <TableSkeleton />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-canvas px-6 py-5">
      <div>
        <div className="text-xl font-semibold text-ink">Audit</div>
        <div className="text-[13px] text-ink-2">
          A record of every change made to this application, most recent first.
        </div>
      </div>

      {events.length === 0 ? (
        <SectionCard>
          <EmptyState
            art={<EmptyArt size={104} />}
            title="Nothing recorded yet"
            hint="Editing a value, staging a change or submitting a request all appear here with who did it and when."
          />
        </SectionCard>
      ) : (
        <SectionCard padded={false}>
          <Table<AuditEvent>
            className="cr-table"
            rowKey="id"
            size="small"
            dataSource={events}
            pagination={events.length > 50 ? { pageSize: 50, size: "small" } : false}
            columns={[
              {
                title: "Who",
                width: 200,
                render: (_v, e) => (
                  <span className="inline-flex items-center gap-2">
                    <UserAvatar name={e.login} size={22} />
                    <span className="truncate text-ink">{e.login || "Unknown"}</span>
                  </span>
                ),
              },
              {
                title: "What happened",
                render: (_v, e) => {
                  const h = humanize(e);
                  return (
                    <div>
                      <div className="text-ink">{h.action}</div>
                      {h.detail && <div className="mono text-[11px] text-ink-3">{h.detail}</div>}
                    </div>
                  );
                },
              },
              {
                title: "When",
                width: 160,
                render: (_v, e) => (
                  <span title={new Date(e.at).toLocaleString()}>{relTime(e.at)}</span>
                ),
              },
            ]}
          />
        </SectionCard>
      )}
    </div>
  );
}
