import { Tree, Typography, Input } from "antd";
import { useMemo, useState } from "react";
import type { CategoryNode } from "../api";
import { useUI } from "../store";

// Left "Parameter Groups" panel — a virtualized tree of categories with counts.
function toTreeData(nodes: CategoryNode[]): any[] {
  return nodes.map((n) => ({
    key: n.key,
    title: (
      <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span>{n.title}</span>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>{n.count}</Typography.Text>
      </span>
    ),
    children: n.children ? toTreeData(n.children) : undefined,
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
  const treeData = useMemo(
    () => [
      { key: "__all__", title: <b>All Parameters ({total})</b> },
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
        style={{ margin: "8px 0" }}
        onChange={(e) => setFilter(e.target.value.toLowerCase())}
      />
      <div style={{ flex: 1, overflow: "auto" }}>
        <Tree
          treeData={treeData}
          blockNode
          height={600}
          virtual
          defaultExpandAll
          selectedKeys={categoryKey ? [categoryKey] : ["__all__"]}
          onSelect={(keys) => {
            const k = keys[0] as string | undefined;
            setCategory(!k || k === "__all__" ? null : k);
          }}
          filterTreeNode={
            filter
              ? (node: any) =>
                  String((node.title as any)?.props?.children?.[0]?.props?.children ?? "")
                    .toLowerCase()
                    .includes(filter)
              : undefined
          }
        />
      </div>
    </div>
  );
}
