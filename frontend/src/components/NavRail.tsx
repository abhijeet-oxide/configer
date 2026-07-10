import { Menu, Typography, Badge } from "antd";
import {
  HomeOutlined,
  TableOutlined,
  DiffOutlined,
  PullRequestOutlined,
  FileTextOutlined,
  CheckCircleOutlined,
  SafetyCertificateOutlined,
  RocketOutlined,
  ApiOutlined,
  AlertOutlined,
  AuditOutlined,
  TeamOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";

// The far-left navigation rail. Grouped to echo the reference layout
// (Configuration / Observability / Settings).
function buildItems(approvalsCount: number): MenuProps["items"] {
  return [
    { key: "home", icon: <HomeOutlined />, label: "Home" },
    { type: "group", label: "CONFIGURATION", children: [
      { key: "config", icon: <TableOutlined />, label: "Config Editor" },
      { key: "compare", icon: <DiffOutlined />, label: "Compare" },
      { key: "changes", icon: <PullRequestOutlined />, label: "Change Requests" },
      {
        key: "approvals",
        icon: <CheckCircleOutlined />,
        label: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            Approvals
            <Badge count={approvalsCount} size="small" />
          </span>
        ),
      },
      { key: "history", icon: <FileTextOutlined />, label: "History" },
      { key: "schemas", icon: <SafetyCertificateOutlined />, label: "Schemas" },
      { key: "plugins", icon: <ApiOutlined />, label: "Plugins" },
      { key: "deployments", icon: <RocketOutlined />, label: "Deployments" },
    ]},
    { type: "group", label: "OBSERVABILITY", children: [
      { key: "drift", icon: <AlertOutlined />, label: "Drift Detection" },
      { key: "audit", icon: <AuditOutlined />, label: "Audit Logs" },
    ]},
    { type: "group", label: "SETTINGS", children: [
      { key: "users", icon: <TeamOutlined />, label: "Users & Teams" },
      { key: "settings", icon: <SettingOutlined />, label: "System Settings" },
    ]},
  ];
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
        selectedKeys={[section]}
        onClick={({ key }) => setSection(key)}
        items={items}
        style={{ borderInlineEnd: "none", flex: 1, overflow: "auto" }}
      />
      {!collapsed && <GitStatusChip />}
    </div>
  );
}

// GitStatusChip anchors the rail with the live connection state — a constant,
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
