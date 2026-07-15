import { Badge, Button, Tabs, theme as antdTheme } from "antd";
import {
  ApartmentOutlined,
  CheckCircleOutlined,
  DashboardOutlined,
  DiffOutlined,
  DownloadOutlined,
  FileTextOutlined,
  HistoryOutlined,
  SyncOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";

// ConfigurationPage is the single home of everything about ONE application:
// a tab strip (Overview, Editor, Compare, Release history, Approvals,
// Instances, Files, Repository changes) over the active view. Tabs map 1:1
// to the store's `section`, so deep links (?view=...) and browser history
// keep working exactly as before — this is chrome, not a router.

/** Sections that live under the Configuration page (vs. workspace level). */
export const APP_SECTIONS = new Set([
  "overview",
  "config",
  "compare",
  "changes",
  "drafts",
  "approvals",
  "instances",
  "files",
  "drift",
  "import",
]);

function tabLabel(icon: React.ReactNode, text: string, count = 0, color?: string) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {icon}
      {text}
      {count > 0 && <Badge count={count} size="small" color={color} />}
    </span>
  );
}

export default function ConfigurationPage({
  section,
  children,
}: {
  section: string;
  children: React.ReactNode;
}) {
  const { setSection } = useUI();
  const { token } = antdTheme.useToken();
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 20_000 });
  const findingsQ = useQuery({ queryKey: ["findings"], queryFn: api.findings, refetchInterval: 30_000, retry: false });
  const awaiting = changesQ.data?.filter((c) => c.state === "under_review").length ?? 0;
  const findings = findingsQ.data?.findings?.length ?? 0;

  // "drafts" is a legacy alias of the Release history view.
  const active = section === "drafts" ? "changes" : section;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: token.colorBgContainer }}>
      <Tabs
        size="small"
        activeKey={active}
        onChange={(key) => setSection(key)}
        tabBarStyle={{ margin: 0, paddingInline: 16 }}
        tabBarExtraContent={{
          right: (
            <Button
              size="small"
              type={active === "import" ? "primary" : "text"}
              ghost={active === "import"}
              icon={<DownloadOutlined />}
              onClick={() => setSection("import")}
            >
              Import settings
            </Button>
          ),
        }}
        items={[
          // Files sits right beside the Editor: both are "look at the
          // configuration" surfaces, one structured, one raw.
          { key: "overview", label: tabLabel(<DashboardOutlined />, "Overview") },
          { key: "config", label: tabLabel(<TableOutlined />, "Editor") },
          { key: "files", label: tabLabel(<FileTextOutlined />, "Files") },
          { key: "compare", label: tabLabel(<DiffOutlined />, "Compare") },
          { key: "changes", label: tabLabel(<HistoryOutlined />, "Release history") },
          { key: "approvals", label: tabLabel(<CheckCircleOutlined />, "Approvals", awaiting, "var(--c-review)") },
          { key: "instances", label: tabLabel(<ApartmentOutlined />, "Instances") },
          { key: "drift", label: tabLabel(<SyncOutlined />, "Repository changes", findings, "orange") },
        ]}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{children}</div>
    </div>
  );
}
