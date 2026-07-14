import { Button, Empty, Select, Space, Tag, Tooltip, Tree, Typography, App as AntApp } from "antd";
import type { DataNode } from "antd/es/tree";
import {
  FolderOpenOutlined,
  FileTextOutlined,
  CopyOutlined,
  DownloadOutlined,
  SaveOutlined,
  UndoOutlined,
  DiffOutlined,
} from "@ant-design/icons";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";
import { FilesSkeleton } from "./Skeletons";

const MonacoFileView = lazy(() => import("./MonacoFileView"));

// FilesView is file mode: the VS Code-like editor over the instance's REAL
// repository files (its folder plus shared config). The left tree carries
// modified markers for files your pending draft touches; the editor shows a
// side-by-side diff of committed vs draft-applied content and is EDITABLE —
// saving stages the edit into the same draft as grid edits (managed values
// become validated cell edits; other content is staged as a file edit).

interface RFile {
  path: string;
  content: string;
}

// changedMark renders a file name with a VS Code-style "modified" marker.
function changedMark(name: string, changed: boolean): React.ReactNode {
  if (!changed) return name;
  return (
    <span style={{ color: "#d98a00", fontWeight: 600 }}>
      {name}
      <span style={{ marginInlineStart: 6, fontSize: 11 }}>M</span>
    </span>
  );
}

// buildTree folds flat file paths into a folder tree for the explorer;
// folders containing modified files are marked too.
function buildTree(files: RFile[], changed: Set<string>): DataNode[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: string[];
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
      const ch = changed.has(full);
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

export default function FilesView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const mode = useUI((s) => s.mode);
  const projectQ = useQuery({ queryKey: ["project-info"], queryFn: api.projectInfo, staleTime: 30_000 });
  const instances = useMemo(() => projectQ.data?.instances ?? [], [projectQ.data]);
  const [instance, setInstance] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The user's in-editor content when it differs from the draft (unsaved).
  const [dirty, setDirty] = useState<string | null>(null);

  useEffect(() => {
    if (!instance && instances.length > 0) setInstance(instances[0].name);
  }, [instances, instance]);

  // Draft-applied content (what publishing would write) and the committed
  // baseline: their difference IS the pending diff.
  const draftQ = useQuery({
    queryKey: ["files-draft", instance],
    queryFn: () => api.render(instance!),
    enabled: !!instance,
    refetchInterval: 15_000,
  });
  const committedQ = useQuery({
    queryKey: ["files-committed", instance],
    queryFn: () => api.render(instance!, { draft: false }),
    enabled: !!instance,
    refetchInterval: 15_000,
  });
  const files = useMemo(() => draftQ.data?.files ?? [], [draftQ.data]);
  const committedOf = useMemo(
    () => new Map((committedQ.data?.files ?? []).map((f) => [f.path, f.content])),
    [committedQ.data],
  );

  const changedFiles = useMemo(() => {
    const s = new Set<string>();
    for (const f of files) {
      if (committedOf.get(f.path) !== f.content) s.add(f.path);
    }
    return s;
  }, [files, committedOf]);

  const tree = useMemo(() => buildTree(files, changedFiles), [files, changedFiles]);

  // Keep a sensible selection when the instance changes or files load, and
  // drop unsaved typing when switching files.
  useEffect(() => {
    setDirty(null);
    if (files.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !files.some((f) => f.path === selected)) setSelected(files[0].path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, instance]);

  const current = files.find((f) => f.path === selected);
  const committed = current ? committedOf.get(current.path) : undefined;

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

  const save = useMutation({
    mutationFn: (content: string) =>
      api.stageFileEdit({ instance: instance ?? undefined, path: selected!, content, author: "demo-user" }),
    onSuccess: (r) => {
      setDirty(null);
      if (r.staged === 0) message.info("No changes to save");
      else if (r.kind === "values")
        message.success(`${r.staged} value edit(s) staged in your draft — visible in the grid too`);
      else message.success("File edit staged in your draft");
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message, 6),
  });

  const copy = async () => {
    if (!current) return;
    await navigator.clipboard.writeText(dirty ?? current.content);
    message.success("File content copied");
  };
  const download = () => {
    if (!current) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([dirty ?? current.content], { type: "text/plain" }));
    a.download = current.path.split("/").pop() ?? "config.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (projectQ.isLoading || (instance && draftQ.isLoading)) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "16px 20px", gap: 12 }}>
        <FilesSkeleton />
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "16px 20px", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Files
          </Typography.Title>
          <Typography.Text type="secondary">
            This instance's real repository files. Pending edits show as a live diff; the editor is
            writable and saving stages into the same draft as the grid.
          </Typography.Text>
        </div>
        <Select
          style={{ width: 240 }}
          value={instance ?? undefined}
          placeholder="Choose an instance"
          showSearch
          filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
          onChange={(v) => setInstance(v)}
          options={instances.map((i) => ({ value: i.name, label: i.name }))}
        />
      </div>

      {files.length === 0 ? (
        <Empty description="No files found for this instance." style={{ marginTop: 60 }} />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 14 }}>
          <div style={{ width: 280, overflow: "auto", flexShrink: 0 }}>
            <Tree.DirectoryTree
              showIcon
              selectedKeys={selected ? [selected] : []}
              defaultExpandedKeys={allDirs}
              onSelect={(keys) => {
                const k = String(keys[0] ?? "");
                if (k && !k.endsWith("/")) setSelected(k);
              }}
              treeData={tree}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {current ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Tag className="mono">{current.path}</Tag>
                  {changedFiles.has(current.path) && (
                    <Tooltip title="This file carries pending draft changes; the editor shows committed vs draft">
                      <Tag color="orange" icon={<DiffOutlined />}>pending changes</Tag>
                    </Tooltip>
                  )}
                  {dirty !== null && <Tag color="processing">unsaved</Tag>}
                  <div style={{ flex: 1 }} />
                  <Space size={6}>
                    <Button
                      size="small"
                      type="primary"
                      icon={<SaveOutlined />}
                      disabled={dirty === null}
                      loading={save.isPending}
                      onClick={() => dirty !== null && save.mutate(dirty)}
                    >
                      Save to draft
                    </Button>
                    <Tooltip title="Discard unsaved typing">
                      <Button size="small" icon={<UndoOutlined />} disabled={dirty === null} onClick={() => setDirty(null)} />
                    </Tooltip>
                    <Button size="small" icon={<CopyOutlined />} onClick={copy} />
                    <Button size="small" icon={<DownloadOutlined />} onClick={download} />
                  </Space>
                </div>
                <div style={{ flex: 1, minHeight: 0, border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8, overflow: "hidden" }}>
                  <Suspense fallback={<FilesSkeleton />}>
                    <MonacoFileView
                      key={`${instance}|${current.path}`}
                      path={current.path}
                      content={dirty ?? current.content}
                      original={committed}
                      dark={mode === "dark"}
                      editable
                      onDirty={(v) => setDirty(v === current.content ? null : v)}
                      onSave={(v) => save.mutate(v)}
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
