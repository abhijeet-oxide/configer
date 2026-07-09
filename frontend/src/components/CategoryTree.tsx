import { Tree, Typography, Input } from "antd";
import { useMemo, useState } from "react";
import type { CategoryNode } from "../api";
import { useElementSize } from "../hooks";
import { useUI } from "../store";

// Left "Parameter Groups" panel — a virtualized tree of categories with counts
// that fills whatever height its (resizable) panel provides.
interface TreeItem {
  key: string;
  title: React.ReactNode;
  searchText: string;
  children?: TreeItem[];
}

function toTreeData(nodes: CategoryNode[]): TreeItem[] {
  return nodes.map((n) => ({
    key: n.key,
    searchText: n.title.toLowerCase(),
    title: (
      <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span>{n.title}</span>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>{n.count}</Typography.Text>
      </span>
    ),
    children: n.children?.length ? toTreeData(n.children) : undefined,
  }));
}

export default function CategoryTree({
  categories,
  total,
}: {
  categories: CategoryNode[];
  total: number;
}) {
  const { categoryKey, setCategory } = useUI();
  const [filter, setFilter] = useState("");
  const { ref, height } = useElementSize<HTMLDivElement>();

  const treeData = useMemo(
    () => [
      { key: "__all__", searchText: "all parameters", title: <b>All Parameters ({total})</b> },
      ...toTreeData(categories),
    ],
    [categories, total],
  );

  return (
    <div style={{ padding: "8px 8px 0", height: "100%", display: "flex", flexDirection: "column" }}>
      <Typography.Text strong style={{ padding: "0 4px" }}>Parameter Groups</Typography.Text>
      <Input.Search
        placeholder="Filter groups"
        size="small"
        allowClear
        style={{ margin: "8px 0" }}
        onChange={(e) => setFilter(e.target.value.toLowerCase())}
      />
      <div ref={ref} style={{ flex: 1, minHeight: 0 }}>
        <Tree<TreeItem>
          treeData={treeData}
          blockNode
          height={Math.max(height, 100)}
          virtual
          defaultExpandAll
          selectedKeys={categoryKey ? [categoryKey] : ["__all__"]}
          onSelect={(keys) => {
            const k = keys[0] as string | undefined;
            setCategory(!k || k === "__all__" ? null : k);
          }}
          filterTreeNode={filter ? (node) => node.searchText.includes(filter) : undefined}
        />
      </div>
    </div>
  );
}
