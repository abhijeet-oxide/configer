import { Menu, Typography, Badge } from "antd";
import type { MenuProps } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Ic, icons } from "./icons";
import { useUI } from "../store";

// The far-left navigation rail. It is application-centric: Workspace is the
// portfolio of applications, and everything below it is a view OF the active
// application (nouns, not modules), grouped so the primary views sit up top
// and the less-frequent or admin surfaces sit under "More". Badges sit on the
// icons so the collapsed rail stays clean and readable.

// SECTION_LABELS is the single source of truth for view names, shared with the
// TopBar breadcrumb and the placeholder screens so a view is named once.
export const SECTION_LABELS: Record<string, string> = {
  workspace: "Workspace",
  overview: "Overview",
  config: "Configuration",
  files: "Rendered Files",
  changes: "Change Requests",
  approvals: "Approvals",
  drift: "Repository Changes",
  compare: "Compare",
  deployments: "Deployments",
  validation: "Validation",
  history: "History",
  repositories: "Repositories",
  import: "Import",
  plugins: "Plugins",
  settings: "Settings",
};

function iconWithBadge(icon: React.ReactNode, count: number, color?: string) {
  if (!count) return <span className="nav-ic">{icon}</span>;
  return (
    <Badge count={count} size="small" color={color} offset={[4, -2]}>
      <span className="nav-ic">{icon}</span>
    </Badge>
  );
}

function ic(icon: (typeof icons)[keyof typeof icons]) {
  return <span className="nav-ic"><Ic icon={icon} /></span>;
}

function buildItems(appName: string | undefined, approvalsCount: number, findingsCount: number): MenuProps["items"] {
  return [
    { key: "workspace", icon: ic(icons.workspace), label: "Workspace" },
    {
      type: "group",
      // The group header names the application being worked on, so the rail
      // reads "these views belong to <app>", reinforcing the mental model.
      label: appName ?? "Application",
      children: [
        { key: "overview", icon: ic(icons.home), label: "Overview" },
        { key: "config", icon: ic(icons.editor), label: "Configuration" },
        { key: "files", icon: ic(icons.files), label: "Rendered Files" },
        { key: "changes", icon: ic(icons.changes), label: "Change Requests" },
        { key: "approvals", icon: iconWithBadge(<Ic icon={icons.approvals} />, approvalsCount), label: "Approvals" },
        {
          key: "drift",
          icon: iconWithBadge(<Ic icon={icons.drift} />, findingsCount, "orange"),
          label: "Repository Changes",
        },
        { key: "compare", icon: ic(icons.compare), label: "Compare" },
      ],
    },
    {
      type: "group",
      label: "More",
      children: [
        { key: "deployments", icon: ic(icons.deployments), label: "Deployments" },
        { key: "validation", icon: ic(icons.schemas), label: "Validation" },
        { key: "history", icon: ic(icons.history), label: "History" },
        { key: "repositories", icon: ic(icons.systems), label: "Repositories" },
        { key: "import", icon: ic(icons.import), label: "Import" },
        { key: "plugins", icon: ic(icons.plugins), label: "Plugins (admin)" },
        { key: "settings", icon: ic(icons.settings), label: "Settings" },
      ],
    },
  ];
}

export default function NavRail({ collapsed = false }: { collapsed?: boolean }) {
  const { section, setSection, repoId } = useUI();
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 20_000 });
  const findingsQ = useQuery({ queryKey: ["findings"], queryFn: api.findings, refetchInterval: 30_000, retry: false });
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const appName = wsQ.data?.repos?.find((r) => r.id === repoId)?.name;
  const approvalsCount = changesQ.data?.filter((c) => c.state === "under_review").length ?? 0;
  const items = buildItems(appName, approvalsCount, findingsQ.data?.findings?.length ?? 0);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: collapsed ? "14px 0 8px" : "14px 16px 8px",
          display: "flex",
          gap: 10,
          alignItems: "center",
          justifyContent: collapsed ? "center" : "flex-start",
        }}
      >
        <div className="logo-tile">C</div>
        {!collapsed && (
          <div style={{ lineHeight: 1.1 }}>
            <Typography.Text strong>Configer</Typography.Text>
            <div style={{ fontSize: 10, opacity: 0.6 }}>CONFIG LIFECYCLE MGMT</div>
          </div>
        )}
      </div>
      <Menu
        className="nav-rail"
        mode="inline"
        inlineCollapsed={collapsed}
        selectedKeys={[section]}
        onClick={({ key }) => setSection(key)}
        items={items}
        style={{ borderInlineEnd: "none", flex: 1, overflow: "auto" }}
      />
      {!collapsed && <DeploymentChip />}
    </div>
  );
}

// DeploymentChip identifies this installation (version + environment) so
// support conversations and screenshots are unambiguous.
function DeploymentChip() {
  const metaQ = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: 300_000 });
  const m = metaQ.data;
  if (!m) return null;
  const envColor: Record<string, string> = { production: "#f5222d", staging: "#fa8c16" };
  return (
    <div style={{ margin: "0 10px 10px", fontSize: 10.5, opacity: 0.75, display: "flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 6, height: 6, borderRadius: 3, flexShrink: 0,
          background: envColor[m.environment] ?? "#52c41a",
        }}
      />
      {m.name} {m.version} · {m.environment}
    </div>
  );
}
