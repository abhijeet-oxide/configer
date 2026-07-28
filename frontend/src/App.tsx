import { Layout, Drawer, Button, Alert, Avatar, Tooltip, Grid as AntGrid, App as AntApp, theme as antdTheme } from "antd";
import {
  ApartmentOutlined,
  AppstoreOutlined,
  HomeOutlined,
  InboxOutlined,
  TableOutlined,
  CloudSyncOutlined,
  LeftOutlined,
  RightOutlined,
  SunOutlined,
  MoonOutlined,
  EyeOutlined,
} from "./icons";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, isReady, readyRepos, type Grid as GridData, type Meta, type RepoSummary } from "./api";
import { useConn, loadSnapshot, drainQueue, requeue, OfflineError, type QueuedEdit } from "./offline";
import { notifyError, sentence } from "./notify";
import { useRepoQuery } from "./repoQuery";
import { useDeployment, useHealth } from "./deployment";
import { useUI } from "./store";
import { useIdentity } from "./identity";
import { theme as brand } from "./theme.config";
import { toggleThemeWithReveal } from "./themeTransition";
import NavRail from "./components/NavRail";
import BrandMark from "./components/BrandMark";
import TopBar from "./components/TopBar";
import SearchPalette from "./components/SearchPalette";
import PendingChangesBar from "./components/PendingChangesBar";
import GlobalNewApplication from "./components/GlobalNewApplication";
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
import EvolutionTimeline from "./components/EvolutionTimeline";
import SourcesView from "./components/SourcesView";
import WorkspaceView from "./components/WorkspaceView";
import HomeView from "./components/HomeView";
import FilesView from "./components/FilesView";
import AuditView from "./components/AuditView";
import MobileParamList from "./components/MobileParamList";
import { loginHref } from "./components/SignInView";
import EditorStatusBar from "./components/EditorStatusBar";
import { EmptyState } from "./components/ui";
import { NotFoundArt, OfflineArt, ServiceDownArt, StatePanel } from "./components/illustrations";
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

// ConnectionBanner keeps a temporary service outage non-disruptive: one calm
// line at the top of the page says what is happening, and the user keeps
// working from the local snapshot. A whole paragraph of reassurance would take
// more of the screen than the problem deserves.
function ConnectionBanner() {
  const { online, queued, syncing } = useConn();
  if (!online) {
    return (
      <Alert
        banner
        className="slim-banner"
        type="warning"
        showIcon
        message={
          <>
            Offline - showing the last saved snapshot.{" "}
            {queued > 0
              ? `${queued} edit(s) are stored on this device and sync when the connection returns.`
              : "Edits are stored on this device and sync when the connection returns."}
          </>
        }
      />
    );
  }
  if (syncing || queued > 0) {
    return (
      <Alert
        banner
        className="slim-banner"
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
    mode,
  } = useUI();
  const { token } = antdTheme.useToken();
  const screens = AntGrid.useBreakpoint();
  const wide = screens.lg !== false; // >= 992px: three-panel layout
  const phone = screens.sm === false; // < 576px: bottom-tab single-column tier
  const online = useConn((s) => s.online);
  // What this person may do in the ACTIVE application. Editor-only sections
  // answer with a read-only state instead of their flow, so a deep link cannot
  // walk around a hidden tab.
  const { canEdit } = useIdentity();
  const deployment = useDeployment();
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, refetchInterval: 30_000 });
  // The selected application's portfolio entry, and whether it can be read at
  // all: an application still connecting, or one whose connection failed, has
  // no server behind it, so every repo-scoped read must hold off rather than
  // address an application the service does not have (one failed connection
  // would otherwise become a stream of "not connected" errors).
  const activeRepo = wsQ.data?.repos.find((r) => r.id === repoId) ?? null;
  const activeUnavailable = !!activeRepo && !isReady(activeRepo);
  // Until the portfolio has answered, nothing repo-scoped is read: a remembered
  // application may since have been removed, or may never have finished
  // connecting, and asking anyway spends a round of doomed requests on every
  // cold start. If the portfolio itself cannot be read (offline), fall back to
  // trying: the offline snapshot layer handles it from there.
  const readable = !!repoId && (wsQ.isSuccess ? !activeUnavailable : wsQ.isError);
  // Publish readability so EVERY repo-scoped read inherits the gate (see
  // repoQuery.ts) instead of each view remembering to check.
  const setRepoReadable = useUI((s) => s.setRepoReadable);
  useEffect(() => setRepoReadable(readable), [readable, setRepoReadable]);
  // Whether the selected repository carries a Configer application at all: a
  // connected-but-uninitialized repo routes into the onboarding wizard.
  const projectQ = useQuery({
    queryKey: ["project-info"],
    queryFn: api.projectInfo,
    enabled: readable,
    staleTime: 30_000,
  });
  const uninitialized = projectQ.data?.initialized === false;
  const gridQ = useQuery({
    queryKey: ["grid"],
    queryFn: api.grid,
    // Only load the grid once we positively know the repository carries a
    // Configer application. Before projectInfo resolves, `uninitialized` is
    // still false, so gating on `!uninitialized` would fire a grid load against
    // a possibly un-onboarded repo - which reads .configer/parameters.yaml and
    // fails with a spurious "parameter file not found" toast.
    // The grid is the most expensive read the service serves (it resolves every
    // parameter on every instance from the repository's real files), so it is
    // never the thing that watches for a connection coming back: this used to
    // poll it every 10 s while unreachable, which is exactly backwards. The
    // heartbeat below owns recovery, and flipping back online re-enables the
    // gated reads (see repoQuery.ts), which refetch on their own.
    enabled: readable && online && projectQ.data?.initialized === true,
  });
  // Lightweight heartbeat: keeps probing while unreachable so recovery is
  // automatic. The same probe gated the boot (see BootGate), so it is already
  // warm here.
  useHealth();
  const metaQ = useRepoQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: 300_000, enabled: readable });
  const qc = useQueryClient();

  // Bind the app to a valid repository once the workspace is known: adopt the
  // first READY one when none is selected (or the remembered one is gone), and
  // step back to the workspace screen when nothing is connected at all. An
  // application that is still connecting (or failed to) is deliberately never
  // adopted: it would take the user into a workspace made of failed reads.
  useEffect(() => {
    const repos = wsQ.data?.repos;
    if (!repos) return;
    const ready = readyRepos(repos);
    if (repos.length === 0) {
      // The last application was disconnected: drop the selection and every
      // cached read that belonged to it, so nothing repo-scoped is left to
      // render (or to refetch) against a workspace that has no application.
      if (repoId) {
        setRepo(null);
        qc.clear();
      }
      setSection("workspace");
      return;
    }
    // Keep an explicitly-selected application that is mid-connection: the user
    // is watching it come up, and the views below show that state.
    if (repoId && repos.some((r) => r.id === repoId)) return;
    if (ready.length === 0) {
      if (repoId) {
        setRepo(null);
        qc.clear();
      }
      setSection("workspace");
      return;
    }
    setRepo(ready[0].id);
    qc.clear();
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
      } else if (k === "i") {
        // Details/Inspector pane. Ctrl/Cmd+I is free in Chrome and Edge (unlike
        // the previous Ctrl/Cmd+J, which those browsers bind to Downloads), and
        // "I" for Inspector is easy to remember.
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
      if (section === "changes" || section === "drafts" || section === "instances" || section === "timeline")
        return <TableSkeleton />;
      if (section === "compare") return <CompareSkeleton />;
      if (section === "drift" || section === "import" || section === "sources") return <ListSkeleton />;
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
            art={<ServiceDownArt />}
            title={`Can't reach the ${deployment.name} service`}
            subtitle={
              <>
                {deployment.environment
                  ? `The ${deployment.environment} deployment (${deployment.name} ${deployment.version}) isn't responding right now.`
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
    // Importing brings new parameters under management, so it is an editor
    // flow. Its tab is hidden for a viewer; this is the deep link answering
    // too, with the state rather than a wizard whose last step would be refused.
    if (section === "import")
      return canEdit ? (
        <ImportWizard grid={grid} />
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <EmptyState
            icon={<EyeOutlined />}
            title="You have view access to this application"
            hint="Importing settings brings new parameters under management, which is a change. You can read the configuration, its files and its history; an administrator grants edit access."
          />
        </div>
      );
    if (section === "drift") return <RepoChangesView />;
    if (section === "approvals") return <ApprovalsView />;
    if (section === "changes" || section === "drafts") return <ChangeRequestsView />;
    if (section === "compare") return <ComparePanel grid={grid} />;
    if (section === "timeline") return <EvolutionTimeline grid={grid} />;
    if (section === "instances") return <InstancesView grid={grid} />;
    if (section === "files") return <FilesView />;
    if (section === "sources") return <SourcesView />;
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
    // The audit trail spans every application: who did what, across the whole
    // workspace, so it belongs here and needs no application selected.
    if (section === "audit")
      return (
        <div style={{ height: "100%", overflow: "auto", ...panelBg }}>
          <AuditView />
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
    // Everything below belongs to ONE application, so it needs one. A fresh or
    // emptied workspace has none - an ordinary state, not a failure - so show
    // the collection, which invites the user to connect their first.
    if (!repoId)
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <WorkspaceView />
        </div>
      );
    // The selected application is still being connected, or its connection
    // failed. It has no configuration to show yet, and asking for some would
    // only produce errors - so this is its own state, with the two things worth
    // doing: wait, or remove it and start over.
    if (activeUnavailable && activeRepo)
      return (
        <div style={{ height: "100%", overflow: "auto", ...panelBg }}>
          <UnavailableApplication repo={activeRepo} />
        </div>
      );
    // Hold every application-level view until we actually know whether this
    // repo carries a Configer application. Rendering the editor (or the tab
    // strip, which fires its own draft/grid/sources queries) before projectInfo
    // resolves would hit .configer against a possibly un-onboarded repository
    // and raise a spurious "parameter file not found" error.
    if (repoId && projectQ.isPending)
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <GridSkeleton />
        </div>
      );
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
    // An address that names no section: a page, not a bare result box.
    return (
      <div style={{ height: "100%", overflow: "auto", ...panelBg }}>
        <div style={{ paddingTop: 48 }}>
          <StatePanel
            art={<NotFoundArt size={132} />}
            title="This page doesn't exist"
            subtitle={
              <>
                Nothing here answers to <b>{section}</b>. It may have been renamed, or the link may
                be out of date.
              </>
            }
            actions={
              <>
                <Button type="primary" onClick={() => setSection("home")}>
                  Go to start page
                </Button>
                <Button onClick={() => setSection("workspace")}>See applications</Button>
              </>
            }
          />
        </div>
      </div>
    );
  }

  // Phone tier: single column with a bottom tab bar, no side rail, no tabs row.
  // The bar mirrors the desktop rail's levels (Home, Applications, Inbox) plus
  // the one app-level surface worth a thumb - the parameters - so moving
  // between the two form factors needs no relearning.
  if (phone) {
    const tabs = [
      { key: "home", icon: <HomeOutlined />, label: "Home", on: ["home"] },
      { key: "workspace", icon: <AppstoreOutlined />, label: "Apps", on: ["workspace", "overview"] },
      { key: "config", icon: <TableOutlined />, label: "Parameters", on: ["config", "files", "instances", "compare"] },
      { key: "inbox", icon: <InboxOutlined />, label: "Inbox", on: ["inbox", "approvals", "changes", "drafts", "changelog"] },
    ];
    return (
      <Layout style={{ height: "100vh" }}>
        <div
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
            borderBottom: border, background: token.colorBgContainer, flexShrink: 0,
          }}
        >
          {/* The same mark the rail shows: the identity must not change with
              the window size. */}
          <BrandMark />
          <b style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {grid?.project ?? meta?.project ?? brand.appName}
          </b>
          <div style={{ flex: 1 }} />
          <Tooltip title={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
            <Button
              size="small"
              type="text"
              aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              icon={mode === "dark" ? <SunOutlined /> : <MoonOutlined />}
              onClick={(e) => toggleThemeWithReveal({ x: e.clientX, y: e.clientY })}
            />
          </Tooltip>
          {/* Profile and every personal preference, one tap away - the phone's
              stand-in for the rail's profile card. */}
          <MobileProfileButton />
        </div>
        <OfflineReplay />
        <ConnectionBanner />
        <Content style={{ overflow: "hidden", minHeight: 0 }}>{body()}</Content>
        <WelcomeTour />
        <GlobalNewApplication />
        <div className="mobile-tabbar" style={{ background: token.colorBgContainer }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              className={t.on.includes(section) ? "active" : ""}
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
      <GlobalNewApplication />
      <WelcomeTour />
      <PendingChangesBar />
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

// MobileProfileButton is the phone's profile entry: the signed-in person's
// avatar (or the local operator's initials) opening the Settings page, where
// identity and every personal preference live. Signed out on a multi-user
// deployment it becomes the sign-in entry, exactly like the rail's card.
function MobileProfileButton() {
  const setSection = useUI((s) => s.setSection);
  const id = useIdentity();
  if (id.loading) return null;
  if (id.authEnabled && !id.signedIn) {
    return (
      <Button
        size="small"
        type="primary"
        href={loginHref()}
      >
        Sign in
      </Button>
    );
  }
  const initials = (id.displayName || "?").slice(0, 2).toUpperCase();
  return (
    <Avatar
      size={28}
      src={id.user?.avatarUrl || undefined}
      onClick={() => setSection("settings")}
      style={{ background: "var(--brand)", flexShrink: 0, cursor: "pointer" }}
      aria-label={`${id.displayName} - open settings`}
    >
      {initials}
    </Avatar>
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

// UnavailableApplication is what an application that is not (yet) connected
// shows in place of its workspace: a plain sentence about what is happening,
// and a way out. Removing it here disconnects only the workspace entry - no
// repository is touched, because none was ever successfully read.
function UnavailableApplication({ repo }: { repo: RepoSummary }) {
  const qc = useQueryClient();
  const setRepo = useUI((s) => s.setRepo);
  const setSection = useUI((s) => s.setSection);
  const connecting = repo.status === "connecting";
  const remove = useMutation({
    mutationFn: () => api.removeRepo(repo.id),
    onSuccess: () => {
      setRepo(null);
      setSection("workspace");
      qc.clear();
      void qc.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: (e) => notifyError(e),
  });
  return (
    <div style={{ paddingTop: 48 }}>
      <StatePanel
        art={<OfflineArt />}
        title={connecting ? `Connecting "${repo.name}"…` : `"${repo.name}" could not be connected`}
        subtitle={
          connecting ? (
            <>
              Configer is reading the repository. This page updates itself as soon as it is ready -
              a large repository can take a minute.
            </>
          ) : (
            <>
              {sentence(repo.error) || "The repository could not be read."} Nothing was changed in
              Git - you can remove this application and add it again.
            </>
          )
        }
        actions={
          connecting ? null : (
            <Button danger loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove this application
            </Button>
          )
        }
      />
    </div>
  );
}
