import { Menu, Typography, Badge } from "antd";
import type { MenuProps } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { envHex } from "../theme";
import { Ic, icons } from "./icons";
import { useUI } from "../store";

// The far-left navigation rail, kept to the two levels of the hierarchy:
// Applications (the portfolio) and Configuration (everything about the
// selected application - its views live as tabs on the Configuration page).
// Admin-ish surfaces (Plugins) sit at the bottom. Badges sit on the icons so
// the collapsed rail stays clean and readable.

function iconWithBadge(icon: React.ReactNode, count: number, color?: string) {
  if (!count) return <span className="nav-ic">{icon}</span>;
  return (
    <Badge count={count} size="small" color={color} offset={[4, -2]}>
      <span className="nav-ic">{icon}</span>
    </Badge>
  );
}

function buildItems(attentionCount: number): MenuProps["items"] {
  return [
    { key: "workspace", icon: <span className="nav-ic"><Ic icon={icons.workspace} /></span>, label: "Applications" },
    {
      key: "overview",
      // Counts are "work waiting", not errors: blue, never red.
      icon: iconWithBadge(<Ic icon={icons.editor} />, attentionCount, "var(--c-review)"),
      label: "Configuration",
    },
    { key: "plugins", icon: <span className="nav-ic"><Ic icon={icons.plugins} /></span>, label: "Plugins (admin)" },
  ];
}

// Every application-scoped section highlights the Configuration entry; the
// rail reflects the level, the tabs on the page reflect the view.
function railKey(section: string): string {
  if (section === "workspace" || section === "home") return "workspace";
  if (section === "plugins") return "plugins";
  return "overview";
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
  return (
    <div style={{ margin: "0 10px 10px", fontSize: 10.5, opacity: 0.75, display: "flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 6, height: 6, borderRadius: 3, flexShrink: 0,
          background: envHex(m.environment),
        }}
      />
      {m.name} {m.version} · {m.environment}
    </div>
  );
}
