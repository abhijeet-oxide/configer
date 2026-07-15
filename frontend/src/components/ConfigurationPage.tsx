import { Badge, Button, Tabs, theme as antdTheme } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
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

function tabLabel(text: string, count: number, color?: string) {
  if (!count) return text;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {text}
      <Badge count={count} size="small" color={color} />
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
              Import
            </Button>
          ),
        }}
        items={[
          { key: "overview", label: "Overview" },
          { key: "config", label: "Editor" },
          { key: "compare", label: "Compare" },
          { key: "changes", label: "Release history" },
          { key: "approvals", label: tabLabel("Approvals", awaiting) },
          { key: "instances", label: "Instances" },
          { key: "files", label: "Files" },
          { key: "drift", label: tabLabel("Repository changes", findings, "orange") },
        ]}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{children}</div>
    </div>
  );
}
