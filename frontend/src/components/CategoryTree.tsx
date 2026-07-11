import { Tree, Typography, Input } from "antd";
import { useMemo, useState } from "react";
import type { CategoryNode, Grid } from "../api";
import { useElementSize } from "../hooks";
import { useUI } from "../store";

// Left panel: two linked trees.
// "Parameter Groups" holds the category hierarchy with each parameter as a
// clickable leaf (click scrolls the grid to that row and flashes it).
// "Systems" groups instances by environment; clicking one scrolls the grid
// horizontally to that column and flashes its header.

interface TreeItem {
  key: string;
  title: React.ReactNode;
  searchText: string;
  isLeaf?: boolean;
  children?: TreeItem[];
}

const envDot: Record<string, string> = {
  production: "#f5222d",
  staging: "#fa8c16",
  development: "#52c41a",
};

export default function CategoryTree({ grid }: { grid: Grid }) {
  const { categoryKey, setCategory, selectParam, selectInstance, setJump } = useUI();
  const [filter, setFilter] = useState("");
  const { ref, height } = useElementSize<HTMLDivElement>();

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
          <span style={{ width: 7, height: 7, borderRadius: 4, background: envDot[env] ?? "#8c8c8c" }} />
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
  }, [grid.instances]);

  return (
    <div className="cat-tree" style={{ padding: "8px 8px 0", height: "100%", display: "flex", flexDirection: "column" }}>
      <Typography.Text strong style={{ padding: "0 4px" }}>Parameter Groups</Typography.Text>
      <Input.Search
        placeholder="Filter groups and parameters"
        size="small"
        allowClear
        style={{ margin: "8px 0" }}
        onChange={(e) => setFilter(e.target.value.toLowerCase())}
      />
      <div ref={ref} style={{ flex: 1.7, minHeight: 0 }}>
        <Tree<TreeItem>
          treeData={treeData}
          blockNode
          showLine={{ showLeafIcon: false }}
          height={Math.max(height, 100)}
          virtual
          defaultExpandAll
          selectedKeys={categoryKey ? [categoryKey] : ["__all__"]}
          onSelect={(keys) => {
            const k = keys[0] as string | undefined;
            if (!k) return;
            if (k.startsWith("p:")) {
              // parameter leaf: show its group, scroll to the row, highlight
              const [id, cat] = k.slice(2).split("|");
              setCategory(cat);
              selectParam(id);
              setJump("param", id);
              return;
            }
            setCategory(k === "__all__" ? null : k);
          }}
          filterTreeNode={filter ? (node) => node.searchText.includes(filter) : undefined}
        />
      </div>
      <Typography.Text strong style={{ padding: "10px 4px 6px", borderTop: "1px solid rgba(127,137,160,0.2)" }}>
        Systems
      </Typography.Text>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 6 }}>
        <Tree
          treeData={systemsData}
          blockNode
          showLine={{ showLeafIcon: false }}
          defaultExpandAll
          selectedKeys={[]}
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
  );
}
