import {
  Breadcrumb,
  Space,
  Button,
  Dropdown,
  Typography,
} from "antd";
import { SearchOutlined, ExportOutlined, GithubOutlined, SettingOutlined, TeamOutlined, LogoutOutlined, MoonOutlined } from "../icons";
import { ThemeToggleButton, useTheme } from "../uikit";
import { AccountMenu } from "./accountmenu";
import { useIdentity } from "../identity";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { api, type Instance } from "../api";
import { useUI } from "../store";
import { useSignOut } from "../useSignOut";
import { loginHref } from "./SignInView";
import NotificationsPanel from "./NotificationsPanel";
import { useSearchOpen } from "../search";
import { useSwitchRepo } from "../useSwitchRepo";
import { modLabel } from "../platform";
import { AppContextChips, Kbd } from "./ui";
import { TopBar as Bar } from "../uikit";
import MembersModal from "./MembersModal";

// The application context bar: breadcrumb with the app switcher, then the
// persistent context chips (branch, git sync state, instances, unsent edits)
// so the user always knows where they are and whether anything is pending.
// Appearance and every other personal preference live on the Settings page
// (the account menu at the right); this bar keeps only the quick theme toggle.

// The application-scoped sections and their human tab labels, for the
// breadcrumb (Home / Applications / <name> / <tab>).
const APP_BREADCRUMB_SECTIONS = new Set([
  "overview", "config", "compare", "changes", "drafts", "approvals", "instances", "files", "drift", "import", "sources", "timeline",
]);
const TAB_LABELS: Record<string, string> = {
  overview: "Overview",
  config: "Parameters",
  files: "Files",
  compare: "Compare",
  changes: "Changes",
  drafts: "Changes",
  approvals: "Approvals",
  instances: "Instances",
  drift: "Repository changes",
  sources: "Sources",
  timeline: "Timeline",
  import: "Import settings",
};

// The workspace-level sections and the name each one goes by. Every one of them
// sits directly under Home, so the trail always starts somewhere clickable and
// the user is never left looking at a single dead word.
const GLOBAL_LABELS: Record<string, string> = {
  workspace: "Applications",
  inbox: "Inbox",
  estate: "Instances",
  changelog: "Changes",
  audit: "Audit",
  repos: "Repositories",
  settings: "Settings",
  plugins: "Plugins",
};

function ellipsis(maxWidth: number): React.CSSProperties {
  return {
    display: "inline-block",
    maxWidth,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    verticalAlign: "bottom",
  };
}

export default function TopBar({ project }: { project?: string; instances?: Instance[] }) {
  const { setSection, repoId, section } = useUI();
  const switchRepo = useSwitchRepo();
  const openSearch = useSearchOpen((s) => s.openSearch);

  const changesQ = useRepoQuery({ queryKey: ["changes"], queryFn: () => api.changes() });
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const repos = wsQ.data?.repos ?? [];
  const activeRepo = repos.find((r) => r.id === repoId);
  const awaiting = changesQ.data?.filter((c) => c.state === "under_review").length ?? 0;
  // Whether we're inside one application (a Configuration tab) and which tab,
  // so the breadcrumb reads Applications / <name> / <tab>.
  const inApp = APP_BREADCRUMB_SECTIONS.has(section);
  const tabLabel = TAB_LABELS[section];
  // Opens the repository at its hosting provider; GitHub gets its own label.
  const gitUrl = activeRepo?.origin?.startsWith("http") ? activeRepo.origin : undefined;
  const isGitHub = !!gitUrl && /(^|\.)github\.com/i.test(gitUrl);

  // Cmd/Ctrl-K is owned by the command palette (a richer jump-to-anything
  // surface); this box stays a quick filter of the current view.
  return (
    <Bar
      left={
        <>
          {/* SEARCH on the left, the way Software Gateway's bar opens. The
              trail stays only inside an application, where it carries the
              application switcher; elsewhere the page title says where you are. */}
          <button
            type="button"
            className="gw-search"
            onClick={() => openSearch(inApp ? "app" : "global")}
            aria-label="Search"
          >
            <SearchOutlined />
            <span className="gw-search-placeholder">
              {inApp ? "Search parameters, values, changes" : "Search applications, instances, changes"}
            </span>
            <Kbd>{modLabel} K</Kbd>
          </button>
          {inApp && (
        <Breadcrumb
          items={[
            // Every trail starts at Home: on the start page it is the only
            // crumb (so the bar is never empty), everywhere else it is the way
            // back out. Each crumb except the last one is a link.
            {
              title:
                section === "home" ? (
                  <span>Home</span>
                ) : (
                  <a onClick={() => setSection("home")} style={{ cursor: "pointer" }}>
                    Home
                  </a>
                ),
            },
            // The workspace level this view belongs to. Inside an application
            // that is Applications (a link back to the collection); on a global
            // page it is that page's own name.
            ...(section === "home"
              ? []
              : inApp
                ? [
                    {
                      title: (
                        <a onClick={() => setSection("workspace")} style={{ cursor: "pointer" }}>
                          Applications
                        </a>
                      ),
                    },
                  ]
                : [{ title: <span>{GLOBAL_LABELS[section] ?? section}</span> }]),
            // Inside an application: its name (a link back to the Overview tab,
            // the default) with a switcher, then the current tab.
            ...(inApp
              ? [
                  {
                    title: (
                      <Space size={2}>
                        {/* the name itself -> Overview (default tab) */}
                        <a onClick={() => setSection("overview")} style={{ cursor: "pointer" }}>
                          <b style={ellipsis(200)} title={activeRepo?.name ?? project}>
                            {activeRepo?.name ?? project ?? "…"}
                          </b>
                        </a>
                        <Dropdown
                          trigger={["click"]}
                          menu={{
                            selectedKeys: repoId ? [repoId] : [],
                            items: [
                              ...repos.map((r) => ({
                                key: r.id,
                                label: (
                                  <Space size={6}>
                                    {r.name}
                                    {r.project && r.project !== r.name && (
                                      <Typography.Text type="secondary" style={{ fontSize: "var(--text-caption)" }}>
                                        {r.project}
                                      </Typography.Text>
                                    )}
                                  </Space>
                                ),
                              })),
                              { type: "divider" as const },
                              { key: "__workspace", label: "Manage applications…" },
                            ],
                            onClick: ({ key }) => {
                              if (key === "__workspace") setSection("workspace");
                              else if (key !== repoId) switchRepo(key);
                            },
                          }}
                        >
                          <a style={{ cursor: "pointer", fontSize: "var(--text-micro)", opacity: 0.6 }}>▾</a>
                        </Dropdown>
                      </Space>
                    ),
                  },
                  // The current tab (omitted on Overview, the default).
                  ...(tabLabel && section !== "overview"
                    ? [{ title: <span style={ellipsis(160)}>{tabLabel}</span> }]
                    : []),
                ]
              : []),
          ]}
        />
          )}
        </>
      }
      right={
        <>
          <Space size={4} style={{ flexShrink: 0 }}>
            {inApp && gitUrl && (
              <Button size="small" icon={isGitHub ? <GithubOutlined /> : <ExportOutlined />} href={gitUrl} target="_blank" rel="noreferrer">
                {isGitHub ? "Open in GitHub" : "View in Git"}
              </Button>
            )}
            <ThemeToggleButton />
            <NotificationsPanel awaiting={awaiting} />
            <IdentityControl repoId={repoId} />
          </Space>
        </>
      }
    >
      {/* Context chips ride in the bar on every tab except Overview, where the
          page header itself carries them (stated once per screen). */}
      {inApp && section !== "overview" && (
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", minWidth: 0, overflow: "hidden" }}>
          <AppContextChips />
        </div>
      )}
    </Bar>
  );
}

// IdentityControl is the person at the right of the bar, drawn with Software
// Gateway's AccountMenu (avatar + account card) so both tools put the same
// card in the same corner. Signed out on a multi-user deployment it is the
// sign-in button instead; single-user mode shows the local operator.
function IdentityControl({ repoId }: { repoId: string | null }) {
  const { setSection, section } = useUI();
  const id = useIdentity();
  const { mode, toggleMode } = useTheme();
  const [membersOpen, setMembersOpen] = useState(false);
  const logout = useSignOut();

  if (id.loading) return null;
  if (id.authEnabled && !id.signedIn) {
    return (
      <Button size="small" type="primary" href={loginHref()}>
        Sign in with GitHub
      </Button>
    );
  }
  const name = id.displayName;
  const initials = name
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const roles = [
    ...(id.admin ? ["Administrator"] : []),
    ...(id.role ? [id.role.charAt(0).toUpperCase() + id.role.slice(1)] : []),
  ];
  return (
    <>
      <AccountMenu
        name={name}
        initials={initials}
        email={id.user?.login}
        roles={roles}
        active={section === "settings" || section === "plugins"}
        items={[
          { key: "settings", label: "Profile & settings", icon: <SettingOutlined />, onClick: () => setSection("settings") },
          {
            key: "appearance",
            label: mode === "dark" ? "Switch to light mode" : "Switch to dark mode",
            icon: <MoonOutlined />,
            onClick: () => toggleMode(),
          },
          ...(id.user?.admin && repoId
            ? [{ key: "members", label: "People & roles", icon: <TeamOutlined />, onClick: () => setMembersOpen(true) }]
            : []),
          ...(id.authEnabled
            ? [{ key: "logout", label: "Sign out", icon: <LogoutOutlined />, danger: true, onClick: () => logout.mutate() }]
            : []),
        ]}
      />
      {repoId && <MembersModal open={membersOpen} onClose={() => setMembersOpen(false)} repoId={repoId} />}
    </>
  );
}
