import { Breadcrumb, Input, Space, Tooltip, Button, Badge, Avatar, Dropdown, type InputRef } from "antd";
import {
  SearchOutlined,
  MoonOutlined,
  SunOutlined,
  BellOutlined,
  QuestionCircleOutlined,
  CloudUploadOutlined,
  CheckCircleTwoTone,
  BgColorsOutlined,
} from "@ant-design/icons";
import { useEffect, useRef } from "react";
import { useUI } from "../store";
import { brands, type BrandKey } from "../theme";

// Application header: breadcrumb context, the global parameter search
// (matches name, description, category, file, path and values — focus with
// ⌘K / Ctrl+K), theme + brand controls, and the primary commit action.
export default function TopBar({ project }: { project?: string }) {
  const { mode, setMode, brand, setBrand, search, setSearch } = useUI();
  const searchRef = useRef<InputRef>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, width: "100%" }}>
      <Breadcrumb
        items={[
          { title: "Repositories" },
          { title: <b>{project || "…"}</b> },
          { title: "main" },
        ]}
      />
      <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, opacity: 0.7, whiteSpace: "nowrap" }}>
        <CheckCircleTwoTone twoToneColor="#52c41a" /> Auto-saved
      </span>
      <div style={{ flex: 1 }} />
      <Input
        ref={searchRef}
        prefix={<SearchOutlined />}
        placeholder="Search everything… (⌘K)"
        size="small"
        allowClear
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: "clamp(180px, 24vw, 380px)" }}
      />
      <Space size={6}>
        <Tooltip title={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}>
          <Button
            size="small"
            type="text"
            icon={mode === "light" ? <MoonOutlined /> : <SunOutlined />}
            onClick={() => setMode(mode === "light" ? "dark" : "light")}
          />
        </Tooltip>
        <Dropdown
          menu={{
            selectedKeys: [brand],
            items: Object.entries(brands).map(([k, v]) => ({
              key: k,
              label: (
                <Space>
                  <span style={{ width: 10, height: 10, borderRadius: 5, background: v.colorPrimary, display: "inline-block" }} />
                  {v.label}
                </Space>
              ),
            })),
            onClick: ({ key }) => setBrand(key as BrandKey),
          }}
        >
          <Button size="small" type="text" icon={<BgColorsOutlined />} />
        </Dropdown>
        <Tooltip title="Help"><Button size="small" type="text" icon={<QuestionCircleOutlined />} /></Tooltip>
        <Badge count={3} size="small"><Button size="small" type="text" icon={<BellOutlined />} /></Badge>
        <Button size="small" type="primary" icon={<CloudUploadOutlined />}>Commit &amp; Push</Button>
        <Avatar size={26} style={{ background: "#7c3aed", flexShrink: 0 }}>SS</Avatar>
      </Space>
    </div>
  );
}
