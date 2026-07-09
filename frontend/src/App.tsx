import { Layout, Menu, Spin, Result, Drawer, Button, Grid as AntGrid, theme as antdTheme } from "antd";
import { ApartmentOutlined } from "@ant-design/icons";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Grid as GridData } from "./api";
import { useUI } from "./store";
import NavRail from "./components/NavRail";
import TopBar from "./components/TopBar";
import CategoryTree from "./components/CategoryTree";
import ParameterGrid from "./components/ParameterGrid";
import DetailsPanel from "./components/DetailsPanel";
import ComparePanel from "./components/ComparePanel";
import PluginsView from "./components/PluginsView";

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

export default function App() {
  const { section, setSection, prefs, selectedParamId, selectParam, navCollapsed, setNavCollapsed } = useUI();
  const { token } = antdTheme.useToken();
  const screens = AntGrid.useBreakpoint();
  const wide = screens.lg !== false; // >= 992px: three-panel layout
  const gridQ = useQuery({ queryKey: ["grid"], queryFn: api.grid });
  const border = `1px solid ${token.colorBorderSecondary}`;
  const panelBg = { background: token.colorBgContainer };

  function editorLayout() {
    const grid = gridQ.data!;
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
          <CategoryTree categories={grid.categories} total={grid.rows.length} />
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
    if (gridQ.isLoading) return <Spin style={{ margin: 60 }} />;
    if (gridQ.isError || !gridQ.data)
      return (
        <Result
          status="warning"
          title="Could not load the grid"
          subTitle="Is the backend running on :8080? Start it with `go run ./cmd/configer` in backend/."
        />
      );
    const grid = gridQ.data;

    if (section === "plugins") return <PluginsView />;
    if (section === "compare")
      return (
        <div style={{ height: "100%", ...panelBg }}>
          <ComparePanel grid={grid} />
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
          <TopBar project={gridQ.data?.project} />
        </Header>
        <Menu
          mode="horizontal"
          selectedKeys={[section]}
          onClick={({ key }) => setSection(key)}
          items={topTabs}
          style={{ borderBottom: border, paddingInline: 12, minWidth: 0, flexShrink: 0 }}
        />
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
        <CategoryTree categories={grid.categories} total={grid.rows.length} />
      </Drawer>
    </>
  );
}
