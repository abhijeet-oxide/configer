import { Layout, Result, Drawer, Button, Alert, Tooltip, Grid as AntGrid, App as AntApp, theme as antdTheme } from "antd";
import {
  ApartmentOutlined,
  HomeOutlined,
  TableOutlined,
  PullRequestOutlined,
  CheckCircleOutlined,
  CloudSyncOutlined,
  LeftOutlined,
  RightOutlined,
} from "./icons";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type Grid as GridData, type Meta } from "./api";
import { useConn, loadSnapshot, drainQueue, requeue, OfflineError, type QueuedEdit } from "./offline";
import { useUI } from "./store";
import NavRail from "./components/NavRail";
import TopBar from "./components/TopBar";
import SearchPalette from "./components/SearchPalette";
import CategoryTree from "./components/CategoryTree";
import ParameterGrid from "./components/ParameterGrid";
import DetailsPanel from "./components/DetailsPanel";
import ComparePanel from "./components/ComparePanel";
import PluginsView from "./components/PluginsView";
import SettingsView from "./components/SettingsView";
import WelcomeTour from "./components/WelcomeTour";
import ChangeRequestsView from "./components/ChangeRequestsView";
import ApprovalsView from "./components/ApprovalsView";
import InboxView from "./components/InboxView";
import InstancesOverview from "./components/InstancesOverview";
import ChangesOverview from "./components/ChangesOverview";
import RepositoriesOverview from "./components/RepositoriesOverview";
import DashboardView from "./components/DashboardView";
import ConfigurationPage, { APP_SECTIONS } from "./components/ConfigurationPage";
import ImportWizard from "./components/ImportWizard";
import InstancesView from "./components/InstancesView";
import OnboardingWizard from "./components/OnboardingWizard";
import RepoChangesView from "./components/RepoChangesView";
import WorkspaceView from "./components/WorkspaceView";
import HomeView from "./components/HomeView";
import FilesView from "./components/FilesView";
import AuditView from "./components/AuditView";
import MobileParamList from "./components/MobileParamList";
import EditorStatusBar from "./components/EditorStatusBar";
import { OfflineArt, StatePanel } from "./components/illustrations";
import {
  GridSkeleton,
  TableSkeleton,
  ApprovalsSkeleton,
  FilesSkeleton,
  OverviewSkeleton,
  CompareSkeleton,
  ListSkeleton,
} from "./components/Skeletons";

const { Header, Sider, Content } = Layout;

function ResizeHandleV() {
  return <PanelResizeHandle className="rrp-handle rrp-handle-v" />;
}

// ConnectionBanner keeps a temporary service outage non-disruptive: users see
// what is happening in plain words and keep working from the local snapshot.
function ConnectionBanner() {
  const { online, queued, syncing } = useConn();
  if (!online) {
    return (
      <Alert
        banner
        type="warning"
        showIcon
        message="Configer can't reach its service right now."
        description={`You're viewing the last saved snapshot. ${
          queued > 0 ? `${queued} edit(s) are safely stored on this device and ` : "Any edits you make are stored on this device and "
        }will sync automatically when the connection returns.`}
      />
    );
  }
  if (syncing || queued > 0) {
    return (
      <Alert
        banner
        type="info"
        showIcon
        icon={<CloudSyncOutlined spin />}
        message={`Syncing ${queued} edit(s) made while offline…`}
      />
    );
  }
  return null;
}

// OfflineReplay pushes edits queued while offline back to the service once it
// is reachable again.
function OfflineReplay() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { online, queued, syncing, setSyncing } = useConn();
  const busy = useRef(false);

  useEffect(() => {
    if (!online || queued === 0 || syncing || busy.current) return;
    busy.current = true;
    setSyncing(true);
    (async () => {
      const edits = drainQueue();
      let synced = 0;
      const rejected: string[] = [];
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        try {
          await api.setValue(e as unknown as { instance: string; paramId: string; value?: unknown });
          synced++;
        } catch (err) {
          if (err instanceof OfflineError) {
            requeue(edits.slice(i) as QueuedEdit[]); // connection dropped again: keep the rest
            break;
          }
          rejected.push(`${e.paramId} (${(err as Error).message})`);
        }
      }
      setSyncing(false);
      busy.current = false;
      if (synced > 0) {
        message.success(`${synced} edit(s) made while offline are now synced.`);
        qc.invalidateQueries();
      }
      if (rejected.length > 0) {
        message.warning(`Some offline edits were rejected by validation: ${rejected.join(", ")}`, 8);
      }
    })();
  }, [online, queued, syncing, setSyncing, message, qc]);

  return null;
}

export default function App() {
  const {
    section,
    setSection,
    selectedParamId,
    selectParam,
    navCollapsed,
    setNavCollapsed,
    repoId,
    setRepo,
    panels,
    togglePanel,
    editorFocus,
    setEditorFocus,
  } = useUI();
  const { token } = antdTheme.useToken();
  const screens = AntGrid.useBreakpoint();
  const wide = screens.lg !== false; // >= 992px: three-panel layout
  const phone = screens.sm === false; // < 576px: bottom-tab single-column tier
  const online = useConn((s) => s.online);
  // Whether the selected repository carries a Configer application at all: a
  // connected-but-uninitialized repo routes into the onboarding wizard.
  const projectQ = useQuery({
    queryKey: ["project-info"],
    queryFn: api.projectInfo,
    enabled: !!repoId,
    staleTime: 30_000,
  });
  const uninitialized = projectQ.data?.initialized === false;
  const gridQ = useQuery({
    queryKey: ["grid"],
    queryFn: api.grid,
    enabled: !uninitialized,
    refetchInterval: online ? false : 10_000,
  });
  // lightweight heartbeat: keeps probing while unreachable so recovery is automatic
  useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 8_000, retry: false });
  const metaQ = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: 300_000 });
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, refetchInterval: 30_000 });
  const qc = useQueryClient();

  // Bind the app to a valid repository once the workspace is known: adopt the
  // first one when none is selected (or the remembered one is gone), and step
  // back to the workspace screen when nothing is connected at all.
  useEffect(() => {
    const repos = wsQ.data?.repos;
    if (!repos) return;
    if (repos.length === 0) {
      if (repoId) setRepo(null);
      setSection("workspace");
      return;
    }
    if (!repoId || !repos.some((r) => r.id === repoId)) {
      setRepo(repos[0].id);
      qc.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsQ.data, repoId]);

  // Editor keyboard shortcuts, chosen to echo tools people already know:
  //   ⌘B      toggle the parameters panel   (VS Code: toggle sidebar)
  //   ⌘⌥B     toggle the details panel       (the opposite-side companion)
  //   ⌘J      toggle the details/inspector   (VS Code: toggle panel)
  //   ⌘⇧F     focus mode on/off              (F for focus)
  //   Esc     leave focus mode
  // Panel shortcuts only act inside the editor; none fire while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "Escape" && editorFocus) {
        setEditorFocus(false);
        return;
      }
      if (typing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "b") {
        if (section !== "config") return;
        e.preventDefault();
        togglePanel(e.altKey ? "right" : "left");
      } else if (k === "j") {
        if (section !== "config") return;
        e.preventDefault();
        togglePanel("right");
      } else if (k === "f" && e.shiftKey) {
        if (section !== "config") return;
        e.preventDefault();
        setEditorFocus(!editorFocus);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section, editorFocus, togglePanel, setEditorFocus]);

  // Ctrl/Cmd+Enter submits whatever modal is open, from anywhere inside it
  // (including a focused text field, where Enter alone must not submit). It
  // clicks the top-most open modal's primary action - the footer OK button,
  // or the first enabled primary button when a modal supplies its own footer.
  // One global convention so every dialog behaves the same.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      // A closed modal keeps its wrap in the DOM with display:none. The wrap is
      // position:fixed, so offsetParent is always null - test real visibility
      // via client rects instead.
      const wraps = Array.from(
        document.querySelectorAll<HTMLElement>(".ant-modal-wrap"),
      ).filter((w) => w.style.display !== "none" && w.getClientRects().length > 0);
      const wrap = wraps[wraps.length - 1];
      if (!wrap) return;
      const btn =
        wrap.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary:not([disabled])") ||
        wrap.querySelector<HTMLButtonElement>(".ant-btn-primary:not([disabled])");
      if (btn) {
        e.preventDefault();
        btn.click();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // Focus mode strips ALL workspace chrome (nav rail, header, and the tab
  // strip) so only the configuration surface remains; it applies while the
  // editor is the active view.
  const focusMode = editorFocus && section === "config";

  // Truly full screen: while focus mode is on, also request native browser
  // fullscreen (best-effort) so even the browser chrome steps aside. Leaving
  // native fullscreen (Esc/F11) turns focus mode back off so the two never
  // drift out of sync.
  useEffect(() => {
    if (focusMode && !document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else if (!focusMode && document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  }, [focusMode]);
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && editorFocus) setEditorFocus(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [editorFocus, setEditorFocus]);

  // The rail folds to icons inside an application so the working surface
  // dominates (like the reference), and re-expands at the global level. A
  // manual toggle pins the user's choice for the rest of the session.
  const manualRail = useRef(false);
  useEffect(() => {
    if (manualRail.current) return;
    const shouldCollapse = APP_SECTIONS.has(section);
    setNavCollapsed(shouldCollapse);
  }, [section, setNavCollapsed]);
  const toggleRail = () => {
    manualRail.current = true;
    setNavCollapsed(!navCollapsed);
  };
  const border = `1px solid ${token.colorBorderSecondary}`;
  const panelBg = { background: token.colorBgContainer };

  // Service unreachable: fall back to the snapshot saved on this device.
  const snapshotGrid = !gridQ.data && gridQ.isError ? loadSnapshot<GridData>("grid")?.data : undefined;
  const grid = gridQ.data ?? snapshotGrid;
  const meta = metaQ.data ?? loadSnapshot<Meta>("meta")?.data;

  function editorLayout() {
    if (!grid) return null;
    if (phone) {
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <MobileParamList grid={grid} />
        </div>
      );
    }
    // The editor carries a VS Code-style bottom status bar (branch, pull,
    // Source Control, validity) beneath whichever panel layout is in use.
    const withStatusBar = (content: React.ReactNode) => (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", ...panelBg }}>
        <div style={{ flex: 1, minHeight: 0 }}>{content}</div>
        <EditorStatusBar grid={grid} />
      </div>
    );
    if (!wide) {
      // Small screens: full-width grid; groups + details slide in as drawers.
      return withStatusBar(
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <div style={{ padding: "6px 12px 0" }}>
            <TreeDrawerButton grid={grid} />
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ParameterGrid grid={grid} />
          </div>
          <Drawer
            title="Parameter details"
            placement="bottom"
            height="70%"
            open={!!selectedParamId}
            onClose={() => selectParam(null)}
          >
            <DetailsPanel grid={grid} />
          </Drawer>
        </div>,
      );
    }
    // The left (parameters) and right (details) panels each quick-collapse to
    // a thin rail on their edge; a click on the rail (or the keyboard
    // shortcut) brings them back. The rails live OUTSIDE the PanelGroup so the
    // resizable middle always fills the freed space.
    return withStatusBar(
      <div style={{ display: "flex", height: "100%", minWidth: 0 }}>
        {!panels.left && (
          <CollapsedRail side="left" label="Parameters" onExpand={() => togglePanel("left")} />
        )}
        <PanelGroup
          direction="horizontal"
          autoSaveId={`configer-main-${panels.left ? "L" : ""}${panels.right ? "R" : ""}`}
          style={{ height: "100%", flex: 1, minWidth: 0 }}
        >
          {panels.left && (
            <>
              <Panel id="left" order={1} defaultSize={15} minSize={10} maxSize={30} style={{ ...panelBg }}>
                <CollapsibleSide side="left" onCollapse={() => togglePanel("left")}>
                  <CategoryTree grid={grid} />
                </CollapsibleSide>
              </Panel>
              <ResizeHandleV />
            </>
          )}
          <Panel id="mid" order={2} defaultSize={63} minSize={40} style={{ minWidth: 0, ...panelBg }}>
            <ParameterGrid grid={grid} />
          </Panel>
          {panels.right && (
            <>
              <ResizeHandleV />
              <Panel id="right" order={3} defaultSize={22} minSize={15} maxSize={35} style={{ ...panelBg }}>
                <CollapsibleSide side="right" onCollapse={() => togglePanel("right")}>
                  <DetailsPanel grid={grid} />
                </CollapsibleSide>
              </Panel>
            </>
          )}
        </PanelGroup>
        {!panels.right && (
          <CollapsedRail side="right" label="Details" onExpand={() => togglePanel("right")} />
        )}
      </div>,
    );
  }

  // appBody renders the inside of one Configuration tab: a full-page skeleton
  // while the grid loads, the connection fallback when it can't, and the
  // selected view otherwise. The tab strip above it stays interactive the
  // whole time, so loading never blanks the page chrome.
  function appBody() {
    if (gridQ.isLoading) {
      // state-aware skeletons: mirror the exact layout the user is waiting for
      if (section === "overview") return <OverviewSkeleton />;
      if (section === "approvals") return <ApprovalsSkeleton />;
      if (section === "changes" || section === "drafts" || section === "instances") return <TableSkeleton />;
      if (section === "compare") return <CompareSkeleton />;
      if (section === "drift" || section === "import") return <ListSkeleton />;
      if (section === "files")
        return (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "16px 20px", gap: 12 }}>
            <FilesSkeleton />
          </div>
        );
      return <GridSkeleton />;
    }
    if (!grid) {
      // No live data and no local snapshot: a calm, professional state, no
      // internal jargon, environment-aware, retries on its own.
      return (
        <div style={{ paddingTop: 48 }}>
          <StatePanel
            art={<OfflineArt />}
            title="Can't reach the Configer service"
            subtitle={
              <>
                {meta
                  ? `The ${meta.environment} deployment (${meta.name} ${meta.version}) isn't responding right now.`
                  : "The service isn't responding right now."}{" "}
                It may be restarting or briefly under maintenance. This page keeps retrying on its own;
                your work is never lost, and any saved edits on this device sync once it's back.
              </>
            }
            actions={
              <Button type="primary" loading={gridQ.isFetching} onClick={() => gridQ.refetch()}>
                Try again now
              </Button>
            }
          />
        </div>
      );
    }

    if (section === "overview") return <DashboardView grid={grid} />;
    if (section === "import") return <ImportWizard grid={grid} />;
    if (section === "drift") return <RepoChangesView />;
    if (section === "approvals") return <ApprovalsView />;
    if (section === "changes" || section === "drafts") return <ChangeRequestsView />;
    if (section === "compare") return <ComparePanel grid={grid} />;
    if (section === "instances") return <InstancesView grid={grid} />;
    if (section === "files") return <FilesView />;
    if (section === "audit") return <AuditView />;
    return editorLayout();
  }

  function body() {
    // The global level does not depend on any one repo's grid, so it renders
    // even while a repository is unavailable or none exists.
    if (section === "home") return <HomeView />;
    if (section === "workspace")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <WorkspaceView />
        </div>
      );
    // Workspace-wide approvals inbox and instances estate: global levels that
    // aggregate over every application, so they render before (and regardless
    // of) the active repository's state.
    if (section === "inbox")
      return (
        <div style={{ height: "100%", overflow: "auto", ...panelBg }}>
          <InboxView />
        </div>
      );
    if (section === "estate")
      return (
        <div style={{ height: "100%", overflow: "auto", ...panelBg }}>
          <InstancesOverview />
        </div>
      );
    if (section === "changelog")
      return (
        <div style={{ height: "100%", overflow: "auto", ...panelBg }}>
          <ChangesOverview />
        </div>
      );
    if (section === "repos")
      return (
        <div style={{ height: "100%", overflow: "auto", ...panelBg }}>
          <RepositoriesOverview />
        </div>
      );
    // Personal settings: a global level, independent of any repository.
    if (section === "settings") return <SettingsView />;
    // A repository without a .configer application goes through onboarding
    // before any other view makes sense.
    if (uninitialized)
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <OnboardingWizard projectName={projectQ.data?.project ?? "this repository"} />
        </div>
      );
    if (section === "plugins") return <PluginsView />;
    // Focus mode shows only the configuration surface: skip the tab strip
    // entirely so the editor is truly full screen, not merely widened.
    if (focusMode) return appBody();
    // Everything belonging to ONE application lives under the Configuration
    // page as a tab (Overview, Editor, Compare, Release history, Approvals…).
    if (APP_SECTIONS.has(section))
      return <ConfigurationPage section={section}>{appBody()}</ConfigurationPage>;
    return (
      <Result
        title={section}
        subTitle="This section does not exist. Use the navigation rail on the left."
      />
    );
  }

  // Phone tier: single column with a bottom tab bar, no side rail, no tabs row.
  if (phone) {
    const tabs = [
      { key: "home", icon: <HomeOutlined />, label: "Home" },
      { key: "config", icon: <TableOutlined />, label: "Parameters" },
      { key: "changes", icon: <PullRequestOutlined />, label: "Changes" },
      { key: "approvals", icon: <CheckCircleOutlined />, label: "Approvals" },
    ];
    return (
      <Layout style={{ height: "100vh" }}>
        <div
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
            borderBottom: border, background: token.colorBgContainer, flexShrink: 0,
          }}
        >
          <div className="logo-tile">C</div>
          <b>{grid?.project ?? meta?.project ?? "Configer"}</b>
        </div>
        <OfflineReplay />
        <ConnectionBanner />
        <Content style={{ overflow: "hidden", minHeight: 0 }}>{body()}</Content>
        <WelcomeTour />
        <div className="mobile-tabbar" style={{ background: token.colorBgContainer }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              className={section === t.key ? "active" : ""}
              onClick={() => setSection(t.key)}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </Layout>
    );
  }

  return (
    <Layout style={{ height: "100vh" }}>
      {!focusMode && (
        <Sider
          width={216}
          collapsedWidth={60}
          collapsible
          collapsed={navCollapsed}
          trigger={null}
          style={{ background: "var(--nav-bg)" }}
        >
          <NavRail collapsed={navCollapsed} onToggleCollapse={toggleRail} />
        </Sider>
      )}
      <Layout style={{ minWidth: 0 }}>
        {!focusMode && (
          <Header style={{ borderBottom: border, background: token.colorBgContainer, paddingInline: 16 }}>
            <TopBar project={grid?.project ?? meta?.project} instances={grid?.instances} />
          </Header>
        )}
        <OfflineReplay />
        <ConnectionBanner />
        <Content style={{ overflow: "hidden" }}>{body()}</Content>
      </Layout>
      <SearchPalette />
      <WelcomeTour />
    </Layout>
  );
}

// CollapsedRail is the thin, always-visible spine a side panel collapses to:
// a vertical label and a chevron pointing the way the panel will reopen.
function CollapsedRail({
  side,
  label,
  onExpand,
}: {
  side: "left" | "right";
  label: string;
  onExpand: () => void;
}) {
  const { token } = antdTheme.useToken();
  return (
    <Tooltip title={`Show ${label.toLowerCase()} (${side === "left" ? "⌘B" : "⌘⌥B"})`} placement={side === "left" ? "right" : "left"}>
      <div
        onClick={onExpand}
        className="panel-rail"
        style={{
          width: 26,
          flexShrink: 0,
          cursor: "pointer",
          background: token.colorBgContainer,
          [side === "left" ? "borderRight" : "borderLeft"]: `1px solid ${token.colorBorderSecondary}`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          paddingTop: 10,
          userSelect: "none",
        }}
      >
        {side === "left" ? <RightOutlined style={{ fontSize: 11, opacity: 0.7 }} /> : <LeftOutlined style={{ fontSize: 11, opacity: 0.7 }} />}
        <span
          style={{
            writingMode: "vertical-rl",
            transform: side === "left" ? "none" : "rotate(180deg)",
            fontSize: 12,
            opacity: 0.65,
            letterSpacing: 0.3,
          }}
        >
          {label}
        </span>
      </div>
    </Tooltip>
  );
}

// CollapsibleSide wraps a side panel's content with a slim collapse gutter on
// its inner edge (a chevron pointing the way the panel folds) so every panel
// can be tucked away with one click without ever overlapping its content.
function CollapsibleSide({
  side,
  onCollapse,
  children,
}: {
  side: "left" | "right";
  onCollapse: () => void;
  children: React.ReactNode;
}) {
  const { token } = antdTheme.useToken();
  const gutter = (
    <Tooltip title={`Hide panel (${side === "left" ? "⌘B" : "⌘⌥B"})`} placement={side === "left" ? "left" : "right"}>
      <div
        onClick={onCollapse}
        className="panel-gutter"
        style={{
          width: 16,
          flexShrink: 0,
          cursor: "pointer",
          display: "flex",
          justifyContent: "center",
          paddingTop: 8,
          color: token.colorTextTertiary,
          [side === "left" ? "borderLeft" : "borderRight"]: `1px solid ${token.colorBorderSecondary}`,
        }}
        aria-label="Collapse panel"
      >
        {side === "left" ? <LeftOutlined style={{ fontSize: 11 }} /> : <RightOutlined style={{ fontSize: 11 }} />}
      </div>
    </Tooltip>
  );
  return (
    <div style={{ display: "flex", height: "100%", minWidth: 0 }}>
      {side === "right" && gutter}
      <div style={{ flex: 1, minWidth: 0, height: "100%" }}>{children}</div>
      {side === "left" && gutter}
    </div>
  );
}

// Compact trigger for the category tree on small screens.
function TreeDrawerButton({ grid }: { grid: GridData }) {
  const { categoryKey } = useUI();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" icon={<ApartmentOutlined />} onClick={() => setOpen(true)}>
        {categoryKey ? categoryKey.split("/").pop() : "All Parameters"}
      </Button>
      <Drawer title="Parameter Groups" placement="left" width={280} open={open} onClose={() => setOpen(false)}>
        <CategoryTree grid={grid} />
      </Drawer>
    </>
  );
}
