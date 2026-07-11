import { Menu, Typography, Badge } from "antd";
import type { MenuProps } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Ic, icons } from "./icons";
import { useUI } from "../store";

// The far-left navigation rail, kept to the few things people actually use
// all day: Workspace (all configurations), Editor, Import, Approvals. Less
// frequent tools live under More; admin-ish surfaces (Plugins) are tucked at
// the bottom of More rather than polluting the main flow. Badges sit on the
// icons so the collapsed rail stays clean and readable.

function iconWithBadge(icon: React.ReactNode, count: number, color?: string) {
  if (!count) return <span className="nav-ic">{icon}</span>;
  return (
    <Badge count={count} size="small" color={color} offset={[4, -2]}>
      <span className="nav-ic">{icon}</span>
    </Badge>
  );
}

function buildItems(approvalsCount: number, findingsCount: number): MenuProps["items"] {
  return [
    { key: "workspace", icon: <span className="nav-ic"><Ic icon={icons.workspace} /></span>, label: "Workspace" },
    { key: "config", icon: <span className="nav-ic"><Ic icon={icons.editor} /></span>, label: "Editor" },
    { key: "import", icon: <span className="nav-ic"><Ic icon={icons.import} /></span>, label: "Import" },
    {
      key: "approvals",
      icon: iconWithBadge(<Ic icon={icons.approvals} />, approvalsCount),
      label: "Approvals",
    },
    {
      key: "more",
      icon: iconWithBadge(<Ic icon={icons.settings} />, findingsCount, "orange"),
      label: "More",
      children: [
        { key: "changes", icon: <Ic icon={icons.changes} />, label: "Change Requests" },
        { key: "compare", icon: <Ic icon={icons.compare} />, label: "Compare" },
        { key: "files", icon: <Ic icon={icons.files} />, label: "Rendered Files" },
        {
          key: "drift",
          icon: <Ic icon={icons.drift} />,
          label: (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              Repository Changes
              <Badge count={findingsCount} size="small" color="orange" />
            </span>
          ),
        },
        { type: "divider" },
        { key: "plugins", icon: <Ic icon={icons.plugins} />, label: "Plugins (admin)" },
      ],
    },
  ];
}

export default function NavRail({ collapsed = false }: { collapsed?: boolean }) {
  const { section, setSection } = useUI();
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 20_000 });
  const findingsQ = useQuery({ queryKey: ["findings"], queryFn: api.findings, refetchInterval: 30_000, retry: false });
  const approvalsCount = changesQ.data?.filter((c) => c.state === "under_review").length ?? 0;
  const items = buildItems(approvalsCount, findingsQ.data?.findings?.length ?? 0);
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
