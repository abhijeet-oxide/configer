import {
  Button, Dropdown, Input, Popconfirm, Select, Switch, Tooltip, Tree, App as AntApp,
} from "antd";
import type { DataNode } from "antd/es/tree";
import {
  CopyOutlined,
  DownloadOutlined,
  PlusCircleOutlined,
  MinusCircleOutlined,
  SaveOutlined,
  UndoOutlined,
  SearchOutlined,
  MoreOutlined,
  DiffOutlined,
  TableOutlined,
  BranchesOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api } from "../api";
import { useUI } from "../store";
import { bindingsIndex } from "../bindingsIndex";
import { fileIcon, folderIcon } from "./fileIcons";
import { FilesSkeleton } from "./Skeletons";
import { StatusPill, MonoChip, EmptyState, LoadingStage } from "./ui";
import { languageFor } from "../monaco";

const MonacoFileView = lazy(() => import("./MonacoFileView"));

// FilesView is file mode: a focused developer workspace over the instance's
// REAL repository files (its folder plus shared config). The editor
// dominates; the tree is subordinate, searchable and resizable. Files
// Configer manages carry a dot; management is added or dropped from the row
// actions. Saving stages into the draft, exactly like a grid edit.

interface RFile {
  path: string;
  content: string;
}

// changedMark renders a file name with a VS Code-style "modified" marker.
function changedMark(name: string, changed: boolean): React.ReactNode {
  if (!changed) return <span>{name}</span>;
  return (
    <span style={{ color: "var(--c-pending)", fontWeight: 600 }}>
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

// nodeTitle renders one file/folder row: name (+ modified marker), a "managed"
// dot for managed files, and hover actions (+ to manage, − to stop managing).
function nodeTitle(name: string, key: string, isFile: boolean, ctx: TreeCtx): React.ReactNode {
  const managed = isFile && ctx.managed.has(key);
  return (
    <span className="file-node">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {managed && (
          <Tooltip title="Managed: parameters map into this file">
            <span className="size-[7px] shrink-0 rounded-full" style={{ background: "var(--c-ok)" }} />
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

// detectIndent reports the file's indentation width (a best effort from the
// first indented line), for the status strip.
function detectIndent(content: string): number {
  for (const line of content.split("\n")) {
    const m = /^( +)\S/.exec(line);
    if (m) return m[1].length;
  }
  return 2;
}

export default function FilesView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const mode = useUI((s) => s.mode);
  const setSection = useUI((s) => s.setSection);
  const setImportFocus = useUI((s) => s.setImportFocus);
  const setCompare = useUI((s) => s.setCompare);
  const setJump = useUI((s) => s.setJump);
  const selectInstance = useUI((s) => s.selectInstance);
  const fileFocus = useUI((s) => s.fileFocus);
  const projectQ = useQuery({ queryKey: ["project-info"], queryFn: api.projectInfo, staleTime: 30_000 });
  const instances = useMemo(() => projectQ.data?.instances ?? [], [projectQ.data]);
  const [instance, setInstance] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyManaged, setOnlyManaged] = useState(true);
  const [dirty, setDirty] = useState<string | null>(null);
  const [treeQ, setTreeQ] = useState("");
  const [reveal, setReveal] = useState<number | undefined>(undefined);
  const [cursor, setCursor] = useState<{ ln: number; col: number }>({ ln: 1, col: 1 });

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

  // One index answers both "is this file managed" and "which parameters live
  // in this file" (the Files -> Editor direction).
  const paramsByFile = useMemo(() => bindingsIndex(gridQ.data, instance), [gridQ.data, instance]);
  const managed = useMemo(() => new Set(paramsByFile.keys()), [paramsByFile]);

  const files = useMemo(() => {
    const base = onlyManaged ? allFiles.filter((f) => managed.has(f.path)) : allFiles;
    const q = treeQ.trim().toLowerCase();
    return q ? base.filter((f) => f.path.toLowerCase().includes(q)) : base;
  }, [allFiles, onlyManaged, managed, treeQ]);

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

  // Cross-navigation: another view asked to open a file (optionally at a
  // line, for an instance). One-shot; consumed by n.
  const consumedFocus = useRef(0);
  useEffect(() => {
    if (!fileFocus || consumedFocus.current === fileFocus.n) return;
    consumedFocus.current = fileFocus.n;
    if (fileFocus.instance) setInstance(fileFocus.instance);
    setOnlyManaged(false);
    setTreeQ("");
    setSelected(fileFocus.path);
    setReveal(fileFocus.line);
  }, [fileFocus]);

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
  const currentParams = current ? paramsByFile.get(current.path) ?? [] : [];

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
        message.success(`${r.staged} value edit(s) staged in your draft; visible in the grid too`);
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

  // Files -> Editor: jump to the parameter(s) bound into the open file.
  const openInEditor = (paramId: string) => {
    if (instance) selectInstance(instance);
    setJump("cell", paramId, instance ?? undefined);
    setSection("config");
  };

  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus, staleTime: 30_000 });

  if (projectQ.isLoading || (instance && draftQ.isLoading)) {
    return (
      <LoadingStage
        stage={instance ? `Rendering files for ${instance}…` : "Loading the application…"}
        skeleton={
          <div className="flex h-full flex-col gap-3 px-5 py-4">
            <FilesSkeleton />
          </div>
        }
      />
    );
  }

  const managedCount = allFiles.filter((f) => managed.has(f.path)).length;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* The workspace toolbar: branch, instance, managed filter on the left;
          the open file's path, state and actions on the right. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {statusQ.data?.branch && (
            <MonoChip icon={<BranchesOutlined style={{ fontSize: 10 }} />}>{statusQ.data.branch}</MonoChip>
          )}
          <Select
            size="small"
            style={{ width: 190 }}
            value={instance ?? undefined}
            placeholder="Choose an instance"
            showSearch
            filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            onChange={(v) => setInstance(v)}
            options={instances.map((i) => ({ value: i.name, label: i.name }))}
          />
          <Tooltip title="Show only files Configer manages, or the whole repository">
            <span className="inline-flex items-center gap-1.5 text-[13px]">
              <Switch size="small" checked={onlyManaged} onChange={setOnlyManaged} />
              Managed ({managedCount})
            </span>
          </Tooltip>
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          {current && (
            <>
              <MonoChip title={current.path}>{current.path}</MonoChip>
              {managed.has(current.path) ? (
                <StatusPill tone="ok">Managed</StatusPill>
              ) : (
                <Tooltip title="Not managed yet; add it to scan for settings">
                  <Button size="small" icon={<PlusCircleOutlined />} onClick={() => addToManaged(current.path)}>
                    Add to managed
                  </Button>
                </Tooltip>
              )}
              {changedFiles.has(current.path) && (
                <Tooltip title="This file carries pending draft changes; the editor shows committed vs draft">
                  <span className="inline-flex">
                    <StatusPill tone="pending" icon={<DiffOutlined />}>Pending changes</StatusPill>
                  </span>
                </Tooltip>
              )}
              {dirty !== null && <StatusPill tone="review">Unsaved</StatusPill>}
              {currentParams.length > 0 && (
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: currentParams.map((id) => ({
                      key: id,
                      label: <span className="mono">{id}</span>,
                    })),
                    onClick: ({ key }) => openInEditor(key),
                  }}
                >
                  <Button size="small" icon={<TableOutlined />}>
                    Open in editor
                  </Button>
                </Dropdown>
              )}
              <Button
                size="small"
                icon={<DiffOutlined />}
                onClick={() => {
                  if (instance) setCompare(instance, null);
                  localStorage.setItem("configer.compareMode", "files");
                  setSection("compare");
                }}
              >
                Compare
              </Button>
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
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: [
                    { key: "undo", icon: <UndoOutlined />, label: "Discard unsaved typing", disabled: dirty === null },
                    { key: "copy", icon: <CopyOutlined />, label: "Copy content" },
                    { key: "download", icon: <DownloadOutlined />, label: "Download file" },
                  ],
                  onClick: ({ key }) => {
                    if (key === "undo") setDirty(null);
                    if (key === "copy") void copy();
                    if (key === "download") download();
                  },
                }}
              >
                <Button size="small" icon={<MoreOutlined />} aria-label="More file actions" />
              </Dropdown>
            </>
          )}
        </div>
      </div>

      {files.length === 0 ? (
        <EmptyState
          icon={<FileTextOutlined />}
          title={
            treeQ
              ? "No files match your search."
              : onlyManaged
                ? "No managed files for this instance yet."
                : "No files found for this instance."
          }
          hint={
            onlyManaged && allFiles.length > 0
              ? "The repository has files that are not managed yet."
              : undefined
          }
          actionLabel={onlyManaged && allFiles.length > 0 ? "Show all repository files" : undefined}
          onAction={() => setOnlyManaged(false)}
        />
      ) : (
        <>
          <div className="min-h-0 flex-1">
            <PanelGroup direction="horizontal" autoSaveId="configer-files" className="h-full">
              <Panel id="tree" order={1} defaultSize={22} minSize={12} maxSize={45}>
                <div className="flex h-full flex-col border-r border-line">
                  <div className="p-2">
                    <Input
                      size="small"
                      allowClear
                      prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
                      placeholder="Search files…"
                      value={treeQ}
                      onChange={(e) => setTreeQ(e.target.value)}
                    />
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
                    <Tree.DirectoryTree
                      className="files-tree"
                      showIcon
                      selectedKeys={selected ? [selected] : []}
                      defaultExpandedKeys={allDirs}
                      onSelect={(keys) => {
                        const k = String(keys[0] ?? "");
                        if (k && !k.endsWith("/")) {
                          setSelected(k);
                          setReveal(undefined);
                        }
                      }}
                      treeData={tree}
                    />
                  </div>
                </div>
              </Panel>
              <PanelResizeHandle className="rrp-handle rrp-handle-v" />
              <Panel id="editor" order={2} minSize={40}>
                {current ? (
                  <Suspense fallback={<FilesSkeleton />}>
                    <MonacoFileView
                      key={`${instance}|${current.path}`}
                      path={current.path}
                      content={dirty ?? current.content}
                      original={committed}
                      dark={mode === "dark"}
                      editable
                      revealLine={reveal}
                      onDirty={(v) => setDirty(v === current.content ? null : v)}
                      onSave={(v) => save.mutate(v)}
                      onCursor={(ln, col) => setCursor({ ln, col })}
                    />
                  </Suspense>
                ) : (
                  <EmptyState icon={<FileTextOutlined />} title="Select a file" />
                )}
              </Panel>
            </PanelGroup>
          </div>
          {/* The reference's editor status strip: position, indentation,
              language, and how much of the estate is on screen. */}
          <div
            className="flex h-[26px] shrink-0 items-center gap-4 px-3 text-xs text-white"
            style={{ background: "var(--nav-bg)" }}
          >
            <span>
              Ln {cursor.ln}, Col {cursor.col}
            </span>
            <span>Spaces: {current ? detectIndent(dirty ?? current.content) : 2}</span>
            <span className="uppercase">{current ? languageFor(current.path) : ""}</span>
            <span className="ml-auto opacity-85">
              {files.length} file{files.length === 1 ? "" : "s"}
              {changedFiles.size > 0 && ` · ${changedFiles.size} with pending changes`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
