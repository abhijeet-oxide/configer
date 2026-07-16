import {
  Button, Empty, Popconfirm, Select, Space, Switch, Tag, Tooltip, Tree, Typography, App as AntApp,
} from "antd";
import type { DataNode } from "antd/es/tree";
import {
  CopyOutlined,
  DownloadOutlined,
  PlusCircleOutlined,
  MinusCircleOutlined,
  SaveOutlined,
  UndoOutlined,
  DiffOutlined,
} from "@ant-design/icons";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bindingsOf } from "../api";
import { useUI } from "../store";
import { fileIcon, folderIcon } from "./fileIcons";
import { FilesSkeleton } from "./Skeletons";

const MonacoFileView = lazy(() => import("./MonacoFileView"));

// FilesView is file mode: the VS Code-like editor over the instance's REAL
// repository files (its folder plus shared config). Files Configer already
// manages (a parameter is bound to them) carry a "managed" badge; a toggle
// narrows the tree to only those. Unmanaged files can be added to management
// (which reprocesses them for parameters via Import), and a managed file can be
// dropped from management (its parameters are retired). The editor shows a
// side-by-side diff of committed vs draft-applied content and is EDITABLE.

interface RFile {
  path: string;
  content: string;
}

// changedMark renders a file name with a VS Code-style "modified" marker.
function changedMark(name: string, changed: boolean): React.ReactNode {
  if (!changed) return <span>{name}</span>;
  return (
    <span style={{ color: "#d98a00", fontWeight: 600 }}>
      {name}
      <span style={{ marginInlineStart: 6, fontSize: 11 }}>M</span>
    </span>
  );
}

interface TreeCtx {
  changed: Set<string>;
  managed: Set<string>;
  onAdd: (prefix: string) => void;
  onRemove: (file: string) => void;
}

// fileTitle renders one file/folder row: name (+ modified marker), a "managed"
// dot for managed files, and hover actions (+ to manage, − to stop managing).
function nodeTitle(name: string, key: string, isFile: boolean, ctx: TreeCtx): React.ReactNode {
  const managed = isFile && ctx.managed.has(key);
  return (
    <span className="file-node">
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {managed && (
          <Tooltip title="Managed: parameters map into this file">
            <span style={{ width: 7, height: 7, borderRadius: 4, background: "var(--c-ok)", flexShrink: 0 }} />
          </Tooltip>
        )}
        {changedMark(name, ctx.changed.has(key))}
      </span>
      <span className="file-node-actions" onClick={(e) => e.stopPropagation()}>
        {isFile ? (
          managed ? (
            <Popconfirm
              title="Stop managing this file?"
              description="Its parameters are retired (removed from the catalog); the file itself is untouched."
              okText="Stop managing"
              okButtonProps={{ danger: true }}
              onConfirm={() => ctx.onRemove(key)}
            >
              <Tooltip title="Stop managing (retire its parameters)">
                <Button size="small" type="text" icon={<MinusCircleOutlined />} />
              </Tooltip>
            </Popconfirm>
          ) : (
            <Tooltip title="Add to managed: scan this file for settings">
              <Button size="small" type="text" icon={<PlusCircleOutlined />} onClick={() => ctx.onAdd(key)} />
            </Tooltip>
          )
        ) : (
          <Tooltip title="Add this folder to managed: scan it for settings">
            <Button size="small" type="text" icon={<PlusCircleOutlined />} onClick={() => ctx.onAdd(key)} />
          </Tooltip>
        )}
      </span>
    </span>
  );
}

// buildTree folds flat file paths into a folder tree for the explorer.
function buildTree(files: RFile[], ctx: TreeCtx): DataNode[] {
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
  const toNodes = (d: Dir, prefix: string): DataNode[] => {
    const dirNodes = [...d.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]) => {
        const key = `${prefix}${name}/`;
        return {
          key,
          title: nodeTitle(name, key, false, ctx),
          icon: folderIcon(),
          selectable: false,
          children: toNodes(sub, key),
        };
      });
    const fileNodes = d.files.sort().map((full) => {
      const base = full.split("/").pop() ?? full;
      return {
        key: full,
        title: nodeTitle(base, full, true, ctx),
        icon: fileIcon(base),
        isLeaf: true,
      };
    });
    return [...dirNodes, ...fileNodes];
  };
  return toNodes(root, "");
}

export default function FilesView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const mode = useUI((s) => s.mode);
  const setSection = useUI((s) => s.setSection);
  const setImportFocus = useUI((s) => s.setImportFocus);
  const projectQ = useQuery({ queryKey: ["project-info"], queryFn: api.projectInfo, staleTime: 30_000 });
  const instances = useMemo(() => projectQ.data?.instances ?? [], [projectQ.data]);
  const [instance, setInstance] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyManaged, setOnlyManaged] = useState(true);
  const [dirty, setDirty] = useState<string | null>(null);

  useEffect(() => {
    if (!instance && instances.length > 0) setInstance(instances[0].name);
  }, [instances, instance]);

  const gridQ = useQuery({ queryKey: ["grid"], queryFn: api.grid });
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
  const allFiles = useMemo(() => draftQ.data?.files ?? [], [draftQ.data]);
  const committedOf = useMemo(
    () => new Map((committedQ.data?.files ?? []).map((f) => [f.path, f.content])),
    [committedQ.data],
  );

  // A file is "managed" when a parameter binds into it (for the selected
  // instance, instance-layer templates expand to that instance's folder).
  const managed = useMemo(() => {
    const set = new Set<string>();
    const inst = gridQ.data?.instances.find((i) => i.name === instance);
    const folder = inst?.folder || (instance ? `instances/${instance}` : "");
    for (const r of gridQ.data?.rows ?? []) {
      for (const b of bindingsOf(r.param)) {
        set.add(b.file.replace(/\{folder\}/g, folder).replace(/\{instance\}/g, instance ?? ""));
      }
    }
    return set;
  }, [gridQ.data, instance]);

  const files = useMemo(
    () => (onlyManaged ? allFiles.filter((f) => managed.has(f.path)) : allFiles),
    [allFiles, onlyManaged, managed],
  );

  const changedFiles = useMemo(() => {
    const s = new Set<string>();
    for (const f of allFiles) if (committedOf.get(f.path) !== f.content) s.add(f.path);
    return s;
  }, [allFiles, committedOf]);

  const retire = useMutation({
    mutationFn: (file: string) => api.retireFile(file, "demo-user"),
    onSuccess: (r) => {
      message.success(`Stopped managing: ${r.retired.length} parameter(s) retired.`);
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message, 6),
  });

  // "Add to managed" reuses the Import flow, focused on the chosen file/folder,
  // so its settings are scanned and imported exactly like first-time onboarding.
  const addToManaged = (prefix: string) => {
    setImportFocus(prefix);
    setSection("import");
  };

  const ctx: TreeCtx = useMemo(
    () => ({ changed: changedFiles, managed, onAdd: addToManaged, onRemove: (f) => retire.mutate(f) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [changedFiles, managed],
  );
  const tree = useMemo(() => buildTree(files, ctx), [files, ctx]);

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

  const managedCount = allFiles.filter((f) => managed.has(f.path)).length;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "16px 20px", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Files
          </Typography.Title>
          <Typography.Text type="secondary">
            This instance's real repository files. Managed files carry a{" "}
            <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 4, background: "var(--c-ok)", verticalAlign: "middle" }} />{" "}
            dot; add or drop files from management with the row actions.
          </Typography.Text>
        </div>
        <Space>
          <Tooltip title="Show only files Configer manages, or the whole repository">
            <Space size={6}>
              <Switch size="small" checked={onlyManaged} onChange={setOnlyManaged} />
              <Typography.Text style={{ fontSize: 13 }}>Only managed ({managedCount})</Typography.Text>
            </Space>
          </Tooltip>
          <Select
            style={{ width: 220 }}
            value={instance ?? undefined}
            placeholder="Choose an instance"
            showSearch
            filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            onChange={(v) => setInstance(v)}
            options={instances.map((i) => ({ value: i.name, label: i.name }))}
          />
        </Space>
      </div>

      {files.length === 0 ? (
        <Empty
          description={onlyManaged ? "No managed files for this instance yet." : "No files found for this instance."}
          style={{ marginTop: 60 }}
        >
          {onlyManaged && allFiles.length > 0 && (
            <Button onClick={() => setOnlyManaged(false)}>Show all repository files</Button>
          )}
        </Empty>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 14 }}>
          <div style={{ width: 300, overflow: "auto", flexShrink: 0 }}>
            <Tree.DirectoryTree
              className="files-tree"
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
                  {managed.has(current.path) ? (
                    <Tag color="success">managed</Tag>
                  ) : (
                    <Tooltip title="Not managed yet — add it to scan for settings">
                      <Button size="small" icon={<PlusCircleOutlined />} onClick={() => addToManaged(current.path)}>
                        Add to managed
                      </Button>
                    </Tooltip>
                  )}
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
