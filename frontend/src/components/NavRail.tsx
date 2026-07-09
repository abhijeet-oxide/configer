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
        <div
          style={{
            width: 28, height: 28, borderRadius: 7, background: "var(--ant-color-primary,#2f6bff)",
            color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 700, flexShrink: 0,
          }}
        >
          C
        </div>
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
    </div>
  );
}
