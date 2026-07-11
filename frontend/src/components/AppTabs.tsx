import { Menu, Badge } from "antd";
import type { MenuProps } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Ic, icons } from "./icons";
import { useUI } from "../store";

// AppTabs is the in-application navigation: a horizontal tab bar shown below the
// header once an application is open. The global side rail holds only
// application-level and global destinations; everything that belongs TO an
// application (its configuration, instances, changes, compare, history) lives
// here, GitHub-repo-style.

// The sections that are views OF an application (as opposed to the global
// Applications / Approvals / Settings destinations in the side rail).
export const APP_SECTIONS = ["overview", "config", "instances", "changes", "drift", "compare", "history"] as const;
export const isAppSection = (s: string) => (APP_SECTIONS as readonly string[]).includes(s);

export default function AppTabs() {
  const { section, setSection } = useUI();
  const findingsQ = useQuery({ queryKey: ["findings"], queryFn: api.findings, refetchInterval: 30_000, retry: false });
  const findings = findingsQ.data?.findings?.length ?? 0;

  const items: MenuProps["items"] = [
    { key: "overview", icon: <Ic icon={icons.home} />, label: "Overview" },
    { key: "config", icon: <Ic icon={icons.editor} />, label: "Configuration" },
    { key: "instances", icon: <Ic icon={icons.systems} />, label: "Instances" },
    { key: "changes", icon: <Ic icon={icons.changes} />, label: "Change Requests" },
    {
      key: "drift",
      icon: <Ic icon={icons.drift} />,
      label: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Repository Changes
          {findings > 0 && <Badge count={findings} size="small" color="orange" />}
        </span>
      ),
    },
    { key: "compare", icon: <Ic icon={icons.compare} />, label: "Compare" },
    { key: "history", icon: <Ic icon={icons.history} />, label: "History" },
  ];

  return (
    <Menu
      mode="horizontal"
      selectedKeys={[section]}
      onClick={({ key }) => setSection(key)}
      items={items}
      style={{ paddingInline: 12, lineHeight: "40px", minHeight: 40 }}
    />
  );
}
