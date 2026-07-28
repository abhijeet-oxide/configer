import { Select, Table } from "antd";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type AuditEvent, ApiError } from "../api";
import { useUI } from "../store";
import { relTime } from "./DashboardView";
import { fmtDateTime } from "../timefmt";
import { TableSkeleton } from "./Skeletons";
import { SectionCard, EmptyState, PageHeader } from "./ui";
import { EmptyArt, AccessDeniedArt} from "./illustrations";
import UserAvatar from "./UserAvatar";

// AuditView is the workspace's audit trail: who did what, in plain language,
// newest first, across every application. The action reads as a sentence
// ("Submitted change request #3 for review"); the underlying API call is kept
// as a quiet secondary detail for anyone who wants the technical truth. Actors
// show their avatar.

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

// The trail belongs to the workspace, not to one application: it answers "who
// did what here", across everything. So it opens on every application at once
// and narrows only when the reader asks it to - a filter, not a context the
// page silently inherits.
const ALL_APPS = "__all__";

export default function AuditView() {
  const setSection = useUI((s) => s.setSection);
  const [scope, setScope] = useState<string>(ALL_APPS);
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const repos = wsQ.data?.repos ?? [];
  const auditQ = useQuery({
    queryKey: ["audit", scope],
    queryFn: () => api.audit({ repo: scope === ALL_APPS ? undefined : scope, limit: 200 }),
  });
  const events = auditQ.data?.events ?? [];
  const nameOf = (id?: string) => repos.find((r) => r.id === id)?.name ?? id ?? "";

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-canvas view-pad">
      <PageHeader
        title="Audit"
        description="Who did what across every application, most recent first."
        actions={
          <Select
            value={scope}
            onChange={setScope}
            style={{ minWidth: 200 }}
            options={[
              { value: ALL_APPS, label: "All applications" },
              ...repos.map((r) => ({ value: r.id, label: r.name })),
            ]}
          />
        }
      />

      {auditQ.error instanceof ApiError && auditQ.error.isForbidden ? (
        // Not a failure: the trail names who did what across the whole
        // deployment, so only an administrator may read it. Say that plainly
        // instead of an empty table or a red toast per refresh.
        <SectionCard>
          <EmptyState
            art={<AccessDeniedArt size={120} />}
            title="The audit trail is for administrators"
            hint="It records who did what across every application, so only an administrator of this deployment can read it. Ask one if you need an action traced."
          />
        </SectionCard>
      ) : auditQ.isLoading ? (
        <TableSkeleton />
      ) : events.length === 0 ? (
        <SectionCard>
          <EmptyState
            art={<EmptyArt size={104} />}
            title="Nothing recorded yet"
            hint="Editing a value, staging a change or submitting a request all appear here with who did it and when."
            actionLabel={repos.length === 0 ? "New application" : undefined}
            onAction={repos.length === 0 ? () => setSection("workspace") : undefined}
          />
        </SectionCard>
      ) : (
        <SectionCard padded={false}>
          <Table<AuditEvent>
            className="cr-table"
            rowKey="id"
            size="small"
            dataSource={events}
            scroll={{ x: "max-content" }}
            pagination={events.length > 50 ? { pageSize: 50, size: "small" } : false}
            columns={[
              {
                title: "Who",
                width: 190,
                render: (_v, e) => (
                  <span className="inline-flex items-center gap-2">
                    <UserAvatar name={e.login} size={22} />
                    <span className="truncate text-ink">{e.login || "Unknown"}</span>
                  </span>
                ),
              },
              // Only meaningful while looking across applications; filtered to
              // one, the column would repeat the same name down the page.
              ...(scope === ALL_APPS
                ? [
                    {
                      title: "Application",
                      width: 170,
                      render: (_v: unknown, e: AuditEvent) => (
                        <span className="truncate text-ink-2">{nameOf(e.repo) || "-"}</span>
                      ),
                    },
                  ]
                : []),
              {
                title: "What happened",
                render: (_v, e) => {
                  const h = humanize(e);
                  return (
                    <div>
                      <div className="text-ink">{h.action}</div>
                      {h.detail && !HTTP.test(h.detail) && (
                        <div className="mono text-[11px] text-ink-3">{h.detail}</div>
                      )}
                    </div>
                  );
                },
              },
              {
                title: "When",
                width: 150,
                render: (_v, e) => (
                  <span title={fmtDateTime(e.at)}>{relTime(e.at)}</span>
                ),
              },
            ]}
          />
        </SectionCard>
      )}
    </div>
  );
}
