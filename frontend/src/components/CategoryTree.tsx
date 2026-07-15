import { Button, Tooltip, Tree, Typography, Input, type GetRef } from "antd";
import { DownOutlined, UpOutlined } from "@ant-design/icons";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CategoryNode, Grid } from "../api";
import { useElementSize } from "../hooks";
import { useUI } from "../store";
import { envHex } from "../theme";

// Left panel: two linked trees in resizable, collapsible panes (sizes are
// remembered across sessions).
// "Parameter Groups" holds the category hierarchy with each parameter as a
// clickable leaf; selecting one scrolls the grid to that row and, in reverse,
// selecting a grid row reveals and highlights the leaf here.
// "Systems" groups instances by environment; clicking one scrolls the grid
// horizontally to that column, and selecting a grid column highlights it here.

interface TreeItem {
  key: string;
  title: React.ReactNode;
  searchText: string;
  isLeaf?: boolean;
  children?: TreeItem[];
}

// All ancestor category keys of a slash-delimited category path, so revealing a
// leaf can expand exactly the branches that contain it.
function ancestorKeys(category: string): string[] {
  const parts = category.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export default function CategoryTree({ grid }: { grid: Grid }) {
  const { categoryKey, setCategory, selectParam, selectedParamId, selectInstance, selectedInstance, setJump, panels, togglePanel } = useUI();
  const [filter, setFilter] = useState("");
  const { ref, height } = useElementSize<HTMLDivElement>();
  const treeRef = useRef<GetRef<typeof Tree>>(null);
  const systemsRef = useRef<ImperativePanelHandle>(null);

  // Drive the Systems pane from the shared panel state, so the header chevron
  // and the ⌘J shortcut collapse/expand the same pane in step.
  useEffect(() => {
    const p = systemsRef.current;
    if (!p) return;
    if (panels.systems && p.isCollapsed()) p.expand();
    else if (!panels.systems && p.isExpanded()) p.collapse();
  }, [panels.systems]);

  // params per exact category, used to attach leaves under their group node
  const paramsByCat = useMemo(() => {
    const m = new Map<string, { id: string; name: string; category: string }[]>();
    for (const r of grid.rows) {
      const c = r.param.category || "Uncategorized";
      const arr = m.get(c) ?? [];
      arr.push({ id: r.param.id, name: r.param.name, category: c });
      m.set(c, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [grid.rows]);

  // paramId -> category, so a grid-row selection can locate its tree leaf.
  const paramCat = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of grid.rows) m.set(r.param.id, r.param.category || "Uncategorized");
    return m;
  }, [grid.rows]);

  // Every category key (recursively), used to expand-all by default while
  // keeping expandedKeys controlled so we can reveal a leaf on demand.
  const allCatKeys = useMemo(() => {
    const keys: string[] = [];
    const walk = (nodes: CategoryNode[]) => {
      for (const n of nodes) {
        keys.push(n.key);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(grid.categories);
    return keys;
  }, [grid.categories]);

  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>(allCatKeys);
  // Keep the expand-all default in sync if the catalog's categories change.
  useEffect(() => setExpandedKeys((prev) => Array.from(new Set([...prev, ...allCatKeys]))), [allCatKeys]);

  const treeData = useMemo(() => {
    const toItems = (nodes: CategoryNode[]): TreeItem[] =>
      nodes.map((n) => {
        const children = [
          ...(n.children?.length ? toItems(n.children) : []),
          ...(paramsByCat.get(n.key) ?? []).map((p) => ({
            key: `p:${p.id}|${p.category}`,
            isLeaf: true,
            searchText: p.name.toLowerCase(),
            title: (
              <Typography.Text style={{ fontSize: 12 }} className="mono" ellipsis>
                {p.name}
              </Typography.Text>
            ),
          })),
        ];
        return {
          key: n.key,
          searchText: n.title.toLowerCase(),
          title: (
            <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>{n.title}</span>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>{n.count}</Typography.Text>
            </span>
          ),
          children: children.length ? children : undefined,
        };
      });
    return [
      { key: "__all__", searchText: "all parameters", title: <b>All Parameters ({grid.rows.length})</b> },
      ...toItems(grid.categories),
    ];
  }, [grid.categories, grid.rows.length, paramsByCat]);

  // Reverse sync: when a parameter becomes selected (typically by clicking a
  // grid row), reveal and scroll to its leaf here.
  const leafKey = selectedParamId ? `p:${selectedParamId}|${paramCat.get(selectedParamId) ?? ""}` : null;
  useEffect(() => {
    if (!selectedParamId) return;
    const cat = paramCat.get(selectedParamId);
    if (!cat) return;
    setExpandedKeys((prev) => Array.from(new Set([...prev, ...ancestorKeys(cat)])));
    // Let the expansion render before scrolling to the (now visible) leaf.
    const t = setTimeout(() => treeRef.current?.scrollTo({ key: `p:${selectedParamId}|${cat}` }), 60);
    return () => clearTimeout(t);
  }, [selectedParamId, paramCat]);

  // Systems tree: environment -> instances.
  const systemsData = useMemo(() => {
    const byEnv = new Map<string, typeof grid.instances>();
    for (const i of grid.instances) {
      const e = i.environment || "other";
      byEnv.set(e, [...(byEnv.get(e) ?? []), i]);
    }
    return [...byEnv.entries()].map(([env, insts]) => ({
      key: `env:${env}`,
      searchText: env,
      selectable: false,
      title: (
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: envHex(env) }} />
          <span style={{ textTransform: "capitalize" }}>{env}</span>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>{insts.length}</Typography.Text>
        </span>
      ),
      children: insts.map((i) => ({
        key: `i:${i.name}`,
        isLeaf: true,
        searchText: i.name.toLowerCase(),
        title: (
          <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 12 }}>{i.name}</span>
            <Typography.Text type="secondary" style={{ fontSize: 10 }}>{i.softwareVersion}</Typography.Text>
          </span>
        ),
      })),
    }));
  }, [grid]);

  return (
    <div className="cat-tree" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <PanelGroup direction="vertical" autoSaveId="configer-cattree-v2" style={{ height: "100%" }}>
        <Panel defaultSize={72} minSize={15} collapsible collapsedSize={6}>
          <div style={{ padding: "8px 8px 0", height: "100%", display: "flex", flexDirection: "column" }}>
            <Typography.Text strong style={{ padding: "0 4px" }}>Parameters</Typography.Text>
            <Input.Search
              placeholder="Filter groups and parameters"
              size="small"
              allowClear
              style={{ margin: "8px 0" }}
              onChange={(e) => setFilter(e.target.value.toLowerCase())}
            />
            <div ref={ref} style={{ flex: 1, minHeight: 0 }}>
              <Tree<TreeItem>
                ref={treeRef}
                treeData={treeData}
                blockNode
                showLine={{ showLeafIcon: false }}
                height={Math.max(height, 100)}
                virtual
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys)}
                selectedKeys={leafKey ? [leafKey] : categoryKey ? [categoryKey] : ["__all__"]}
                onSelect={(keys) => {
                  const k = keys[0] as string | undefined;
                  if (!k) return;
                  if (k.startsWith("p:")) {
                    // Parameter leaf: the grid keeps showing everything — just
                    // scroll to the row and flash it. Only when an active
                    // category filter would hide the row is the filter cleared
                    // (never narrowed) so the jump can land.
                    const [id, cat] = k.slice(2).split("|");
                    if (categoryKey && cat !== categoryKey && !cat.startsWith(categoryKey + "/"))
                      setCategory(null);
                    selectParam(id);
                    setJump("param", id);
                    return;
                  }
                  setCategory(k === "__all__" ? null : k);
                }}
                filterTreeNode={filter ? (node) => node.searchText.includes(filter) : undefined}
              />
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="rrp-handle rrp-handle-h" />
        <Panel
          ref={systemsRef}
          defaultSize={28}
          minSize={8}
          collapsible
          collapsedSize={5}
          onCollapse={() => panels.systems && togglePanel("systems")}
          onExpand={() => !panels.systems && togglePanel("systems")}
        >
          <div style={{ padding: "0 8px 6px", height: "100%", display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 4px 6px",
                borderTop: "1px solid rgba(127,137,160,0.2)",
              }}
            >
              <Typography.Text strong>Systems</Typography.Text>
              <Tooltip title={panels.systems ? "Collapse systems (⌘J)" : "Expand systems (⌘J)"}>
                <Button
                  size="small"
                  type="text"
                  icon={panels.systems ? <DownOutlined /> : <UpOutlined />}
                  onClick={() => togglePanel("systems")}
                  style={{ opacity: 0.6 }}
                  aria-label="Toggle systems pane"
                />
              </Tooltip>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 6 }}>
              <Tree
                treeData={systemsData}
                blockNode
                showLine={{ showLeafIcon: false }}
                defaultExpandAll
                selectedKeys={selectedInstance ? [`i:${selectedInstance}`] : []}
                onSelect={(keys) => {
                  const k = keys[0] as string | undefined;
                  if (k?.startsWith("i:")) {
                    const name = k.slice(2);
                    setJump("instance", name);
                    selectInstance(name);
                  }
                }}
                filterTreeNode={filter ? (node) => (node as unknown as TreeItem).searchText?.includes(filter) : undefined}
              />
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
