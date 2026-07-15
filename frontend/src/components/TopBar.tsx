import {
  Breadcrumb,
  Input,
  Space,
  Tooltip,
  Button,
  Badge,
  Avatar,
  Dropdown,
  Tag,
  Typography,
  type InputRef,
} from "antd";
import {
  SearchOutlined,
  MoonOutlined,
  SunOutlined,
  BellOutlined,
  BgColorsOutlined,
  SyncOutlined,
  CloudServerOutlined,
  FontSizeOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
} from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Instance } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { brands, type BrandKey } from "../theme";
import MembersModal from "./MembersModal";

// Application header, kept deliberately light: an ellipsized breadcrumb that
// can never wrap the layout, the global search, appearance controls, the
// approvals bell and fullscreen. Editing-specific actions (Create Change
// Request, git sync status) live in the editor toolbar where they belong.

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
  const { mode, setMode, brand, setBrand, fontScale, setFontScale, search, setSearch, setSection, repoId, section } =
    useUI();
  const switchRepo = useSwitchRepo();
  const searchRef = useRef<InputRef>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const statusQ = useQuery({
    queryKey: ["repo-status"],
    queryFn: api.repoStatus,
    refetchInterval: 20_000,
    enabled: section === "config",
  });
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 20_000 });
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const repos = wsQ.data?.repos ?? [];
  const activeRepo = repos.find((r) => r.id === repoId);
  const awaiting = changesQ.data?.filter((c) => c.state === "under_review").length ?? 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };

  const st = statusQ.data;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", minWidth: 0, flexWrap: "nowrap" }}>
      <div style={{ minWidth: 0, flexShrink: 1, overflow: "hidden" }}>
        <Breadcrumb
          items={[
            {
              title: (
                <a onClick={() => setSection("workspace")} style={{ cursor: "pointer" }}>
                  Applications
                </a>
              ),
            },
            {
              title: (
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
                  <a style={{ cursor: "pointer" }}>
                    <b style={ellipsis(200)} title={activeRepo?.name ?? project}>
                      {activeRepo?.name ?? project ?? "…"}
                    </b>{" "}
                    <span style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
                  </a>
                </Dropdown>
              ),
            },
            ...(section === "config" && st?.branch
              ? [{ title: <span style={ellipsis(110)}>{st.branch}</span> }]
              : []),
          ]}
        />
      </div>
      {section === "config" && st && (
        <Tooltip
          title={
            st.upstreamGone
              ? `The branch "${st.branch}" no longer exists on the remote; it may have been deleted on GitHub. Your local work is safe; ask an administrator to restore the branch or point Configer at a different one.`
              : st.remote
                ? `Synced with the Git remote${st.syncError ? `: ${st.syncError}` : ""}. Commits made directly on Git are picked up automatically.`
                : "Local repository (no remote configured)"
          }
        >
          <Tag
            icon={st.syncError || st.upstreamGone ? <CloudServerOutlined /> : <SyncOutlined spin={statusQ.isFetching} />}
            color={st.upstreamGone ? "error" : st.syncError ? "warning" : st.behind > 0 ? "processing" : "success"}
            style={{ marginInlineEnd: 0, flexShrink: 0 }}
          >
            {st.upstreamGone
              ? "branch removed on remote"
              : st.remote
                ? st.behind > 0
                  ? `${st.behind} behind`
                  : "git: live"
                : "git: local"}
          </Tag>
        </Tooltip>
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
        <Tooltip title={fontScale === "normal" ? "Larger text (easier reading)" : "Normal text size"}>
          <Button
            size="small"
            type={fontScale === "large" ? "primary" : "text"}
            ghost={fontScale === "large"}
            icon={<FontSizeOutlined />}
            onClick={() => setFontScale(fontScale === "normal" ? "large" : "normal")}
          />
        </Tooltip>
        <Tooltip title={fullscreen ? "Exit full screen" : "Full screen"}>
          <Button
            size="small"
            type="text"
            icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            onClick={toggleFullscreen}
          />
        </Tooltip>
        <Tooltip title={awaiting ? `${awaiting} change request(s) waiting for approval` : "No approvals waiting"}>
          <Badge count={awaiting} size="small" color="var(--c-review)">
            <Button size="small" type="text" icon={<BellOutlined />} onClick={() => setSection("approvals")} />
          </Badge>
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
        <Avatar size={26} src={u.avatarUrl || undefined} style={{ background: "#7c3aed", flexShrink: 0, cursor: "pointer" }}>
          {initials}
        </Avatar>
      </Dropdown>
      {repoId && <MembersModal open={membersOpen} onClose={() => setMembersOpen(false)} repoId={repoId} />}
    </>
  );
}
