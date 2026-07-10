import { Menu, Typography, Badge } from "antd";
import type { MenuProps } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Ic, icons } from "./icons";
import { useUI } from "../store";

// The far-left navigation rail. Grouped to echo the reference layout
// (Configuration / Observability / Settings). Icons are bundled Phosphor
// glyphs (offline-safe Iconify data imports).
function buildItems(approvalsCount: number, findingsCount: number): MenuProps["items"] {
  return [
    { key: "workspace", icon: <Ic icon={icons.workspace} />, label: "Workspace" },
    { key: "home", icon: <Ic icon={icons.home} />, label: "Home" },
    { type: "group", label: "CONFIGURATION", children: [
      { key: "config", icon: <Ic icon={icons.editor} />, label: "Config Editor" },
      { key: "import", icon: <Ic icon={icons.import} />, label: "Import" },
      { key: "compare", icon: <Ic icon={icons.compare} />, label: "Compare" },
      { key: "files", icon: <Ic icon={icons.files} />, label: "Rendered Files" },
      { key: "changes", icon: <Ic icon={icons.changes} />, label: "Change Requests" },
      {
        key: "approvals",
        icon: <Ic icon={icons.approvals} />,
        label: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            Approvals
            <Badge count={approvalsCount} size="small" />
          </span>
        ),
      },
      { key: "history", icon: <Ic icon={icons.history} />, label: "History" },
      { key: "schemas", icon: <Ic icon={icons.schemas} />, label: "Schemas" },
      { key: "plugins", icon: <Ic icon={icons.plugins} />, label: "Plugins" },
      { key: "deployments", icon: <Ic icon={icons.deployments} />, label: "Deployments" },
    ]},
    { type: "group", label: "OBSERVABILITY", children: [
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
      { key: "audit", icon: <Ic icon={icons.audit} />, label: "Audit Logs" },
    ]},
    { type: "group", label: "SETTINGS", children: [
      { key: "users", icon: <Ic icon={icons.users} />, label: "Users & Teams" },
      { key: "settings", icon: <Ic icon={icons.settings} />, label: "System Settings" },
    ]},
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
      {!collapsed && <GitStatusChip />}
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

// GitStatusChip anchors the rail with the live connection state: a constant,
// calm reminder that the source of truth is Git.
function GitStatusChip() {
  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus, refetchInterval: 30_000 });
  const st = statusQ.data;
  if (!st) return null;
  const ok = !st.syncError;
  return (
    <div
      style={{
        margin: 10,
        padding: "6px 10px",
        borderRadius: 8,
        fontSize: 11,
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: ok ? "rgba(12,163,12,0.09)" : "rgba(250,178,25,0.12)",
        border: `1px solid ${ok ? "rgba(12,163,12,0.25)" : "rgba(250,178,25,0.4)"}`,
      }}
    >
      <span
        style={{
          width: 7, height: 7, borderRadius: 4, flexShrink: 0,
          background: ok ? "#0ca30c" : "#fab219",
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {st.remote ? "Git · " : "Git (local) · "}
        <b>{st.branch}</b>
        {st.remote ? (st.behind > 0 ? ` · ${st.behind} behind` : " · live") : ""}
      </span>
    </div>
  );
}
