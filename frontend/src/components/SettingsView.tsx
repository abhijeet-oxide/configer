import { Card, Typography, Space } from "antd";
import { RightOutlined } from "@ant-design/icons";
import { Ic, icons } from "./icons";
import { useUI } from "../store";
import PluginsView from "./PluginsView";

// SettingsView is the global admin destination in the side rail: workspace-wide
// settings and admin surfaces that are not tied to a single application. For now
// it hosts the plugin registry and quick links; per-application settings live
// inside the application.
export default function SettingsView() {
  const { setSection } = useUI();
  const links = [
    { key: "import", icon: icons.import, title: "Import parameters", desc: "Scan a connected repository and bring its settings under management." },
    { key: "workspace", icon: icons.workspace, title: "Manage applications", desc: "Connect, open, or disconnect applications in the workspace." },
  ];
  return (
    <div style={{ height: "100%", overflow: "auto", padding: "20px 24px" }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        Settings
      </Typography.Title>
      <Typography.Text type="secondary">Workspace-wide administration.</Typography.Text>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, margin: "16px 0 24px" }}>
        {links.map((l) => (
          <Card
            key={l.key}
            hoverable
            styles={{ body: { padding: 14 } }}
            style={{ width: 320 }}
            onClick={() => setSection(l.key)}
          >
            <Space align="start">
              <span style={{ fontSize: 20, opacity: 0.8 }}><Ic icon={l.icon} size={20} /></span>
              <div>
                <Typography.Text strong>
                  {l.title} <RightOutlined style={{ fontSize: 10, opacity: 0.5 }} />
                </Typography.Text>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{l.desc}</Typography.Text>
                </div>
              </div>
            </Space>
          </Card>
        ))}
      </div>

      <Typography.Title level={5}>Plugins</Typography.Title>
      <PluginsView />
    </div>
  );
}
