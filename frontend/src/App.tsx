import { Layout, Result, Drawer, Button, Alert, Segmented, Grid as AntGrid, App as AntApp, theme as antdTheme } from "antd";
import {
  ApartmentOutlined,
  HomeOutlined,
  TableOutlined,
  PullRequestOutlined,
  CheckCircleOutlined,
  CloudSyncOutlined,
  FullscreenExitOutlined,
  FolderOpenOutlined,
} from "@ant-design/icons";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type Grid as GridData, type Meta } from "./api";
import { useConn, loadSnapshot, drainQueue, requeue, OfflineError, type QueuedEdit } from "./offline";
import { useUI } from "./store";
import NavRail from "./components/NavRail";
import TopBar from "./components/TopBar";
import CategoryTree from "./components/CategoryTree";
import ParameterGrid from "./components/ParameterGrid";
import DetailsPanel from "./components/DetailsPanel";
import ComparePanel from "./components/ComparePanel";
import PluginsView from "./components/PluginsView";
import ChangeRequestsView from "./components/ChangeRequestsView";
import ApprovalsView from "./components/ApprovalsView";
import ImportWizard from "./components/ImportWizard";
import RepoChangesView from "./components/RepoChangesView";
import WorkspaceView from "./components/WorkspaceView";
import RenderedFilesView from "./components/RenderedFilesView";
import DashboardView from "./components/DashboardView";
import InstancesView from "./components/InstancesView";
import HistoryView from "./components/HistoryView";
import SettingsView from "./components/SettingsView";
import AppTabs, { isAppSection } from "./components/AppTabs";
import MobileParamList from "./components/MobileParamList";
import { GridSkeleton, ListSkeleton } from "./components/Skeletons";
import { SECTION_LABELS } from "./components/NavRail";

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
  const { section, setSection, selectedParamId, selectParam, navCollapsed, setNavCollapsed, repoId, setRepo,
    editorFocus, setEditorFocus, configView, setConfigView } = useUI();
  const { token } = antdTheme.useToken();
  const screens = AntGrid.useBreakpoint();
  const wide = screens.lg !== false; // >= 992px: three-panel layout
  const phone = screens.sm === false; // < 576px: bottom-tab single-column tier
  const online = useConn((s) => s.online);
  const gridQ = useQuery({ queryKey: ["grid"], queryFn: api.grid, refetchInterval: online ? false : 10_000 });
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
  // Focus mode leaves the editor with a single Escape press.
  useEffect(() => {
    if (!editorFocus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditorFocus(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorFocus, setEditorFocus]);

  const border = `1px solid ${token.colorBorderSecondary}`;
  const panelBg = { background: token.colorBgContainer };
  // Focus mode only makes sense for the three-pane editor on a wide screen.
  const focus = editorFocus && section === "config" && wide;

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
    // Configuration hosts an inline view toggle (the spreadsheet Table, or the
    // rendered Files + live diff). The toggle now lives on the app tab row so it
    // shares a single row with the tabs instead of adding a second strip.
    let content: React.ReactNode;
    if (configView === "exported") {
      content = <RenderedFilesView grid={grid} />;
    } else if (!wide) {
      // Small screens: full-width grid; groups + details slide in as drawers.
      content = (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", ...panelBg }}>
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
        </div>
      );
    } else {
      content = (
        <PanelGroup direction="horizontal" autoSaveId="configer-main" style={{ height: "100%" }}>
          <Panel defaultSize={16} minSize={11} maxSize={30} style={{ ...panelBg }}>
            <CategoryTree grid={grid} />
          </Panel>
          <ResizeHandleV />
          <Panel defaultSize={62} minSize={40} style={{ minWidth: 0, ...panelBg }}>
            <ParameterGrid grid={grid} />
          </Panel>
          <ResizeHandleV />
          <Panel defaultSize={22} minSize={15} maxSize={35} style={{ ...panelBg }}>
            <DetailsPanel grid={grid} />
          </Panel>
        </PanelGroup>
      );
    }

    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", ...panelBg }}>
        <div style={{ flex: 1, minHeight: 0 }}>{content}</div>
      </div>
    );
  }

  function body() {
    // The workspace (portfolio) level does not depend on any one repo's grid,
    // so it renders even while a repository is unavailable or none exists.
    // "home" merged into it: cards on top, the selected configuration's
    // overview right below on the same page.
    if (section === "workspace" || section === "home")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <WorkspaceView />
        </div>
      );
    if (gridQ.isLoading) {
      // state-aware skeletons: mirror the layout the user is waiting for
      if (section === "approvals" || section === "changes") return <ListSkeleton />;
      return <GridSkeleton />;
    }
    if (!grid) {
      // No live data and no local snapshot: a calm, professional state, no
      // internal jargon, environment-aware, retries on its own.
      return (
        <Result
          status="warning"
          icon={<CloudSyncOutlined style={{ color: token.colorPrimary }} />}
          title="Can't connect to the Configer service"
          subTitle={
            <>
              {meta
                ? `The ${meta.environment} deployment (${meta.name} ${meta.version}) isn't responding right now.`
                : "The service isn't responding right now."}{" "}
              It may be restarting or briefly under maintenance. This page keeps retrying automatically;
              your work is never lost, and any saved edits on this device will sync once it's back.
            </>
          }
          extra={
            <Button type="primary" loading={gridQ.isFetching} onClick={() => gridQ.refetch()}>
              Try again now
            </Button>
          }
        />
      );
    }

    if (section === "overview")
      return (
        <div style={{ height: "100%", overflow: "auto", ...panelBg }}>
          <DashboardView grid={grid} />
        </div>
      );
    if (section === "instances")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <InstancesView grid={grid} />
        </div>
      );
    if (section === "settings")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <SettingsView />
        </div>
      );
    if (section === "plugins") return <PluginsView />;
    if (section === "import")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <ImportWizard grid={grid} />
        </div>
      );
    if (section === "drift")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <RepoChangesView />
        </div>
      );
    if (section === "approvals")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <ApprovalsView />
        </div>
      );
    if (section === "changes" || section === "drafts")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <ChangeRequestsView />
        </div>
      );
    if (section === "compare")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <ComparePanel grid={grid} />
        </div>
      );
    if (section === "history")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <HistoryView />
        </div>
      );
    if (section === "config") return editorLayout();
    // Named-but-not-yet-built application views (Instances, History). Named here
    // so the shell is complete even while the view itself is on the roadmap.
    return (
      <Result
        icon={<CloudSyncOutlined style={{ color: token.colorPrimary }} />}
        title={SECTION_LABELS[section] ?? section}
        subTitle={`${SECTION_LABELS[section] ?? "This view"} lands in a later phase (see docs/PLAN.md).`}
        extra={
          <Button onClick={() => setSection("config")}>Go to Configuration</Button>
        }
      />
    );
  }

  // Focus mode: maximize the Configuration workspace, hiding the nav rail and
  // header so the editor fills the viewport. Scoped to the editor only (not a
  // browser fullscreen of the whole app); a floating control and Esc restore
  // the shell.
  if (focus) {
    return (
      <div style={{ height: "100vh", position: "relative", ...panelBg }}>
        <Content style={{ overflow: "hidden", height: "100%" }}>{editorLayout()}</Content>
        <Button
          size="small"
          icon={<FullscreenExitOutlined />}
          onClick={() => setEditorFocus(false)}
          style={{ position: "absolute", top: 8, right: 12, zIndex: 20, boxShadow: token.boxShadowSecondary }}
        >
          Exit focus (Esc)
        </Button>
      </div>
    );
  }

  // Phone tier: single column with a bottom tab bar, no side rail, no tabs row.
  if (phone) {
    const tabs = [
      { key: "workspace", icon: <HomeOutlined />, label: "Apps" },
      { key: "config", icon: <TableOutlined />, label: "Config" },
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
      <Sider
        width={210}
        collapsedWidth={56}
        collapsible
        collapsed={navCollapsed}
        onCollapse={setNavCollapsed}
        breakpoint="xxl"
        theme="light"
        style={{ borderRight: border }}
      >
        <NavRail collapsed={navCollapsed} />
      </Sider>
      <Layout style={{ minWidth: 0 }}>
        <Header style={{ borderBottom: border, background: token.colorBgContainer, paddingInline: 16 }}>
          <TopBar project={grid?.project ?? meta?.project} />
        </Header>
        {isAppSection(section) && repoId && (
          <div
            style={{
              borderBottom: border,
              background: token.colorBgContainer,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <AppTabs />
            </div>
            {section === "config" && (
              <Segmented
                size="small"
                value={configView}
                onChange={(v) => setConfigView(v as "table" | "exported")}
                options={[
                  { value: "table", label: "Table", icon: <TableOutlined /> },
                  { value: "exported", label: "Files", icon: <FolderOpenOutlined /> },
                ]}
                style={{ marginRight: 12, flexShrink: 0 }}
              />
            )}
          </div>
        )}
        <OfflineReplay />
        <ConnectionBanner />
        <Content style={{ overflow: "hidden" }}>{body()}</Content>
      </Layout>
    </Layout>
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
      <Drawer title="Parameters" placement="left" width={280} open={open} onClose={() => setOpen(false)}>
        <CategoryTree grid={grid} />
      </Drawer>
    </>
  );
}
