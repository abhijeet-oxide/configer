import {
  Alert, Button, Dropdown, Input, Select, Switch, Tag, Tooltip, App as AntApp,
} from "antd";
import {
  CopyOutlined,
  DownloadOutlined,
  PlusCircleOutlined,
  SaveOutlined,
  UndoOutlined,
  SearchOutlined,
  MoreOutlined,
  DiffOutlined,
  TableOutlined,
  BranchesOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  DoubleLeftOutlined,
  DoubleRightOutlined,
} from "../icons";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api, sameContent } from "../api";
import { useUI } from "../store";
import { bindingsIndex } from "../bindingsIndex";
import { FilesSkeleton } from "./Skeletons";
import { StatusPill, MonoChip, EmptyState, LoadingStage } from "./ui";
import { languageFor } from "../monaco";
import FileExplorer from "./FileExplorer";

const MonacoFileView = lazy(() => import("./MonacoFileView"));

// FilesView is file mode: a focused developer workspace over the instance's
// REAL repository files (its folder plus shared config). The editor
// dominates; the explorer is a VS Code-grade tree: compact, searchable,
// resizable AND collapsible to a thin rail. Files Configer manages carry a
// dot; management is added or dropped from the row actions. Saving stages
// into the draft, exactly like a grid edit.

// detectIndent reports the file's indentation width (a best effort from the
// first indented line), for the status strip.
function detectIndent(content: string): number {
  for (const line of content.split("\n")) {
    const m = /^( +)\S/.exec(line);
    if (m) return m[1].length;
  }
  return 2;
}

const TREE_KEY = "configer.filesTreeOpen";

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
  const gridQ = useQuery({ queryKey: ["grid"], queryFn: api.grid });
  const [instance, setInstance] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyManaged, setOnlyManaged] = useState(true);
  const [dirty, setDirty] = useState<string | null>(null);
  const [treeQ, setTreeQ] = useState("");
  const [treeOpen, setTreeOpen] = useState(() => localStorage.getItem(TREE_KEY) !== "0");
  const [reveal, setReveal] = useState<number | undefined>(undefined);
  const [cursor, setCursor] = useState<{ ln: number; col: number }>({ ln: 1, col: 1 });

  const toggleTree = () => {
    setTreeOpen((v) => {
      localStorage.setItem(TREE_KEY, v ? "0" : "1");
      return !v;
    });
  };

  // The instance list comes from the grid so it includes instances that only
  // exist as a pending draft add (status "draft"); the committed registry is
  // the fallback before the grid loads.
  const instances = useMemo(() => {
    const g = gridQ.data?.instances;
    if (g && g.length) return g.map((i) => ({ name: i.name, status: i.status }));
    return (projectQ.data?.instances ?? []).map((i) => ({ name: i.name, status: undefined as string | undefined }));
  }, [gridQ.data, projectQ.data]);
  const pendingInstances = useMemo(
    () => new Set(instances.filter((i) => i.status === "draft").map((i) => i.name)),
    [instances],
  );
  const instancePending = !!instance && pendingInstances.has(instance);

  useEffect(() => {
    if (!instance && instances.length > 0) setInstance(instances[0].name);
  }, [instances, instance]);

  const draftQ = useQuery({
    queryKey: ["files-draft", instance],
    queryFn: () => api.render(instance!),
    enabled: !!instance,
    refetchInterval: 15_000,
  });
  const committedQ = useQuery({
    queryKey: ["files-committed", instance],
    queryFn: () => api.render(instance!, { draft: false }),
    // A pending instance has no committed files yet; skip the fetch (it would
    // fail) so every file reads as newly added.
    enabled: !!instance && !instancePending,
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

  // A file is "created" when it has no committed counterpart (a pending
  // instance's whole folder, or a new file staged in the draft); "changed"
  // when it exists committed but the draft-applied content differs.
  const createdFiles = useMemo(() => {
    const s = new Set<string>();
    if (committedQ.isLoading && !instancePending) return s;
    for (const f of allFiles) if (!committedOf.has(f.path)) s.add(f.path);
    return s;
  }, [allFiles, committedOf, committedQ.isLoading, instancePending]);

  const changedFiles = useMemo(() => {
    const s = new Set<string>();
    for (const f of allFiles) {
      if (!committedOf.has(f.path)) continue; // created, not changed
      if (!sameContent(committedOf.get(f.path), f.content)) s.add(f.path);
    }
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

  // Cross-navigation: another view asked to open a file (optionally at a
  // line, for an instance). One-shot; consumed by n.
  const consumedFocus = useRef(0);
  // A requested file+line that must survive the instance's file list reloading.
  // Switching instance refetches `files`, and the auto-select effect below would
  // otherwise snap the selection to the first file before the requested one has
  // loaded; this ref lets that effect honor the request once it appears.
  const pendingFocus = useRef<{ path: string; line?: number } | null>(null);
  useEffect(() => {
    if (!fileFocus || consumedFocus.current === fileFocus.n) return;
    consumedFocus.current = fileFocus.n;
    if (fileFocus.instance) setInstance(fileFocus.instance);
    setOnlyManaged(false);
    setTreeQ("");
    // An empty path means "just show this instance's folder" (e.g. jumping to a
    // freshly staged instance): leave selection to the auto-select effect,
    // which lands on the first file once the folder renders.
    if (fileFocus.path) {
      pendingFocus.current = { path: fileFocus.path, line: fileFocus.line };
      setSelected(fileFocus.path);
      setReveal(fileFocus.line);
    } else {
      pendingFocus.current = null;
      setSelected(null);
      setReveal(undefined);
    }
  }, [fileFocus]);

  useEffect(() => {
    setDirty(null);
    if (files.length === 0) {
      setSelected(null);
      return;
    }
    // Honor a pending cross-nav request once the right instance's files have
    // loaded: select the exact file and reveal its line. Until it appears, wait
    // rather than snapping to the first file (which would open the wrong file).
    if (pendingFocus.current) {
      if (files.some((f) => f.path === pendingFocus.current!.path)) {
        setSelected(pendingFocus.current.path);
        setReveal(pendingFocus.current.line);
        pendingFocus.current = null;
      }
      return;
    }
    if (!selected || !files.some((f) => f.path === selected)) setSelected(files[0].path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, instance]);

  const current = files.find((f) => f.path === selected);
  const committed = current ? committedOf.get(current.path) : undefined;
  const currentParams = current ? paramsByFile.get(current.path) ?? [] : [];

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
  // The same draft the editor's status bar shows: staging any change makes
  // the review branch appear here immediately, so both workspaces tell one
  // consistent Git story.
  const crDraftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const crDraft = crDraftQ.data?.draft;
  const draftItems = crDraft?.items?.length ?? 0;

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

  const explorerPanel = (
    <div className="flex h-full min-w-0 flex-col border-r border-line">
      <div className="flex h-8 shrink-0 items-center gap-1 pr-1 pl-3">
        <span className="text-[11px] font-semibold tracking-wide text-ink-3 uppercase">Explorer</span>
        <span className="ml-auto" />
        <Tooltip title="Hide the explorer">
          <Button size="small" type="text" icon={<DoubleLeftOutlined style={{ fontSize: 10 }} />} onClick={toggleTree} />
        </Tooltip>
      </div>
      <div className="px-2 pb-1.5">
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
          placeholder="Search files…"
          value={treeQ}
          onChange={(e) => setTreeQ(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        <FileExplorer
          files={files.map((f) => f.path)}
          selected={selected}
          state={{ changed: changedFiles, created: createdFiles, managed }}
          onSelect={(p) => {
            setSelected(p);
            setReveal(undefined);
          }}
          onAdd={addToManaged}
          onRemove={(f) => retire.mutate(f)}
        />
      </div>
    </div>
  );

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
            style={{ width: 210 }}
            value={instance ?? undefined}
            placeholder="Choose an instance"
            showSearch
            filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            onChange={(v) => setInstance(v)}
            options={instances.map((i) => ({
              value: i.name,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  {i.name}
                  {i.status === "draft" && (
                    <Tag color="processing" style={{ margin: 0, fontSize: 10, lineHeight: "16px" }}>new</Tag>
                  )}
                  {i.status === "retiring" && (
                    <Tag color="warning" style={{ margin: 0, fontSize: 10, lineHeight: "16px" }}>retiring</Tag>
                  )}
                </span>
              ),
            }))}
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
              {createdFiles.has(current.path) && (
                <Tooltip title="New file: it will be created on the feature branch when you submit">
                  <span className="inline-flex">
                    <StatusPill tone="ok" icon={<FolderAddOutlined />}>New in draft</StatusPill>
                  </span>
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
                <Tooltip title="Parameters whose values live in this file - open any in Parameters">
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
                      {currentParams.length} parameter{currentParams.length === 1 ? "" : "s"} here
                    </Button>
                  </Dropdown>
                </Tooltip>
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

      {instancePending && (
        <Alert
          type="info"
          showIcon
          icon={<FolderAddOutlined />}
          message={
            <span>
              <b className="mono">{instance}</b> is a pending new instance. This whole folder will be
              created on the feature branch when you submit the change request; nothing is written to
              the repository yet.
            </span>
          }
          style={{ padding: "6px 12px" }}
        />
      )}

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
          <div className="flex min-h-0 flex-1">
            {/* Collapsed: a thin rail brings the explorer back (like the
                editor's side panels), so the file dominates completely. */}
            {!treeOpen && (
              <div
                className="panel-rail flex w-[26px] shrink-0 cursor-pointer flex-col items-center gap-2 border-r border-line pt-2"
                onClick={toggleTree}
                title="Show the explorer"
              >
                <DoubleRightOutlined style={{ fontSize: 10, opacity: 0.7 }} />
                <span
                  className="text-xs text-ink-3"
                  style={{ writingMode: "vertical-rl", letterSpacing: 0.3 }}
                >
                  Explorer
                </span>
              </div>
            )}
            <PanelGroup direction="horizontal" autoSaveId="configer-files" className="h-full min-w-0 flex-1">
              {treeOpen && (
                <>
                  <Panel id="tree" order={1} defaultSize={22} minSize={12} maxSize={45}>
                    {explorerPanel}
                  </Panel>
                  <PanelResizeHandle className="rrp-handle rrp-handle-v" />
                </>
              )}
              <Panel id="editor" order={2} minSize={40}>
                {current ? (
                  <Suspense fallback={<FilesSkeleton />}>
                    <MonacoFileView
                      key={`${instance}|${current.path}`}
                      path={current.path}
                      content={dirty ?? current.content}
                      original={createdFiles.has(current.path) ? undefined : committed}
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
          {/* The editor status strip: position, indentation, language, and
              how much of the estate is on screen. */}
          <div
            className="flex h-[26px] shrink-0 items-center gap-4 px-3 text-xs text-white"
            style={{ background: "var(--nav-bg)" }}
          >
            <Tooltip
              title={
                draftItems > 0
                  ? `Your ${draftItems} change(s) build on ${statusQ.data?.branch ?? "the base branch"}. Configer commits them to a review branch when you submit.`
                  : "The branch your saved edits build on."
              }
            >
              <span className="inline-flex items-center gap-1.5">
                <BranchesOutlined />
                <span className="mono">{statusQ.data?.branch ?? "…"}</span>
              </span>
            </Tooltip>
            <span>
              Ln {cursor.ln}, Col {cursor.col}
            </span>
            <span>Spaces: {current ? detectIndent(dirty ?? current.content) : 2}</span>
            <span className="uppercase">{current ? languageFor(current.path) : ""}</span>
            <span className="ml-auto opacity-85">
              {files.length} file{files.length === 1 ? "" : "s"}
              {changedFiles.size > 0 && ` · ${changedFiles.size} modified`}
              {createdFiles.size > 0 && ` · ${createdFiles.size} new`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
