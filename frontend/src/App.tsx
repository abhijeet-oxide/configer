import { Layout, Menu, Result, Drawer, Button, Alert, Grid as AntGrid, App as AntApp, theme as antdTheme } from "antd";
import {
  ApartmentOutlined,
  HomeOutlined,
  TableOutlined,
  PullRequestOutlined,
  CheckCircleOutlined,
  CloudSyncOutlined,
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
import DashboardView from "./components/DashboardView";
import ImportWizard from "./components/ImportWizard";
import RepoChangesView from "./components/RepoChangesView";
import WorkspaceView from "./components/WorkspaceView";
import RenderedFilesView from "./components/RenderedFilesView";
import MobileParamList from "./components/MobileParamList";
import { DashboardSkeleton, GridSkeleton, ListSkeleton } from "./components/Skeletons";

const { Header, Sider, Content } = Layout;

// Horizontal sub-nav under the header, mirroring the reference tabs.
const topTabs = [
  { key: "config", label: "Config Editor" },
  { key: "compare", label: "Compare" },
  { key: "changes", label: "Change Requests" },
  { key: "history", label: "History" },
  { key: "schemas", label: "Schemas" },
  { key: "validation", label: "Validation" },
  { key: "deployments", label: "Deployments" },
  { key: "audit", label: "Audit" },
];

function ResizeHandleV() {
  return <PanelResizeHandle className="rrp-handle rrp-handle-v" />;
}
function ResizeHandleH() {
  return <PanelResizeHandle className="rrp-handle rrp-handle-h" />;
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
  const { section, setSection, prefs, selectedParamId, selectParam, navCollapsed, setNavCollapsed, repoId, setRepo } =
    useUI();
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
    if (!wide) {
      // Small screens: full-width grid; groups + details slide in as drawers.
      return (
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
    }
    return (
      <PanelGroup direction="horizontal" autoSaveId="configer-main" style={{ height: "100%" }}>
        <Panel defaultSize={15} minSize={10} maxSize={30} style={{ ...panelBg }}>
          <CategoryTree grid={grid} />
        </Panel>
        <ResizeHandleV />
        <Panel defaultSize={63} minSize={40} style={{ minWidth: 0 }}>
          <PanelGroup direction="vertical" autoSaveId="configer-center">
            <Panel defaultSize={prefs.showCompare ? 70 : 100} minSize={35} style={{ ...panelBg }}>
              <ParameterGrid grid={grid} />
            </Panel>
            {prefs.showCompare && (
              <>
                <ResizeHandleH />
                <Panel defaultSize={30} minSize={12} style={{ ...panelBg }}>
                  <ComparePanel grid={grid} />
                </Panel>
              </>
            )}
          </PanelGroup>
        </Panel>
        <ResizeHandleV />
        <Panel defaultSize={22} minSize={15} maxSize={35} style={{ ...panelBg }}>
          <DetailsPanel grid={grid} />
        </Panel>
      </PanelGroup>
    );
  }

  function body() {
    // The workspace (portfolio) level does not depend on any one repo's grid,
    // so it renders even while a repository is unavailable or none exists.
    if (section === "workspace")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <WorkspaceView />
        </div>
      );
    if (gridQ.isLoading) {
      // state-aware skeletons: mirror the layout the user is waiting for
      if (section === "home") return <DashboardSkeleton />;
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

    if (section === "plugins") return <PluginsView />;
    if (section === "import")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <ImportWizard grid={grid} />
        </div>
      );
    if (section === "home")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <DashboardView grid={grid} />
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
    if (section === "files")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <RenderedFilesView grid={grid} />
        </div>
      );
    if (section === "config") return editorLayout();
    return (
      <Result
        title={topTabs.find((t) => t.key === section)?.label || section}
        subTitle="This section is part of the roadmap (see docs/PLAN.md). Config Editor, Compare, and Plugins are live."
      />
    );
  }

  // Phone tier: single column with a bottom tab bar, no side rail, no tabs row.
  if (phone) {
    const tabs = [
      { key: "home", icon: <HomeOutlined />, label: "Home" },
      { key: "config", icon: <TableOutlined />, label: "Settings" },
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
        breakpoint="xl"
        theme="light"
        style={{ borderRight: border }}
      >
        <NavRail collapsed={navCollapsed} />
      </Sider>
      <Layout style={{ minWidth: 0 }}>
        <Header style={{ borderBottom: border, background: token.colorBgContainer, paddingInline: 16 }}>
          <TopBar project={grid?.project ?? meta?.project} instances={grid?.instances} />
        </Header>
        <Menu
          mode="horizontal"
          selectedKeys={[section]}
          onClick={({ key }) => setSection(key)}
          items={topTabs}
          style={{ borderBottom: border, paddingInline: 12, minWidth: 0, flexShrink: 0 }}
        />
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
      <Drawer title="Parameter Groups" placement="left" width={280} open={open} onClose={() => setOpen(false)}>
        <CategoryTree grid={grid} />
      </Drawer>
    </>
  );
}
