import {
  Breadcrumb,
  Input,
  Space,
  Tooltip,
  Button,
  Badge,
  Avatar,
  Dropdown,
  Typography,
  type InputRef,
} from "antd";
import { SearchOutlined, BellOutlined, ExportOutlined, SunOutlined, MoonOutlined, ApiOutlined } from "../icons";
import { toggleThemeWithReveal } from "../themeTransition";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Instance } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { AppContextChips } from "./ui";
import MembersModal from "./MembersModal";

// The application context bar: breadcrumb with the app switcher, then the
// persistent context chips (branch, git sync state, instances, unsent edits)
// so the user always knows where they are and whether anything is pending.
// Appearance controls live in the rail's Settings; this bar stays quiet.

// The application-scoped sections and their human tab labels, for the
// breadcrumb (Applications / <name> / <tab>).
const APP_BREADCRUMB_SECTIONS = new Set([
  "overview", "config", "compare", "changes", "drafts", "approvals", "instances", "files", "drift", "import", "audit",
]);
const TAB_LABELS: Record<string, string> = {
  overview: "Overview",
  config: "Editor",
  files: "Files",
  compare: "Compare",
  changes: "Releases",
  drafts: "Releases",
  approvals: "Approvals",
  instances: "Instances",
  drift: "Repository changes",
  import: "Import settings",
  audit: "Audit",
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
  const { search, setSearch, setSection, repoId, section, mode } = useUI();
  const switchRepo = useSwitchRepo();
  const searchRef = useRef<InputRef>(null);

  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 20_000 });
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const repos = wsQ.data?.repos ?? [];
  const activeRepo = repos.find((r) => r.id === repoId);
  const awaiting = changesQ.data?.filter((c) => c.state === "under_review").length ?? 0;
  // Whether we're inside one application (a Configuration tab) and which tab,
  // so the breadcrumb reads Applications / <name> / <tab>.
  const inApp = APP_BREADCRUMB_SECTIONS.has(section);
  const tabLabel = TAB_LABELS[section];
  // "View in Git" opens the repository at its hosting provider.
  const gitUrl = activeRepo?.origin?.startsWith("http") ? activeRepo.origin : undefined;

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
    <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", minWidth: 0, flexWrap: "nowrap" }}>
      <div style={{ minWidth: 0, flexShrink: 1, overflow: "hidden" }}>
        <Breadcrumb
          items={[
            // The first crumb names the global level: Home is quiet (no
            // breadcrumb noise on the start page), Approvals names itself,
            // everything else roots at Applications.
            ...(section === "home"
              ? []
              : section === "inbox"
                ? [{ title: <span>Approvals</span> }]
                : section === "estate"
                ? [{ title: <span>Instances</span> }]
                : section === "changelog"
                ? [{ title: <span>Changes</span> }]
                : section === "repos"
                ? [{ title: <span>Repositories</span> }]
                : [
                    {
                      title: (
                        <a onClick={() => setSection("workspace")} style={{ cursor: "pointer" }}>
                          Applications
                        </a>
                      ),
                    },
                  ]),
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
                                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
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
                          <a style={{ cursor: "pointer", fontSize: 10, opacity: 0.6 }}>▾</a>
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
      </div>
      {/* Context chips ride in the bar on every tab except Overview, where
          the page header itself carries them (stated once per screen). */}
      {inApp && section !== "overview" && (
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", minWidth: 0, overflow: "hidden" }}>
          <AppContextChips />
        </div>
      )}
      <div style={{ flex: 1, minWidth: 8 }} />
      <Input
        ref={searchRef}
        prefix={<SearchOutlined />}
        placeholder="Search everything… (⌘K)"
        size="small"
        allowClear
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: "clamp(150px, 20vw, 340px)", flexShrink: 0 }}
      />
      <Space size={4} style={{ flexShrink: 0 }}>
        {inApp && gitUrl && (
          <Button size="small" icon={<ExportOutlined />} href={gitUrl} target="_blank">
            View in Git
          </Button>
        )}
        <Tooltip title={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
          <Button
            size="small"
            type="text"
            aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            icon={mode === "dark" ? <SunOutlined /> : <MoonOutlined />}
            onClick={(e) => toggleThemeWithReveal({ x: e.clientX, y: e.clientY })}
          />
        </Tooltip>
        <Tooltip title={awaiting ? `${awaiting} change request(s) waiting for approval` : "No approvals waiting"}>
          <Badge count={awaiting} size="small" color="var(--c-review)">
            <Button size="small" type="text" icon={<BellOutlined />} onClick={() => setSection("inbox")} />
          </Badge>
        </Tooltip>
        <Tooltip title="API documentation (OpenAPI / Swagger)">
          <Button
            size="small"
            type="text"
            aria-label="Open the API documentation"
            icon={<ApiOutlined />}
            href="/api/docs"
            target="_blank"
          />
        </Tooltip>
        <IdentityControl repoId={repoId} />
      </Space>
    </div>
  );
}

// IdentityControl is the sign-in surface. Single-user deployments (no OAuth
// configured) show nothing; multi-user ones show a Sign-in button or the
// user's avatar menu (people & roles for admins, sign out).
function IdentityControl({ repoId }: { repoId: string | null }) {
  const qc = useQueryClient();
  const meQ = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
  const [membersOpen, setMembersOpen] = useState(false);
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => qc.invalidateQueries(),
  });

  const me = meQ.data;
  if (!me?.enabled) return null;
  if (!me.user) {
    return (
      <Button size="small" type="primary" href="/api/auth/login">
        Sign in with GitHub
      </Button>
    );
  }
  const u = me.user;
  const initials = (u.name || u.login).slice(0, 2).toUpperCase();
  return (
    <>
      <Dropdown
        trigger={["click"]}
        menu={{
          items: [
            { key: "who", label: <b>{u.name || u.login}</b>, disabled: true },
            ...(u.admin && repoId
              ? [{ key: "members", label: "People & roles…" }]
              : []),
            { type: "divider" as const },
            { key: "logout", label: "Sign out" },
          ],
          onClick: ({ key }) => {
            if (key === "logout") logout.mutate();
            if (key === "members") setMembersOpen(true);
          },
        }}
      >
        <Avatar size={26} src={u.avatarUrl || undefined} style={{ background: "var(--brand)", flexShrink: 0, cursor: "pointer" }}>
          {initials}
        </Avatar>
      </Dropdown>
      {repoId && <MembersModal open={membersOpen} onClose={() => setMembersOpen(false)} repoId={repoId} />}
    </>
  );
}
