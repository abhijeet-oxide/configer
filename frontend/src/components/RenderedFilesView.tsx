import { Button, Empty, Input, Select, Space, Spin, Tag, Tooltip, Tree, Typography, App as AntApp } from "antd";
import type { DataNode } from "antd/es/tree";
import {
  FolderOpenOutlined,
  FileTextOutlined,
  CopyOutlined,
  BranchesOutlined,
  DownloadOutlined,
  StarOutlined,
  StarFilled,
  SearchOutlined,
  FileSearchOutlined,
  DiffOutlined,
} from "@ant-design/icons";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, type Grid } from "../api";
import { useUI } from "../store";

// Local language label (kept out of ../monaco so this eagerly-loaded view does
// not pull in the Monaco bundle; the heavy editor lives behind React.lazy).
function langLabel(path: string): string {
  if (path.endsWith(".xml")) return "xml";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  return "text";
}

// RenderedFilesView is the visualization of truth: a professional file explorer
// plus a Monaco viewer of exactly what Configer writes to generated/<instance>/
// on Git. The render already includes unpublished edits, so a side-by-side diff
// against the committed baseline shows, live, what your edits will change.
const MonacoFileView = lazy(() => import("./MonacoFileView"));

const DEFAULT = "__default__";
const ALL = "__all__";
const FAV_KEY = "configer.favFiles";

function loadFavs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

interface FileEntry {
  key: string; // display path (instance-prefixed in all-instances mode)
  instance: string;
  path: string; // path within generated/<instance>/
  content: string;
}

// buildTree folds display paths into a folder tree for the explorer.
function buildTree(entries: FileEntry[]): DataNode[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: string[];
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const e of entries) {
    const parts = e.key.split("/");
    let cur = root;
    for (const seg of parts.slice(0, -1)) {
      if (!cur.dirs.has(seg)) cur.dirs.set(seg, { dirs: new Map(), files: [] });
      cur = cur.dirs.get(seg)!;
    }
    cur.files.push(e.key);
  }
  const toNodes = (d: Dir, prefix: string): DataNode[] => [
    ...[...d.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]) => ({
        key: `${prefix}${name}/`,
        title: name,
        icon: <FolderOpenOutlined />,
        selectable: false,
        children: toNodes(sub, `${prefix}${name}/`),
      })),
    ...d.files
      .sort()
      .map((full) => ({
        key: full,
        title: full.split("/").pop(),
        icon: <FileTextOutlined />,
        isLeaf: true,
      })),
  ];
  return toNodes(root, "");
}

export default function RenderedFilesView({ grid }: { grid: Grid }) {
  const { message } = AntApp.useApp();
  const dark = useUI((s) => s.mode === "dark");
  const [instanceSel, setInstanceSel] = useState<string>(ALL);
  const [envFilter, setEnvFilter] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState("");
  const [findQuery, setFindQuery] = useState("");
  const [revealLine, setRevealLine] = useState<number | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [favs, setFavs] = useState<string[]>(loadFavs);
  const [ref, setRef] = useState("");

  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus });
  const refsQ = useQuery({ queryKey: ["refs"], queryFn: api.refs, staleTime: 60_000 });
  const environments = useMemo(
    () => [...new Set(grid.instances.map((i) => i.environment).filter(Boolean))] as string[],
    [grid.instances],
  );
  const allMode = instanceSel === ALL;

  // Which instances to render. Default is the first; All optionally narrows by
  // environment; otherwise the single chosen instance.
  const targets = useMemo(() => {
    if (instanceSel === DEFAULT) return grid.instances.slice(0, 1).map((i) => i.name);
    if (instanceSel === ALL)
      return grid.instances.filter((i) => !envFilter || i.environment === envFilter).map((i) => i.name);
    return [instanceSel];
  }, [instanceSel, envFilter, grid.instances]);

  // Draft-applied render for each target instance (the live preview).
  const draftQs = useQueries({
    queries: targets.map((name) => ({
      queryKey: ["render", name, ref],
      queryFn: () => api.render(name, ref ? { ref } : undefined),
      enabled: !!name,
    })),
  });
  const loading = draftQs.some((q) => q.isLoading);
  // A signature that changes on any (re)fetch, so live edits propagate.
  const sig = draftQs.map((q) => q.dataUpdatedAt).join("|");

  const entries = useMemo<FileEntry[]>(() => {
    const seen = new Set<string>();
    const out: FileEntry[] = [];
    targets.forEach((name, idx) => {
      for (const f of draftQs[idx]?.data?.files ?? []) {
        const key = allMode ? `${name}/${f.path}` : f.path;
        if (seen.has(key)) continue; // dedupe: never show a file twice
        seen.add(key);
        out.push({ key, instance: name, path: f.path, content: f.content });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, allMode, sig]);

  const filtered = useMemo(
    () => (filter ? entries.filter((e) => e.key.toLowerCase().includes(filter.toLowerCase())) : entries),
    [entries, filter],
  );
  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const expandedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const e of filtered) {
      const parts = e.key.split("/");
      let p = "";
      for (const seg of parts.slice(0, -1)) {
        p += seg + "/";
        keys.add(p);
      }
    }
    return [...keys];
  }, [filtered]);

  // Keep a sensible selection as the file set changes.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !filtered.some((e) => e.key === selected)) setSelected(filtered[0].key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  const current = entries.find((e) => e.key === selected);

  // Committed baseline for the selected file's instance, for the live diff.
  // The committed-vs-draft diff only applies to the working tree; when viewing a
  // historical ref we just show that ref's content.
  const committedQ = useQuery({
    queryKey: ["render", current?.instance, "committed"],
    queryFn: () => api.render(current!.instance, { draft: false }),
    enabled: !!current && ref === "",
  });
  const committed = committedQ.data?.files.find((f) => f.path === current?.path)?.content;
  const hasDiff = current !== undefined && committed !== undefined && committed !== current.content;

  // Find in files: scan every loaded file's content for the term.
  const hits = useMemo(() => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return [];
    const res: { key: string; line: number; text: string }[] = [];
    for (const e of entries) {
      const lines = e.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          res.push({ key: e.key, line: i + 1, text: lines[i].trim().slice(0, 120) });
          if (res.length >= 300) return res;
        }
      }
    }
    return res;
  }, [entries, findQuery]);

  const favSet = new Set(favs);
  const favEntries = entries.filter((e) => favSet.has(e.key));
  const toggleFav = (key: string) =>
    setFavs((f) => {
      const next = f.includes(key) ? f.filter((x) => x !== key) : [...f, key];
      localStorage.setItem(FAV_KEY, JSON.stringify(next));
      return next;
    });

  const copy = async () => {
    if (!current) return;
    await navigator.clipboard.writeText(current.content);
    message.success("File content copied");
  };
  const download = () => {
    if (!current) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([current.content], { type: "text/plain" }));
    a.download = current.path.split("/").pop() ?? "config.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const instanceOptions = [
    { value: DEFAULT, label: "Default (first instance)" },
    { value: ALL, label: "All instances" },
    {
      label: "Instances",
      options: grid.instances.map((i) => ({
        value: i.name,
        label: (
          <span>
            {i.name}
            <span style={{ opacity: 0.5, fontSize: 12, marginInlineStart: 8 }}>{i.environment}</span>
          </span>
        ),
      })),
    },
  ];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "16px 20px", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Rendered Files
          </Typography.Title>
          <Typography.Text type="secondary">
            The exact files written to <code>generated/&lt;instance&gt;/</code> on Git.{" "}
            {statusQ.data?.branch && (
              <>
                Branch <Tag icon={<BranchesOutlined />} className="mono" style={{ marginInlineStart: 2 }}>{statusQ.data.branch}</Tag>,
                reflecting your unpublished edits.
              </>
            )}
          </Typography.Text>
        </div>
        <Space>
          <Select
            style={{ width: 190 }}
            value={ref}
            onChange={(v) => setRef(v)}
            suffixIcon={<BranchesOutlined />}
            options={[
              { value: "", label: "Working tree (current)" },
              ...(refsQ.data?.branches?.length
                ? [{ label: "Branches", options: refsQ.data.branches.map((b) => ({ value: b, label: b })) }]
                : []),
              ...(refsQ.data?.tags?.length
                ? [{ label: "Tags", options: refsQ.data.tags.map((t) => ({ value: t, label: t })) }]
                : []),
            ]}
          />
          {allMode && environments.length > 1 && (
            <Select
              style={{ width: 150 }}
              allowClear
              placeholder="All environments"
              value={envFilter}
              onChange={(v) => setEnvFilter(v)}
              options={environments.map((e) => ({ value: e, label: e }))}
            />
          )}
          <Select
            style={{ width: 260 }}
            value={instanceSel}
            onChange={(v) => setInstanceSel(v)}
            showSearch
            optionFilterProp="value"
            filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            options={instanceOptions}
          />
        </Space>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
          <Spin />
        </div>
      ) : entries.length === 0 ? (
        <Empty
          style={{ marginTop: 60 }}
          description="Nothing renders here yet. Import parameters or attach design-phase ones to a file."
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 14 }}>
          <div style={{ width: 300, display: "flex", flexDirection: "column", flexShrink: 0, minHeight: 0 }}>
            <Input
              size="small"
              allowClear
              prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
              placeholder="Filter files"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <Input
              size="small"
              allowClear
              prefix={<FileSearchOutlined style={{ opacity: 0.5 }} />}
              placeholder="Find in files"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            {findQuery.trim() ? (
              <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: 0.4 }}>
                  {hits.length} MATCH{hits.length === 1 ? "" : "ES"}
                </Typography.Text>
                <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 1 }}>
                  {hits.map((h, i) => (
                    <div
                      key={`${h.key}:${h.line}:${i}`}
                      className="card-clickable"
                      onClick={() => {
                        setSelected(h.key);
                        setRevealLine(h.line);
                      }}
                      style={{ cursor: "pointer", fontSize: 12, padding: "3px 4px", borderRadius: 4 }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                        <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {h.key.split("/").pop()}
                        </span>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>:{h.line}</Typography.Text>
                      </div>
                      <div className="mono" style={{ fontSize: 11, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {h.text}
                      </div>
                    </div>
                  ))}
                  {hits.length === 0 && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>No matches in the loaded files.</Typography.Text>
                  )}
                </div>
              </div>
            ) : (
              <>
            {favEntries.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: 0.4 }}>
                  FAVORITES
                </Typography.Text>
                <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
                  {favEntries.map((e) => (
                    <div
                      key={e.key}
                      className="card-clickable"
                      onClick={() => setSelected(e.key)}
                      style={{
                        display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                        fontSize: 12, padding: "2px 4px", borderRadius: 4,
                        background: selected === e.key ? "rgba(47,107,255,0.12)" : undefined,
                      }}
                    >
                      <StarFilled style={{ color: "#f5b301", fontSize: 12 }} />
                      <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {e.key}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              <Tree.DirectoryTree
                treeData={tree}
                expandedKeys={expandedKeys}
                selectedKeys={selected ? [selected] : []}
                onSelect={(keys) => {
                  const k = keys[0] as string | undefined;
                  if (k && !k.endsWith("/")) {
                    setSelected(k);
                    setRevealLine(undefined);
                  }
                }}
              />
            </div>
              </>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {current ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Tag icon={<BranchesOutlined />} className="mono">
                    generated/{current.instance}/{current.path}
                  </Tag>
                  <Tag>{langLabel(current.path)}</Tag>
                  <Tag>{current.content.split("\n").length} lines</Tag>
                  {hasDiff && (
                    <Tag icon={<DiffOutlined />} color="orange">
                      pending changes vs committed
                    </Tag>
                  )}
                  <div style={{ flex: 1 }} />
                  <Tooltip title={favSet.has(current.key) ? "Remove from favorites" : "Add to favorites"}>
                    <Button
                      size="small"
                      type="text"
                      icon={favSet.has(current.key) ? <StarFilled style={{ color: "#f5b301" }} /> : <StarOutlined />}
                      onClick={() => toggleFav(current.key)}
                    />
                  </Tooltip>
                  <Button size="small" icon={<CopyOutlined />} onClick={copy}>
                    Copy
                  </Button>
                  <Button size="small" icon={<DownloadOutlined />} onClick={download}>
                    Download
                  </Button>
                </div>
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    borderRadius: 8,
                    overflow: "hidden",
                    border: "1px solid rgba(128,128,128,0.25)",
                  }}
                >
                  <Suspense fallback={<div style={{ height: "100%", display: "grid", placeItems: "center" }}><Spin /></div>}>
                    <MonacoFileView
                      key={current.key}
                      path={current.path}
                      content={current.content}
                      original={hasDiff ? committed : undefined}
                      dark={dark}
                      revealLine={revealLine}
                    />
                  </Suspense>
                </div>
              </>
            ) : (
              <Empty description="Select a file" style={{ marginTop: 60 }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
