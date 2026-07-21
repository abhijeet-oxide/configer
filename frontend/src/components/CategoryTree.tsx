import { Checkbox, Tooltip, Tree, Typography, Input, type GetRef } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Grid } from "../api";
import { useElementSize } from "../hooks";
import { useUI } from "../store";

// Left panel: the single Parameters tree, so it alone flanks the matrix (the
// hero). It holds the parameter NAME hierarchy - a dotted name like
// admin.rebuildslave.failretryInterval nests as admin › rebuildslave ›
// failretryInterval, with each parameter a clickable leaf. Selecting one
// scrolls the grid to that row; selecting a group filters to that name prefix;
// and in reverse, selecting a grid row reveals its leaf here. Instance columns
// are steered from the grid itself (click a header, or the column manager),
// not a second tree.

interface TreeItem {
  key: string;
  title: React.ReactNode;
  searchText: string;
  isLeaf?: boolean;
  children?: TreeItem[];
}

// A node in the parameter-name trie.
interface NameNode {
  seg: string;
  prefix: string; // full dotted prefix, e.g. "admin.rebuildslave"
  count: number; // parameters in this subtree
  params: { id: string; name: string; leaf: string }[];
  children: Map<string, NameNode>;
}

// All intermediate dotted prefixes of a name, so revealing a leaf can expand
// exactly the branches that contain it (admin.rebuildslave.x -> [admin,
// admin.rebuildslave]).
function ancestorPrefixes(name: string): string[] {
  const parts = name.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(0, i + 1).join("."));
  return out;
}

export default function CategoryTree({ grid }: { grid: Grid }) {
  const { categoryKey, setCategory, selectParam, selectedParamId, setJump } = useUI();
  const [filter, setFilter] = useState("");
  const [showFull, setShowFull] = useState(false);
  const { ref, height } = useElementSize<HTMLDivElement>();
  const treeRef = useRef<GetRef<typeof Tree>>(null);

  // Build the name trie: split each parameter name on "." into nested groups.
  const nameRoot = useMemo(() => {
    const root: NameNode = { seg: "", prefix: "", count: 0, params: [], children: new Map() };
    for (const r of grid.rows) {
      const name = r.param.name;
      const parts = name.split(".");
      const leaf = parts[parts.length - 1];
      let level = root;
      let prefix = "";
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        prefix = prefix ? `${prefix}.${seg}` : seg;
        let node = level.children.get(seg);
        if (!node) {
          node = { seg, prefix, count: 0, params: [], children: new Map() };
          level.children.set(seg, node);
        }
        node.count++;
        level = node;
      }
      level.params.push({ id: r.param.id, name, leaf });
    }
    return root;
  }, [grid.rows]);

  // Every group prefix, for expand-all by default.
  const allNameKeys = useMemo(() => {
    const keys: string[] = [];
    const walk = (n: NameNode) => {
      for (const c of n.children.values()) {
        keys.push(c.prefix);
        walk(c);
      }
    };
    walk(nameRoot);
    return keys;
  }, [nameRoot]);

  const paramName = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of grid.rows) m.set(r.param.id, r.param.name);
    return m;
  }, [grid.rows]);

  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>(allNameKeys);
  // Keep the expand-all default in sync if the catalog changes.
  useEffect(() => setExpandedKeys((prev) => Array.from(new Set([...prev, ...allNameKeys]))), [allNameKeys]);

  const treeData = useMemo(() => {
    // A node's children (sub-groups AND its own leaf params) are ordered by
    // segment together, so the tree reads in the same order as the grid table
    // (which sorts by full name).
    const toItems = (node: NameNode): TreeItem[] => {
      const entries: { seg: string; item: TreeItem }[] = [];
      for (const c of node.children.values()) {
        entries.push({
          seg: c.seg,
          item: {
            key: c.prefix,
            searchText: c.prefix.toLowerCase(),
            title: (
              <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>{c.seg}</span>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>{c.count}</Typography.Text>
              </span>
            ),
            children: toItems(c),
          },
        });
      }
      for (const p of node.params) {
        entries.push({
          seg: p.leaf,
          item: {
            key: `p:${p.id}`,
            isLeaf: true,
            searchText: p.name.toLowerCase(),
            title: (
              <Tooltip title={p.name} placement="right">
                <Typography.Text style={{ fontSize: 12 }} className="mono" ellipsis>
                  {showFull ? p.name : p.leaf}
                </Typography.Text>
              </Tooltip>
            ),
          },
        });
      }
      entries.sort((a, b) => a.seg.localeCompare(b.seg));
      return entries.map((e) => e.item);
    };
    return [
      { key: "__all__", searchText: "all parameters", title: <b>All Parameters ({grid.rows.length})</b> },
      ...toItems(nameRoot),
    ];
  }, [nameRoot, grid.rows.length, showFull]);

  // Reverse sync: when a parameter becomes selected (typically by clicking a
  // grid row), reveal and scroll to its leaf here.
  const leafKey = selectedParamId ? `p:${selectedParamId}` : null;
  useEffect(() => {
    if (!selectedParamId) return;
    const name = paramName.get(selectedParamId);
    if (!name) return;
    setExpandedKeys((prev) => Array.from(new Set([...prev, ...ancestorPrefixes(name)])));
    const t = setTimeout(() => treeRef.current?.scrollTo({ key: `p:${selectedParamId}` }), 60);
    return () => clearTimeout(t);
  }, [selectedParamId, paramName]);

  return (
    <div className="cat-tree" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "8px 8px 0", height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 4px" }}>
          <Typography.Text strong>Parameters</Typography.Text>
          <Tooltip title="Show each parameter's full dotted name instead of just the last segment">
            <Checkbox checked={showFull} onChange={(e) => setShowFull(e.target.checked)} style={{ fontSize: 11 }}>
              <span style={{ fontSize: 11 }}>Full names</span>
            </Checkbox>
          </Tooltip>
        </div>
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
                // Parameter leaf: the grid keeps showing everything - just
                // scroll to the row and flash it. Only when an active name
                // filter would hide the row is the filter cleared (never
                // narrowed) so the jump can land.
                const id = k.slice(2);
                const name = paramName.get(id) ?? "";
                if (categoryKey && name !== categoryKey && !name.startsWith(categoryKey + "."))
                  setCategory(null);
                selectParam(id);
                setJump("param", id);
                return;
              }
              // A group node filters the grid to that name prefix. It also
              // clears the parameter selection: "All Parameters" (or any
              // category) means the whole view again, so the ?param=
              // refinement must leave the URL too.
              setCategory(k === "__all__" ? null : k);
              selectParam(null);
            }}
            filterTreeNode={filter ? (node) => node.searchText.includes(filter) : undefined}
          />
        </div>
      </div>
    </div>
  );
}
