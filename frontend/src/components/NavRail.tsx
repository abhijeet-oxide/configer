import { Menu, Typography, Badge } from "antd";
import type { MenuProps } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Ic, icons } from "./icons";
import { useUI } from "../store";

// The far-left navigation rail is deliberately thin: it holds only
// application-level and global destinations, GitHub-style. Everything that
// belongs to a single application (its configuration, instances, changes,
// compare, history) lives in the in-application tab bar (AppTabs), not here, so
// the rail never scrolls or repeats per-app views. Approvals is global so a
// reviewer can clear change requests across every application in one place.

// SECTION_LABELS is the single source of truth for view names, shared with the
// TopBar breadcrumb, AppTabs, and the placeholder screens so a view is named
// once.
export const SECTION_LABELS: Record<string, string> = {
  workspace: "Applications",
  overview: "Overview",
  config: "Configuration",
  changes: "Change Requests",
  approvals: "Approvals",
  drift: "Repository Changes",
  compare: "Compare",
  instances: "Instances",
  history: "History",
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

function buildItems(approvalsCount: number): MenuProps["items"] {
  return [
    { key: "workspace", icon: ic(icons.workspace), label: "Applications" },
    { key: "approvals", icon: iconWithBadge(<Ic icon={icons.approvals} />, approvalsCount), label: "Approvals" },
    { key: "settings", icon: ic(icons.settings), label: "Settings" },
  ];
}

// The global side rail highlights an application-level destination. When the
// user is inside an application view (a tab), the rail keeps Applications lit as
// the current context.
function railKey(section: string): string {
  if (section === "approvals" || section === "settings" || section === "plugins" || section === "import") return section === "plugins" ? "settings" : section;
  return "workspace";
}

export default function NavRail({ collapsed = false }: { collapsed?: boolean }) {
  const { section, setSection } = useUI();
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 20_000 });
  const approvalsCount = changesQ.data?.filter((c) => c.state === "under_review").length ?? 0;
  const items = buildItems(approvalsCount);
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
        selectedKeys={[railKey(section)]}
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
