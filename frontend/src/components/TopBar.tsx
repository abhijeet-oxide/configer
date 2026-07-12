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
  Popover,
  List,
  Modal,
  Empty,
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
  CheckCircleOutlined,
  PullRequestOutlined,
  InboxOutlined,
  EditOutlined,
  QuestionCircleOutlined,
  InfoCircleOutlined,
  LogoutOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { brands, type BrandKey } from "../theme";

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

export default function TopBar({ project }: { project?: string }) {
  const {
    mode, setMode, brand, setBrand, fontScale, setFontScale, search, setSearch,
    setSection, repoId, section,
  } = useUI();
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
  const findingsQ = useQuery({ queryKey: ["findings"], queryFn: api.findings, refetchInterval: 30_000, retry: false });
  const metaQ = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: 300_000 });
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const repos = wsQ.data?.repos ?? [];
  const activeRepo = repos.find((r) => r.id === repoId);
  const awaiting = changesQ.data?.filter((c) => c.state === "under_review").length ?? 0;
  const drafts = changesQ.data?.filter((c) => c.state === "draft").length ?? 0;
  const findings = findingsQ.data?.findings?.length ?? 0;
  // Notifications aggregate the things that need a human: approvals waiting,
  // external repository changes, and your own unsent drafts. The badge counts
  // the first two (actionable by you now); drafts show as a gentle reminder.
  const notifCount = awaiting + findings;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const meta = metaQ.data;

  // One notification per actionable pile, each deep-linking to where it is
  // resolved. Built from queries the header already runs, so no new endpoint.
  const go = (s: string) => {
    setSection(s);
    setNotifOpen(false);
  };
  const notifItems = [
    awaiting > 0 && {
      icon: <PullRequestOutlined style={{ color: "#1677ff" }} />,
      title: `${awaiting} change request${awaiting === 1 ? "" : "s"} awaiting approval`,
      desc: "Review and publish, or send back.",
      onClick: () => go("approvals"),
    },
    findings > 0 && {
      icon: <InboxOutlined style={{ color: "#fa8c16" }} />,
      title: `${findings} repository change${findings === 1 ? "" : "s"} detected`,
      desc: "Someone committed directly on Git; import or retire.",
      onClick: () => go("drift"),
    },
    drafts > 0 && {
      icon: <EditOutlined style={{ color: "#0ca30c" }} />,
      title: `${drafts} draft${drafts === 1 ? "" : "s"} not yet sent`,
      desc: "Your staged edits are saved but not in review.",
      onClick: () => go("changes"),
    },
  ].filter(Boolean) as { icon: React.ReactNode; title: string; desc: string; onClick: () => void }[];

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
  const appName = activeRepo?.name ?? project;

  const workspaceCrumb = {
    title: (
      <a onClick={() => setSection("workspace")} style={{ cursor: "pointer" }}>
        Applications
      </a>
    ),
  };
  const appCrumb = {
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
            { key: "__workspace", label: "Connect or manage repositories…" },
          ],
          onClick: ({ key }) => {
            if (key === "__workspace") setSection("workspace");
            else if (key !== repoId) switchRepo(key);
          },
        }}
      >
        <a style={{ cursor: "pointer" }}>
          <b style={ellipsis(200)} title={appName}>
            {appName ?? "…"}
          </b>{" "}
          <span style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
        </a>
      </Dropdown>
    ),
  };
  // The breadcrumb stays deliberately short: Applications / <application>.
  // The current view is already obvious from the highlighted app tab, and the
  // instance context is chosen in the Systems tree, so neither belongs here.
  const crumbItems = section === "workspace" ? [workspaceCrumb] : [workspaceCrumb, appCrumb];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", minWidth: 0, flexWrap: "nowrap" }}>
      <div style={{ minWidth: 0, flexShrink: 1, overflow: "hidden" }}>
        <Breadcrumb items={crumbItems} />
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
        <Popover
          open={notifOpen}
          onOpenChange={setNotifOpen}
          trigger="click"
          placement="bottomRight"
          title={
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Notifications</span>
              {notifItems.length > 0 && (
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => go("approvals")}>
                  Open Approvals
                </Button>
              )}
            </div>
          }
          content={
            <div style={{ width: 320 }}>
              {notifItems.length === 0 ? (
                <Empty
                  image={<CheckCircleOutlined style={{ fontSize: 28, color: "#52c41a" }} />}
                  styles={{ image: { height: 34 } }}
                  description="You're all caught up"
                />
              ) : (
                <List
                  size="small"
                  dataSource={notifItems}
                  renderItem={(n) => (
                    <List.Item style={{ cursor: "pointer", paddingInline: 4 }} onClick={n.onClick}>
                      <List.Item.Meta
                        avatar={n.icon}
                        title={<span style={{ fontSize: 13 }}>{n.title}</span>}
                        description={<span style={{ fontSize: 11.5 }}>{n.desc}</span>}
                      />
                    </List.Item>
                  )}
                />
              )}
            </div>
          }
        >
          <Tooltip title="Notifications">
            <Badge count={notifCount} size="small">
              <Button size="small" type="text" icon={<BellOutlined />} aria-label="Notifications" />
            </Badge>
          </Tooltip>
        </Popover>
        <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              {
                key: "__who",
                label: (
                  <div style={{ lineHeight: 1.3, paddingBlock: 2 }}>
                    <div style={{ fontWeight: 600 }}>You</div>
                    {meta && (
                      <div style={{ fontSize: 11, opacity: 0.65 }}>
                        {meta.name} {meta.version} · {meta.environment}
                      </div>
                    )}
                  </div>
                ),
                disabled: true,
              },
              { type: "divider" as const },
              { key: "settings", icon: <SettingOutlined />, label: "Settings" },
              { key: "shortcuts", icon: <ThunderboltOutlined />, label: "Keyboard shortcuts" },
              { key: "help", icon: <QuestionCircleOutlined />, label: "Help & documentation" },
              { key: "about", icon: <InfoCircleOutlined />, label: "About Configer" },
              { type: "divider" as const },
              {
                key: "signout",
                icon: <LogoutOutlined />,
                label: "Sign out",
                disabled: true,
              },
            ],
            onClick: ({ key }) => {
              if (key === "settings") setSection("settings");
              else if (key === "shortcuts") setShortcutsOpen(true);
              else if (key === "about") setAboutOpen(true);
              else if (key === "help") window.open("https://github.com/abhijeet-oxide/configer#readme", "_blank", "noopener");
            },
          }}
        >
          <Tooltip title="Account">
            <Avatar
              size={26}
              style={{ background: "#7c3aed", flexShrink: 0, cursor: "pointer" }}
              aria-label="Account menu"
            >
              DU
            </Avatar>
          </Tooltip>
        </Dropdown>
      </Space>
      <Modal
        open={shortcutsOpen}
        onCancel={() => setShortcutsOpen(false)}
        footer={null}
        title="Keyboard shortcuts"
        width={440}
      >
        <List
          size="small"
          dataSource={[
            ["⌘K / Ctrl+K", "Focus global search"],
            ["Double-click a cell", "Edit its value"],
            ["Enter", "Commit the edit"],
            ["Esc", "Cancel the edit / close a dialog"],
            ["Right-click a cell", "Cell actions (reset, exclude, copy to…)"],
            ["Browser Back / Forward", "Move between views you've visited"],
          ]}
          renderItem={([keys, what]) => (
            <List.Item>
              <span style={{ fontSize: 12.5 }}>{what}</span>
              <Tag className="mono" style={{ marginInlineEnd: 0 }}>{keys}</Tag>
            </List.Item>
          )}
        />
      </Modal>
      <Modal
        open={aboutOpen}
        onCancel={() => setAboutOpen(false)}
        footer={null}
        title="About Configer"
        width={420}
      >
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
            Git-native configuration lifecycle management. Every change is an ordinary Git commit;
            Git stays the single source of truth.
          </Typography.Paragraph>
          {meta && (
            <div style={{ fontSize: 13 }}>
              <div><b>Deployment:</b> {meta.name}</div>
              <div><b>Version:</b> {meta.version}</div>
              <div><b>Environment:</b> {meta.environment}</div>
            </div>
          )}
        </Space>
      </Modal>
    </div>
  );
}
