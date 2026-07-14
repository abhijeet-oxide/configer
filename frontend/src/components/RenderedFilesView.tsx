import { Button, Empty, Select, Tag, Tree, Typography, App as AntApp } from "antd";
import type { DataNode } from "antd/es/tree";
import {
  FolderOpenOutlined,
  FileTextOutlined,
  CopyOutlined,
  BranchesOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Grid } from "../api";
import { FilesSkeleton } from "./Skeletons";

// RenderedFilesView is the visualization of truth: for one instance, a file
// explorer of exactly what Configer writes to generated/<instance>/ on Git
// after publish, byte for byte, including transposer-generated artifacts.
// Users see the final configuration as their systems will consume it.

interface RFile {
  path: string;
  content: string;
}

// changedMark renders a file name with a VS Code-style "modified" marker (an
// M and the accent colour) when the file carries active, uncommitted changes.
function changedMark(name: string, changed: boolean): React.ReactNode {
  if (!changed) return name;
  return (
    <span style={{ color: "#d98a00", fontWeight: 600 }}>
      {name}
      <span style={{ marginInlineStart: 6, fontSize: 11 }}>M</span>
    </span>
  );
}

// buildTree folds flat file paths into a folder tree for the explorer. Files in
// `changed` (matched by full path or basename) are flagged as modified, and a
// folder that contains any modified file is flagged too, mirroring how an
// editor surfaces pending changes up the tree.
function buildTree(files: RFile[], changed: Set<string>): DataNode[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: string[]; // full paths
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    for (const seg of parts.slice(0, -1)) {
      if (!cur.dirs.has(seg)) cur.dirs.set(seg, { dirs: new Map(), files: [] });
      cur = cur.dirs.get(seg)!;
    }
    cur.files.push(f.path);
  }
  const isChanged = (full: string) =>
    changed.has(full) || changed.has(full.split("/").pop() ?? full);
  const toNodes = (d: Dir, prefix: string): [DataNode[], boolean] => {
    let anyChanged = false;
    const dirNodes = [...d.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]) => {
        const [children, subChanged] = toNodes(sub, `${prefix}${name}/`);
        anyChanged = anyChanged || subChanged;
        return {
          key: `${prefix}${name}/`,
          title: changedMark(name, subChanged),
          icon: <FolderOpenOutlined />,
          selectable: false,
          children,
        };
      });
    const fileNodes = d.files.sort().map((full) => {
      const ch = isChanged(full);
      anyChanged = anyChanged || ch;
      return {
        key: full,
        title: changedMark(full.split("/").pop() ?? full, ch),
        icon: <FileTextOutlined />,
        isLeaf: true,
      };
    });
    return [[...dirNodes, ...fileNodes], anyChanged];
  };
  return toNodes(root, "")[0];
}

function langOf(path: string): string {
  if (path.endsWith(".xml")) return "xml";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  return "text";
}

export default function RenderedFilesView({ grid }: { grid: Grid }) {
  const { message } = AntApp.useApp();
  const [instance, setInstance] = useState<string | null>(grid.instances[0]?.name ?? null);
  const [selected, setSelected] = useState<string | null>(null);

  const renderQ = useQuery({
    queryKey: ["render", instance],
    queryFn: () => api.render(instance!),
    enabled: !!instance,
  });
  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus, refetchInterval: 20_000 });
  const files = useMemo(() => renderQ.data?.files ?? [], [renderQ.data]);

  // Which files this instance's active (uncommitted) edits touch: map each
  // pending change to the source file of its parameter. Global-scope edits
  // affect every instance, so they count for whichever instance is shown.
  const changedFiles = useMemo(() => {
    const fileOf = new Map(grid.rows.map((r) => [r.param.id, r.param.source?.file ?? ""]));
    const s = new Set<string>();
    for (const it of draftQ.data?.draft?.items ?? []) {
      if (it.scope === "global" || it.instance === instance) {
        const f = fileOf.get(it.paramId);
        if (!f) continue;
        // Rendered paths (e.g. "values.yaml") are the basenames of source
        // paths (e.g. "base/values.yaml"); record both so the tree marker
        // matches regardless of which form a node carries.
        s.add(f);
        s.add(f.split("/").pop() ?? f);
      }
    }
    return s;
  }, [draftQ.data, grid.rows, instance]);
  const changeCount = useMemo(
    () =>
      (draftQ.data?.draft?.items ?? []).filter((it) => it.scope === "global" || it.instance === instance).length,
    [draftQ.data, instance],
  );
  // Distinct source files touched by this instance's active changes.
  const modifiedFileCount = useMemo(() => {
    const fileOf = new Map(grid.rows.map((r) => [r.param.id, r.param.source?.file ?? ""]));
    const s = new Set<string>();
    for (const it of draftQ.data?.draft?.items ?? []) {
      if (it.scope === "global" || it.instance === instance) {
        const f = fileOf.get(it.paramId);
        if (f) s.add(f);
      }
    }
    return s.size;
  }, [draftQ.data, grid.rows, instance]);
  const tree = useMemo(() => buildTree(files, changedFiles), [files, changedFiles]);

  // Keep a sensible selection when the instance changes or files load.
  useEffect(() => {
    if (files.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !files.some((f) => f.path === selected)) setSelected(files[0].path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const current = files.find((f) => f.path === selected);
  const allDirs = useMemo(() => {
    const keys = new Set<string>();
    for (const f of files) {
      const parts = f.path.split("/");
      let p = "";
      for (const seg of parts.slice(0, -1)) {
        p += seg + "/";
        keys.add(p);
      }
    }
    return [...keys];
  }, [files]);

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

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "16px 20px", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Rendered Files
          </Typography.Title>
          <Typography.Text type="secondary">
            The exact files written to <code>generated/&lt;instance&gt;/</code> on Git when changes
            publish: what your systems will actually consume.
          </Typography.Text>
        </div>
        <Select
          style={{ width: 240 }}
          value={instance ?? undefined}
          placeholder="Choose an instance"
          showSearch
          filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
          onChange={(v) => setInstance(v)}
          options={grid.instances.map((i) => ({
            value: i.name,
            label: (
              <span>
                {i.name}
                <span style={{ opacity: 0.5, fontSize: 12, marginInlineStart: 8 }}>
                  {i.environment}
                </span>
              </span>
            ),
          }))}
        />
      </div>

      {renderQ.isLoading ? (
        <FilesSkeleton />
      ) : files.length === 0 ? (
        <Empty
          style={{ marginTop: 60 }}
          description="Nothing renders for this instance yet. Import parameters or attach design-phase ones to a file."
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 14 }}>
          <div style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              GENERATED/{instance?.toUpperCase()}/
            </Typography.Text>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", marginTop: 6 }}>
              <Tree.DirectoryTree
                treeData={tree}
                expandedKeys={allDirs}
                selectedKeys={selected ? [selected] : []}
                onSelect={(keys) => {
                  const k = keys[0] as string | undefined;
                  if (k && !k.endsWith("/")) setSelected(k);
                }}
              />
            </div>
            {/* VS Code-style source-control footer: the branch these files live
                on, and how many active changes this instance carries. */}
            <div
              style={{
                marginTop: 8,
                paddingTop: 8,
                borderTop: "1px solid rgba(128,128,128,0.2)",
                fontSize: 11.5,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <BranchesOutlined style={{ opacity: 0.7 }} />
                <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {statusQ.data?.branch ?? "…"}
                </span>
                {(statusQ.data?.behind ?? 0) > 0 && (
                  <Tag color="processing" style={{ marginInlineStart: "auto", fontSize: 10 }}>
                    {statusQ.data!.behind} behind
                  </Tag>
                )}
              </span>
              <span style={{ color: changeCount ? "#d98a00" : undefined, opacity: changeCount ? 1 : 0.6 }}>
                {changeCount > 0
                  ? `${changeCount} active change${changeCount > 1 ? "s" : ""} · ${modifiedFileCount} file${modifiedFileCount > 1 ? "s" : ""} modified`
                  : "No active changes for this instance"}
              </span>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {current ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Tag icon={<BranchesOutlined />} className="mono">
                    generated/{instance}/{current.path}
                  </Tag>
                  <Tag>{langOf(current.path)}</Tag>
                  <Tag>{current.content.split("\n").length} lines</Tag>
                  <div style={{ flex: 1 }} />
                  <Button size="small" icon={<CopyOutlined />} onClick={copy}>
                    Copy
                  </Button>
                  <Button size="small" icon={<DownloadOutlined />} onClick={download}>
                    Download
                  </Button>
                </div>
                <pre
                  className="mono rendered-file-pane"
                  style={{
                    flex: 1,
                    margin: 0,
                    padding: "12px 14px",
                    overflow: "auto",
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    borderRadius: 8,
                    border: "1px solid rgba(128,128,128,0.25)",
                    background: "rgba(128,128,128,0.06)",
                  }}
                >
                  {current.content}
                </pre>
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
