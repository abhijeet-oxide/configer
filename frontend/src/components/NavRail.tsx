import { Badge, Tooltip, Typography } from "antd";
import {
  HomeOutlined,
  AppstoreOutlined,
  InboxOutlined,
  FileProtectOutlined,
  DoubleLeftOutlined,
  DoubleRightOutlined,
  UserOutlined,
} from "../icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { envHex } from "../theme";
import { theme as brand } from "../theme.config";
import { useUI } from "../store";
import { useIdentity } from "../identity";

// The navigation rail: the product's one piece of dark chrome, and the ONLY
// organization-scope navigator. It holds just what crosses applications:
// Home, Applications, Inbox (every change and approval that needs someone),
// Audit. Instances and Repositories are not top-level nouns - they live
// inside an application, reached through its tab strip. The rail's foot is
// the person: a profile card (who you are, what you can do) that opens the
// Settings page, where every personal preference lives.

interface RailItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  section?: string;
  needsApp?: boolean;
  badge?: number;
}

// Which rail entry a section lights up. Every workspace-wide change and
// approval surface (changelog, drafts, approvals) resolves to the one Inbox
// entry. Application-scoped sections light up Applications: the rail shows the
// level, the tab strip shows the view. Settings (and the plugins admin surface
// reached from it) light up the profile card instead of a rail entry.
function railKey(section: string): string {
  switch (section) {
    case "home":
      return "home";
    case "changes":
    case "drafts":
    case "changelog":
    case "approvals":
    case "inbox":
      return "inbox";
    case "plugins":
    case "settings":
      return "profile";
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
  const { section, setSection, repoId } = useUI();
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });

  const repos = wsQ.data?.repos ?? [];
  // Inbox badge: only change requests actually awaiting a reviewer (open =
  // under review or approved). Drafts are the author's unsubmitted work - they
  // belong on Home and the app's Changes tab, not the reviewer's Inbox - so
  // counting them here made the badge promise items the Inbox never shows.
  const awaiting = repos.reduce((n, r) => n + (r.openChanges || 0), 0);
  const activeKey = railKey(section);

  const items: RailItem[] = [
    { key: "home", label: "Home", icon: <HomeOutlined />, section: "home" },
    { key: "applications", label: "Applications", icon: <AppstoreOutlined />, section: "workspace" },
    { key: "inbox", label: "Inbox", icon: <InboxOutlined />, section: "inbox", badge: awaiting },
    { key: "audit", label: "Audit", icon: <FileProtectOutlined />, section: "audit", needsApp: true },
  ];

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
        {brand.logo.src ? (
          <img className="logo-tile" src={brand.logo.src} alt={brand.appName} />
        ) : brand.logo.svg ? (
          <span className="logo-tile" dangerouslySetInnerHTML={{ __html: brand.logo.svg }} />
        ) : (
          <div className="logo-tile">{brand.logo.text ?? brand.appName.charAt(0)}</div>
        )}
        {!collapsed && (
          <div style={{ lineHeight: 1.1, minWidth: 0 }}>
            <Typography.Text strong style={{ color: "var(--nav-fg-active)" }}>
              {brand.appName}
            </Typography.Text>
            <div style={{ fontSize: 10, color: "var(--nav-fg)", letterSpacing: 0.4 }}>{brand.navCaption}</div>
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
              if (it.section) setSection(it.section);
            }}
          />
        ))}
      </div>
      <div style={{ padding: "4px 8px 10px", borderTop: "1px solid var(--nav-border)" }}>
        <ProfileCard collapsed={collapsed} active={activeKey === "profile"} />
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
    </div>
  );
}

// ProfileCard grounds the rail in the person using it: who you are and what
// you can do here, one click from every personal preference. On a multi-user
// deployment that is the signed-in account and its role on the active
// application; in single-user mode it is the local operator. Signed out, it
// becomes the sign-in entry - the one place identity starts.
function ProfileCard({ collapsed, active }: { collapsed: boolean; active: boolean }) {
  const setSection = useUI((s) => s.setSection);
  const id = useIdentity();

  if (id.loading) return null;

  if (id.authEnabled && !id.signedIn) {
    const login = () => {
      window.location.href = `/api/auth/login?return_to=${encodeURIComponent(
        window.location.pathname + window.location.search,
      )}`;
    };
    return (
      <RailEntry
        item={{ key: "signin", label: "Sign in", icon: <UserOutlined /> }}
        active={false}
        collapsed={collapsed}
        disabled={false}
        onClick={login}
      />
    );
  }

  const avatar = id.user?.avatarUrl ? (
    <img className="rail-profile-avatar" src={id.user.avatarUrl} alt="" />
  ) : (
    <span className="rail-profile-avatar rail-profile-initials">
      {(id.displayName || "?").slice(0, 2).toUpperCase()}
    </span>
  );

  const inner = (
    <div
      className={`rail-profile${active ? " rail-profile-active" : ""}`}
      role="button"
      aria-label={`${id.displayName} - open settings`}
      onClick={() => setSection("settings")}
      style={{ justifyContent: collapsed ? "center" : "flex-start" }}
    >
      {avatar}
      {!collapsed && (
        <div style={{ minWidth: 0, lineHeight: 1.25 }}>
          <div className="rail-profile-name">{id.displayName}</div>
          {id.roleLabel && <div className="rail-profile-role">{id.roleLabel}</div>}
        </div>
      )}
    </div>
  );
  return (
    <Tooltip
      title={collapsed ? `${id.displayName}${id.roleLabel ? ` · ${id.roleLabel}` : ""}` : "Profile and settings"}
      placement="right"
    >
      {inner}
    </Tooltip>
  );
}

// AuditList shows who did what, newest first, across the workspace.
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
