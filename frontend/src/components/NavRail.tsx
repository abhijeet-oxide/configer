import { Menu, Typography } from "antd";
import {
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
import { useUI } from "../store";

// The far-left navigation rail. Grouped to echo the reference layout
// (Configuration / Observability / Settings).
const items: MenuProps["items"] = [
  { type: "group", label: "CONFIGURATION", children: [
    { key: "config", icon: <TableOutlined />, label: "Config Editor" },
    { key: "compare", icon: <DiffOutlined />, label: "Compare" },
    { key: "changes", icon: <PullRequestOutlined />, label: "Change Requests" },
    { key: "history", icon: <FileTextOutlined />, label: "History" },
    { key: "approvals", icon: <CheckCircleOutlined />, label: "Approvals" },
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

export default function NavRail() {
  const { section, setSection } = useUI();
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 16px 8px", display: "flex", gap: 10, alignItems: "center" }}>
        <div
          style={{
            width: 28, height: 28, borderRadius: 7, background: "var(--ant-color-primary,#2f6bff)",
            color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 700,
          }}
        >
          C
        </div>
        <div style={{ lineHeight: 1.1 }}>
          <Typography.Text strong>Configer</Typography.Text>
          <div style={{ fontSize: 10, opacity: 0.6 }}>CONFIG LIFECYCLE MGMT</div>
        </div>
      </div>
      <Menu
        className="nav-rail"
        mode="inline"
        selectedKeys={[section]}
        onClick={({ key }) => setSection(key)}
        items={items}
        style={{ borderInlineEnd: "none", flex: 1, overflow: "auto" }}
      />
    </div>
  );
}
