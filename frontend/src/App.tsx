import { Layout, Menu, Spin, Result, theme as antdTheme } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
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

export default function App() {
  const { section, setSection } = useUI();
  const { token } = antdTheme.useToken();
  const gridQ = useQuery({ queryKey: ["grid"], queryFn: api.grid });

  const border = `1px solid ${token.colorBorderSecondary}`;

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
      return <div style={{ height: "100%" }}><ComparePanel grid={grid} /></div>;
    if (section === "config") {
      return (
        <div style={{ display: "flex", height: "100%" }}>
          <div style={{ width: 250, borderRight: border, background: token.colorBgContainer }}>
            <CategoryTree categories={grid.categories} total={grid.rows.length} />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ flex: 1, minHeight: 0, background: token.colorBgContainer }}>
              <ParameterGrid grid={grid} />
            </div>
            <div style={{ height: 280, borderTop: border, background: token.colorBgContainer }}>
              <ComparePanel grid={grid} />
            </div>
          </div>
          <div style={{ width: 340, borderLeft: border, background: token.colorBgContainer }}>
            <DetailsPanel grid={grid} />
          </div>
        </div>
      );
    }
    return (
      <Result
        title={topTabs.find((t) => t.key === section)?.label || section}
        subTitle="This section is part of the roadmap (see the design plan). The Config Editor, Compare, and Plugins views are live."
      />
    );
  }

  return (
    <Layout style={{ height: "100vh" }}>
      <Sider width={210} theme="light" style={{ borderRight: border }}>
        <NavRail />
      </Sider>
      <Layout>
        <Header style={{ borderBottom: border, background: token.colorBgContainer, paddingInline: 16 }}>
          <TopBar project={gridQ.data?.project} />
        </Header>
        <Menu
          mode="horizontal"
          selectedKeys={[section]}
          onClick={({ key }) => setSection(key)}
          items={topTabs}
          style={{ borderBottom: border, paddingInline: 12 }}
        />
        <Content style={{ overflow: "hidden" }}>{body()}</Content>
      </Layout>
    </Layout>
  );
}
