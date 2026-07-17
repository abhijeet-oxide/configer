import { useState } from "react";
import { Badge, Drawer, List, Popover, Switch, Tooltip, Typography } from "antd";
import {
  HomeOutlined,
  AppstoreOutlined,
  ClusterOutlined,
  PullRequestOutlined,
  DatabaseOutlined,
  CheckCircleOutlined,
  FileProtectOutlined,
  SettingOutlined,
  QuestionCircleOutlined,
  DoubleLeftOutlined,
  DoubleRightOutlined,
} from "../icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { envHex } from "../theme";
import { useUI } from "../store";
import MembersModal from "./MembersModal";

// The navigation rail: the product's one piece of dark chrome. Global items
// (Home, Applications, Approvals) work everywhere; application items
// (Instances, Changes, Repositories, Audit) act on the active application and
// wait quietly until one is selected. Expanded at the global level, it folds
// to an icon rail inside an application so the working surface dominates.

interface RailItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  section?: string;
  needsApp?: boolean;
  badge?: number;
}

// Which rail entry a section lights up. Application tabs without their own
// rail entry (Overview, Editor, Files, Compare, Import) belong to
// Applications: the rail shows the level, the tab strip shows the view.
function railKey(section: string): string {
  switch (section) {
    case "home":
      return "home";
    case "instances":
    case "estate":
      return "instances";
    case "changes":
    case "drafts":
    case "changelog":
      return "changes";
    case "drift":
    case "repos":
      return "repositories";
    case "approvals":
    case "inbox":
      return "approvals";
    case "plugins":
      return "settings";
    default:
      return "applications";
  }
}

function RailEntry({
  item,
  active,
  collapsed,
  disabled,
  onClick,
}: {
  item: RailItem;
  active: boolean;
  collapsed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const inner = (
    <div
      className={`rail-item${active ? " rail-item-active" : ""}${disabled ? " rail-item-disabled" : ""}`}
      onClick={disabled ? undefined : onClick}
      role="button"
      aria-disabled={disabled}
      style={{ justifyContent: collapsed ? "center" : "flex-start" }}
    >
      <Badge count={item.badge ?? 0} size="small" offset={collapsed ? [2, 0] : [4, 0]} color="var(--nav-bg-active)">
        <span className="rail-item-icon">{item.icon}</span>
      </Badge>
      {!collapsed && <span className="rail-item-label">{item.label}</span>}
    </div>
  );
  const tip = disabled ? `${item.label}: select an application first` : collapsed ? item.label : "";
  return tip ? (
    <Tooltip title={tip} placement="right">
      {inner}
    </Tooltip>
  ) : (
    inner
  );
}

export default function NavRail({
  collapsed = false,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { section, setSection, repoId, mode, setMode, fontScale, setFontScale } = useUI();
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const [auditOpen, setAuditOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);

  const repos = wsQ.data?.repos ?? [];
  const awaiting = repos.reduce((n, r) => n + (r.openChanges || 0), 0);
  // Workspace-wide count of change requests in flight (drafts + open) for the
  // global Changes badge.
  const changesInFlight = repos.reduce((n, r) => n + (r.drafts || 0) + (r.openChanges || 0), 0);
  const activeKey = railKey(section);

  const items: RailItem[] = [
    { key: "home", label: "Home", icon: <HomeOutlined />, section: "home" },
    { key: "applications", label: "Applications", icon: <AppstoreOutlined />, section: "workspace" },
    { key: "instances", label: "Instances", icon: <ClusterOutlined />, section: "estate" },
    { key: "changes", label: "Changes", icon: <PullRequestOutlined />, section: "changelog", badge: changesInFlight },
    { key: "repositories", label: "Repositories", icon: <DatabaseOutlined />, section: "repos" },
    { key: "approvals", label: "Approvals", icon: <CheckCircleOutlined />, section: "inbox", badge: awaiting },
    { key: "audit", label: "Audit", icon: <FileProtectOutlined /> },
  ];

  const settingsContent = (
    <div style={{ width: 220 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-3)", marginBottom: 8 }}>
        Appearance
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span>Dark mode</span>
        <Switch size="small" checked={mode === "dark"} onChange={(v) => setMode(v ? "dark" : "light")} />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span>Larger text</span>
        <Switch size="small" checked={fontScale === "large"} onChange={(v) => setFontScale(v ? "large" : "normal")} />
      </div>
      <div style={{ borderTop: "1px solid var(--border)", margin: "8px 0" }} />
      <a onClick={() => setSection("plugins")} style={{ display: "block", padding: "4px 0" }}>
        Plugins (admin)
      </a>
      {repoId && (
        <a onClick={() => setMembersOpen(true)} style={{ display: "block", padding: "4px 0" }}>
          People &amp; roles
        </a>
      )}
    </div>
  );

  const helpContent = (
    <div style={{ width: 250, fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Keyboard shortcuts</div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 10px", color: "var(--text-2)" }}>
        <span className="mono">⌘K</span> <span>Search everything</span>
        <span className="mono">⌘B</span> <span>Toggle parameters panel</span>
        <span className="mono">⌘⌥B</span> <span>Toggle inspector</span>
        <span className="mono">⌘J</span> <span>Toggle systems pane</span>
        <span className="mono">⌘⇧F</span> <span>Focus mode</span>
      </div>
      <div style={{ borderTop: "1px solid var(--border)", margin: "8px 0" }} />
      <span style={{ color: "var(--text-2)" }}>
        Every edit becomes an ordinary Git change: draft, review, merge.
      </span>
    </div>
  );

  return (
    <div className="rail" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: collapsed ? "14px 0 10px" : "14px 16px 10px",
          display: "flex",
          gap: 10,
          alignItems: "center",
          justifyContent: collapsed ? "center" : "flex-start",
        }}
      >
        <div className="logo-tile">C</div>
        {!collapsed && (
          <div style={{ lineHeight: 1.1, minWidth: 0 }}>
            <Typography.Text strong style={{ color: "var(--nav-fg-active)" }}>
              Configer
            </Typography.Text>
            <div style={{ fontSize: 10, color: "var(--nav-fg)", letterSpacing: 0.4 }}>CONFIG LIFECYCLE</div>
          </div>
        )}
      </div>
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "4px 8px" }}>
        {items.map((it) => (
          <RailEntry
            key={it.key}
            item={it}
            active={activeKey === it.key}
            collapsed={collapsed}
            disabled={!!it.needsApp && !repoId}
            onClick={() => {
              if (it.key === "audit") setAuditOpen(true);
              else if (it.section) setSection(it.section);
            }}
          />
        ))}
        <Popover content={settingsContent} placement="rightTop" trigger="click">
          <div>
            <RailEntry
              item={{ key: "settings", label: "Settings", icon: <SettingOutlined /> }}
              active={activeKey === "settings"}
              collapsed={collapsed}
              disabled={false}
              onClick={() => {}}
            />
          </div>
        </Popover>
      </div>
      <div style={{ padding: "4px 8px 10px", borderTop: "1px solid var(--nav-border)" }}>
        <Popover content={helpContent} placement="rightBottom" trigger="click">
          <div>
            <RailEntry
              item={{ key: "help", label: "Help", icon: <QuestionCircleOutlined /> }}
              active={false}
              collapsed={collapsed}
              disabled={false}
              onClick={() => {}}
            />
          </div>
        </Popover>
        <RailEntry
          item={{
            key: "collapse",
            label: "Collapse",
            icon: collapsed ? <DoubleRightOutlined /> : <DoubleLeftOutlined />,
          }}
          active={false}
          collapsed={collapsed}
          disabled={false}
          onClick={() => onToggleCollapse?.()}
        />
        {!collapsed && <DeploymentChip />}
      </div>
      <Drawer title="Audit trail" width={480} open={auditOpen} onClose={() => setAuditOpen(false)}>
        <AuditList open={auditOpen} />
      </Drawer>
      {repoId && <MembersModal open={membersOpen} onClose={() => setMembersOpen(false)} repoId={repoId} />}
    </div>
  );
}

// AuditList shows who did what, newest first, across the workspace.
function AuditList({ open }: { open: boolean }) {
  const repoId = useUI((s) => s.repoId);
  const auditQ = useQuery({
    queryKey: ["audit", repoId],
    queryFn: () => api.audit({ repo: repoId ?? undefined, limit: 100 }),
    enabled: open,
  });
  const events = auditQ.data?.events ?? [];
  if (!auditQ.isLoading && events.length === 0)
    return (
      <Typography.Text type="secondary">
        No audit events recorded yet. State-changing actions appear here with who did them and when.
      </Typography.Text>
    );
  return (
    <List
      size="small"
      loading={auditQ.isLoading}
      dataSource={events}
      renderItem={(e) => (
        <List.Item style={{ display: "block" }}>
          <div style={{ fontSize: 13 }}>
            <b>{e.login || "anonymous"}</b> {e.action}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            {e.detail} · {new Date(e.at).toLocaleString()}
          </div>
        </List.Item>
      )}
    />
  );
}

// DeploymentChip identifies this installation (version + environment) so
// support conversations and screenshots are unambiguous.
function DeploymentChip() {
  const metaQ = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: 300_000 });
  const m = metaQ.data;
  if (!m) return null;
  return (
    <div
      style={{
        margin: "8px 8px 0",
        fontSize: 10.5,
        color: "var(--nav-fg)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        overflow: "hidden",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: envHex(m.environment) }}
      />
      {m.name} {m.version} · {m.environment}
    </div>
  );
}
