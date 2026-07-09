import { Breadcrumb, Input, Space, Segmented, Select, Tooltip, Button, Badge, Avatar } from "antd";
import {
  SearchOutlined,
  BulbOutlined,
  BellOutlined,
  QuestionCircleOutlined,
  CloudUploadOutlined,
  CheckCircleTwoTone,
} from "@ant-design/icons";
import { useUI } from "../store";
import { brands, type BrandKey } from "../theme";

// Application header: breadcrumb context, global search, theme + brand
// controls, and the primary "Commit & Push" action.
export default function TopBar({ project }: { project?: string }) {
  const { mode, setMode, brand, setBrand } = useUI();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, width: "100%" }}>
      <Breadcrumb
        items={[
          { title: "Repositories" },
          { title: project || "telco-platform" },
          { title: "overlays" },
          { title: "production" },
          { title: "main" },
        ]}
      />
      <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, opacity: 0.7 }}>
        <CheckCircleTwoTone twoToneColor="#52c41a" /> Auto-saved
      </span>
      <div style={{ flex: 1 }} />
      <Input
        prefix={<SearchOutlined />}
        placeholder="Search parameters (⌘K)"
        size="small"
        style={{ width: 240 }}
      />
      <Space size={6}>
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as "light" | "dark")}
          options={[
            { value: "light", icon: <BulbOutlined /> },
            { value: "dark", icon: <BulbOutlined /> },
          ]}
        />
        <Select
          size="small"
          value={brand}
          onChange={(v) => setBrand(v as BrandKey)}
          style={{ width: 110 }}
          options={Object.entries(brands).map(([k, v]) => ({ value: k, label: v.label }))}
        />
        <Tooltip title="Help"><Button size="small" type="text" icon={<QuestionCircleOutlined />} /></Tooltip>
        <Badge count={3} size="small"><Button size="small" type="text" icon={<BellOutlined />} /></Badge>
        <Button size="small" type="primary" icon={<CloudUploadOutlined />}>Commit &amp; Push</Button>
        <Avatar size={26} style={{ background: "#7c3aed" }}>SS</Avatar>
      </Space>
    </div>
  );
}
