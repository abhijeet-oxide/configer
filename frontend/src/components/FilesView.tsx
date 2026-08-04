import {
  Alert, Button, Dropdown, Input, Segmented, Select, Switch, Tag, Tooltip, App as AntApp,
} from "antd";
import {
  CopyOutlined,
  DownloadOutlined,
  PlusCircleOutlined,
  UndoOutlined,
  SearchOutlined,
  MoreOutlined,
  DiffOutlined,
  SplitCellsOutlined,
  MergeCellsOutlined,
  BranchesOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  DoubleLeftOutlined,
  DoubleRightOutlined,
  ReadOutlined,
  CodeOutlined,
} from "../icons";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api, ApiError, sameContent, ALL_INSTANCES } from "../api";
import { useUI } from "../store";
import { bindingsIndex } from "../bindingsIndex";
import { FilesSkeleton } from "./Skeletons";
import { StatusPill, MonoChip, EmptyState, LoadingStage } from "./ui";
import { isMarkdown, languageFor } from "../monacoLang";
import FileExplorer from "./FileExplorer";
import SubmitChangesButton from "./SubmitChangesButton";
import { useIdentity } from "../identity";

const MonacoFileView = lazy(() => import("./MonacoFileView"));
const MarkdownView = lazy(() => import("./MarkdownView"));

// FilesView is file mode: a focused developer workspace over the instance's
// REAL repository files (its folder plus shared config). The editor
// dominates; the explorer is a VS Code-grade tree: compact, searchable,
// resizable AND collapsible to a thin rail. Files Configer manages carry a
// dot; management is added or dropped from the row actions.
//
// Editing here is editing, in the same sense the grid means it. An edit STAGES
// ITSELF shortly after the typing stops, the same way leaving a grid cell keeps
// what you put in it; there is no save button, because the one that used to be
// here was a trap - identical edits in the two places were kept in one and
// thrown away in the other, and nothing on screen said so. What replaces it is
// the same "Review changes" the grid has: the draft is one draft.
//
// Four things follow from that, and all four are load-bearing:
//
//   - A file that no longer PARSES is refused, whole, with the line called out
//     in the editor and in a notice above it. Autosave without that check is
//     how a stray comma reaches a branch: the file was staged the moment it was
//     typed, and nobody was asked.
//   - The typing is never taken away. A refused save leaves the buffer exactly
//     as written, so the fix is one character rather than a retype, and the
//     DIFF is a view you open (see MonacoFileView) rather than one that arrives
//     on its own and drops the cursor. What the diff DOES do on its own is
//     offer itself: its button goes amber the moment the file differs.
//   - Nothing announces the save. No toast, no pill appearing and disappearing
//     on every pause in the typing - just a line in the status strip that reads
//     Editing… → Saving… → Saved, and says what the save meant for the catalog
//     only when that actually moved. An edit that keeps itself does not need
//     announcing, and a notification over the file somebody is typing in is an
//     interruption whatever it says.
//   - `dirty` is held until the SERVER's copy matches it. Clearing it on the
//     response swapped the editor's value back to the pre-edit content the file
//     query still held, for the moment before the refetch landed: the text
//     visibly reverted and came back, and the cursor jumped. The one thing an
//     editor must never do to somebody mid-sentence.
//
// And the rule that keeps all four true: NOTHING about the editor is reset by
// the file LIST. That list is a fresh array on every fifteen-second poll and
// again after every save, so an effect keyed on it ran constantly - and the one
// that was keyed on it threw away the typed buffer and closed the diff, over
// and over, while somebody was working. Editor state belongs to the open FILE
// and is reset when the open file changes.

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
const DIFF_LAYOUT_KEY = "configer.diffLayout";

/** Side by side, or one pane with removals and additions interleaved. */
type DiffLayout = "split" | "inline";

export default function FilesView() {
  const { message } = AntApp.useApp();
  // File mode is a write surface: the editor stages into the draft. A viewer
  // gets the same files, read-only - no typing, no save, no "add to managed".
  const { canEdit } = useIdentity();
  const qc = useQueryClient();
  const mode = useUI((s) => s.mode);
  const setSection = useUI((s) => s.setSection);
  const setImportFocus = useUI((s) => s.setImportFocus);
  const setCompare = useUI((s) => s.setCompare);
  const fileFocus = useUI((s) => s.fileFocus);
  const projectQ = useRepoQuery({ queryKey: ["project-info"], queryFn: api.projectInfo, staleTime: 30_000 });
  const gridQ = useRepoQuery({ queryKey: ["grid"], queryFn: api.grid });
  // Default to "All instances": every instance's files at once, so a linked
  // parameter always resolves to its file (a single-instance filter would hide
  // files that instance does not own and leave the link highlighting nothing).
  const [instance, setInstance] = useState<string | null>(ALL_INSTANCES);
  const [selected, setSelected] = useState<string | null>(null);
  // The same value in a ref, updated in the same breath as the state. The
  // effect that auto-selects a file READS the current selection, and an effect
  // can run again before React has re-rendered with the state it just set (a
  // background refetch re-creating the file list, a memo re-computing, React's
  // own double invocation in development). Reading the state there meant
  // reading "nothing is selected yet" a moment after selecting something - and
  // auto-selecting the first file in the folder ON TOP of the file a parameter
  // link had just opened, which is how "view in <file>" landed in a completely
  // different file with the other file's line number.
  const selectedRef = useRef<string | null>(null);
  const select = (path: string | null) => {
    selectedRef.current = path;
    setSelected(path);
  };
  const [onlyManaged, setOnlyManaged] = useState(true);
  const [dirty, setDirty] = useState<string | null>(null);
  // The last save that was refused: what is wrong and where. It stays until a
  // save succeeds, because the file is not staged while it holds.
  const [problem, setProblem] = useState<
    { message: string; line: number; column?: number; snippet?: string } | null
  >(null);
  // Reading a diff and writing a file are different jobs; which one you are
  // doing is a control, not something the editor decides the moment you type.
  const [showDiff, setShowDiff] = useState(false);
  const [diffLayout, setDiffLayout] = useState<DiffLayout>(
    () => (localStorage.getItem(DIFF_LAYOUT_KEY) === "inline" ? "inline" : "split"),
  );
  useEffect(() => localStorage.setItem(DIFF_LAYOUT_KEY, diffLayout), [diffLayout]);
  // What the last save did to the catalog, said quietly in the status strip
  // and then let go of. It is worth knowing and not worth interrupting for.
  const [savedNote, setSavedNote] = useState("");
  // The catalog counts the last save reported for this file, so the next save
  // only speaks up if they moved.
  const reportedRef = useRef("");
  const [treeQ, setTreeQ] = useState("");
  const [treeOpen, setTreeOpen] = useState(() => localStorage.getItem(TREE_KEY) !== "0");
  const [reveal, setReveal] = useState<number | undefined>(undefined);
  // How a markdown file is read: as the document it is, or as its source.
  // Prose defaults to being read as prose; the choice sticks while the session
  // lasts, so somebody working through several READMEs sets it once.
  const [mdMode, setMdMode] = useState<"preview" | "raw">("preview");
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
  const allInstances = instance === ALL_INSTANCES;
  const instancePending = !allInstances && !!instance && pendingInstances.has(instance);

  useEffect(() => {
    if (!instance && instances.length > 0) setInstance(ALL_INSTANCES);
  }, [instances, instance]);

  // Which instance owns a real file path (its folder is a prefix), so a save in
  // the "All instances" view is staged against the right instance; a shared
  // (base-layer) file returns undefined and stages globally.
  const ownerInstanceOf = useMemo(() => {
    const folders = (gridQ.data?.instances ?? []).map((i) => ({
      name: i.name,
      folder: i.folder ?? `instances/${i.name}`,
    }));
    return (path: string): string | undefined =>
      folders.find((f) => path === f.folder || path.startsWith(f.folder + "/"))?.name;
  }, [gridQ.data]);

  const draftQ = useRepoQuery({
    queryKey: ["files-draft", instance],
    queryFn: () => api.render(instance!),
    enabled: !!instance,
    refetchInterval: 15_000,
  });
  const committedQ = useRepoQuery({
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
    mutationFn: (file: string) => api.retireFile(file, "Local user"),
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
    if (fileFocus.allInstances) {
      // A parameter link: stay on "All instances" so the file is always
      // present (a single-instance filter could hide it).
      //
      // Nothing announces where the link came from. The value itself is marked
      // in the file, the one you were sent to is highlighted and centred, and
      // the file's own path is in the header: a strip of prose above the editor
      // only restated what the editor was already showing, and pushed the code
      // down to do it.
      setInstance(ALL_INSTANCES);
    } else {
      // A folder/instance-scoped handoff (e.g. "view this instance's files"):
      // honor the requested instance filter as before.
      if (fileFocus.instance) setInstance(fileFocus.instance);
    }
    setOnlyManaged(false);
    setTreeQ("");
    // An empty path means "just show this instance's folder" (e.g. jumping to a
    // freshly staged instance): leave selection to the auto-select effect,
    // which lands on the first file once the folder renders.
    if (fileFocus.path) {
      pendingFocus.current = { path: fileFocus.path, line: fileFocus.line };
      select(fileFocus.path);
      setReveal(fileFocus.line);
    } else {
      pendingFocus.current = null;
      select(null);
      setReveal(undefined);
    }
  }, [fileFocus]);

  // Which file is open. This runs on every refetch of the list, because that is
  // when a file can appear or disappear - and for no other reason. It must
  // therefore touch NOTHING about the editor: `files` is a fresh array on every
  // background poll and after every save, so resetting the editor here reset it
  // every fifteen seconds and again a moment after each autosave. That is the
  // whole of the instability: the typed buffer was thrown away mid-sentence (so
  // the editor reverted under the cursor and whatever was typed next landed on
  // top of the old text), and the diff, once opened, closed itself again on the
  // next poll. Editor state is reset by the effect below, when the FILE
  // changes.
  useEffect(() => {
    if (files.length === 0) {
      select(null);
      return;
    }
    // Honor a pending cross-nav request once the right instance's files have
    // loaded: select the exact file and reveal its line. Until it appears, wait
    // rather than snapping to the first file (which would open the wrong file).
    if (pendingFocus.current) {
      const want = pendingFocus.current.path;
      // The exact file, or the same file under another instance's folder. A
      // parameter's binding is resolved for ONE instance to build the link, and
      // that instance may not carry the file (a setting only some of them
      // have); landing on "Select a file" is the one outcome worse than landing
      // on a neighbour's copy of it.
      const tail = "/" + want.split("/").slice(-2).join("/");
      const hit =
        files.find((f) => f.path === want) ??
        files.find((f) => f.path.endsWith(tail));
      if (hit) {
        select(hit.path);
        setReveal(pendingFocus.current.line);
        pendingFocus.current = null;
      }
      return;
    }
    // Nothing was asked for: fall back to the first file, but only when the
    // explorer really is on nothing (or on a file this list no longer has).
    const on = selectedRef.current;
    if (!on || !files.some((f) => f.path === on)) select(files[0].path);
  }, [files, instance]);

  // Editor state belongs to the OPEN FILE, so it is reset when the open file
  // changes and at no other time. Every one of these is a thing the reader is
  // in the middle of: what they have typed, the failure they are fixing, the
  // diff they opened to look at.
  useEffect(() => {
    setDirty(null);
    setProblem(null);
    setSavedNote("");
    reportedRef.current = "";
  }, [selected, instance]);

  const current = files.find((f) => f.path === selected);
  // Markdown reads as a document unless asked otherwise. A file with unsaved
  // typing stays in the editor: switching to preview under somebody mid-edit
  // would hide the thing they are typing into.
  const showPreview = !!current && isMarkdown(current.path) && mdMode === "preview" && dirty === null;
  const committed = current ? committedOf.get(current.path) : undefined;
  const currentParams = current ? paramsByFile.get(current.path) ?? [] : [];
  // Anything to compare: what is on screen (typed or staged) against what is
  // committed. Drives whether the diff toggle can be pressed at all.
  const shown = dirty ?? current?.content ?? "";
  const hasFileChanges = committed !== undefined && !sameContent(committed, shown);
  // The toggle is a standing preference, but a diff of a file that matches its
  // committed self is two identical panes. So the preference is kept and the
  // VIEW is gated: switching to an unchanged file shows the editor and coming
  // back shows the diff again, without the toggle having to be re-pressed.
  const diffOpen = showDiff && hasFileChanges;


  // Which lines of the open file Configer manages. Located server-side against
  // the same draft-applied content shown here, so a mark sits exactly on the
  // value it belongs to. Only for a file that carries any: the request is
  // skipped entirely for ordinary files.
  const managedQ = useRepoQuery({
    queryKey: ["managed-values", current?.path ?? "", instance],
    queryFn: () => api.managedValues(current!.path, instance ?? undefined),
    enabled: !!current && currentParams.length > 0,
    staleTime: 30_000,
  });
  // The one the reader was SENT here to look at (from a parameter's "View in
  // <file>") is marked loudly and briefly on top of the quiet ones - arriving at
  // a screen of equally-marked values and being left to find yours is not an
  // answer to "show me this parameter in the file".
  const focusParam = fileFocus?.param;
  const marks = useMemo(
    () =>
      (managedQ.data?.values ?? []).map((v) => ({
        line: v.line,
        col: v.col,
        endCol: v.endCol,
        focus: !!focusParam && (v.paramId === focusParam || v.name === focusParam),
        label: `**${v.name}** · managed by Configer${v.secret ? " · secret" : ""}\n\n\`${v.path}\``,
      })),
    [managedQ.data, focusParam],
  );

  // Landing on the value itself, not on the top of its line: when the target is
  // known, the reveal goes to its exact position.
  const focusMark = useMemo(() => marks.find((m) => m.focus), [marks]);

  // Staging a file edit is the same act as typing in a grid cell, so it works
  // the same way: it happens on its own, shortly after the typing stops. The
  // "Save to draft" button that used to be here was a trap - a cell edit was
  // kept the moment you left the cell, an identical edit in file mode was
  // thrown away unless you found the button first, and nothing on screen said
  // the two behaved differently.
  //
  // A failure does NOT clear the typing. The text stays exactly as written so
  // the fix is one character, not a retype.
  const stageInstanceFor = (path: string) =>
    allInstances ? ownerInstanceOf(path) : instance ?? undefined;
  const save = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.stageFileEdit({ instance: stageInstanceFor(path), path, content, author: "Local user" }),
    onSuccess: (r) => {
      setProblem(null);
      // What the edit did to the SETTINGS goes in the status strip, not into a
      // toast. It is worth knowing and it is not worth interrupting for: a
      // notification that arrives mid-sentence, over the file, is the same
      // interruption whatever it says.
      //
      // And only when it CHANGED. Each save recomputes the whole of what this
      // file does to the catalog, so a later save that only adds a comment
      // still comes back carrying the four parameters an earlier one found -
      // and reporting those again reads as four MORE, off the back of typing
      // that added none.
      const counts = `${r.newParameters ?? 0}/${r.movedParameters ?? 0}/${r.droppedParameters ?? 0}`;
      if (counts !== reportedRef.current) {
        reportedRef.current = counts;
        const said: string[] = [];
        if (r.newParameters) said.push(`${r.newParameters} new`);
        if (r.movedParameters) said.push(`${r.movedParameters} re-pointed`);
        if (r.droppedParameters) said.push(`${r.droppedParameters} no longer here`);
        setSavedNote(said.length ? `${said.join(", ")} parameter${said.length === 1 && r.newParameters === 1 ? "" : "s"}` : "");
      }
      // The buffer is NOT cleared here. Clearing it swaps the editor's value
      // from what was typed back to the copy the file query still holds - the
      // pre-edit content - until the refetch lands a moment later, so the text
      // visibly reverts and comes back and the cursor jumps. It is dropped in
      // the effect below, once the server's copy actually says what the screen
      // says.
      void qc.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey[0];
          return k === "files-draft" || k === "draft" || k === "grid" ||
            k === "project-info" || k === "managed-values" || k === "changes";
        },
      });
    },
    onError: (e: Error) => {
      // A file that does not parse is not a toast-and-forget: it is a state the
      // editor stays in until the file parses again, marked on the exact line.
      const syntax = e instanceof ApiError ? e.syntax : undefined;
      if (syntax) {
        setProblem({ message: e.message, line: syntax.line ?? 0, column: syntax.column, snippet: syntax.snippet });
        return;
      }
      setProblem({ message: e.message, line: 0 });
    },
  });

  // The typing is let go of only when the server's copy of the file matches it.
  // Until then `dirty` is what the editor shows, so nothing the user typed ever
  // flickers back to an older version of itself.
  useEffect(() => {
    if (dirty !== null && current && current.content === dirty) setDirty(null);
  }, [dirty, current]);

  // Autosave: one save shortly after the typing stops, and never one that races
  // the last. A file somebody is holding a key down in must not become a request
  // per keystroke, and a pause to think must not become a save mid-sentence -
  // which is why this is a second and a half rather than a beat.
  const AUTOSAVE_MS = 1500;
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  const flush = useRef<() => void>(() => {});
  useEffect(() => {
    if (!canEdit || dirty === null || !selected) {
      flush.current = () => {};
      return;
    }
    const path = selected;
    const content = dirty;
    const send = () => saveRef.current.mutate({ path, content });
    const t = setTimeout(send, AUTOSAVE_MS);
    // Clicking away commits what is there, without waiting out the timer: the
    // moment somebody's attention leaves the file is the moment "is that kept?"
    // has to already be answered.
    flush.current = () => {
      clearTimeout(t);
      send();
    };
    return () => clearTimeout(t);
  }, [dirty, selected, canEdit]);

  // The one line the strip shows about saving. Nothing while a clean file sits
  // there; "Saving…" for the moment it takes; then what the save meant, which
  // fades on the next keystroke rather than on a timer somebody has to wait out.
  const saveState = save.isPending
    ? "Saving…"
    : dirty !== null
      ? "Editing…"
      : savedNote
        ? `Saved · ${savedNote}`
        : hasFileChanges
          ? "Saved to your draft"
          : "";
  // A new file, or new typing, retires the last save's note.
  useEffect(() => {
    if (dirty !== null) setSavedNote("");
  }, [dirty]);
  useEffect(() => {
    setSavedNote("");
    reportedRef.current = "";
  }, [selected]);

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


  const statusQ = useRepoQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus, staleTime: 30_000 });
  // The same draft the editor's status bar shows: staging any change makes
  // the review branch appear here immediately, so both workspaces tell one
  // consistent Git story.
  const crDraftQ = useRepoQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
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
            // A hand-picked file cancels any link still waiting to be honored.
            pendingFocus.current = null;
            select(p);
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
      {/* The workspace toolbar. The OPEN FILE leads it, because the file is what
          this screen is about; branch, instance and the managed filter are
          context for the explorer beside it, and the file's state and actions
          sit on the right. The path is set as quiet italic prose rather than a
          chip: it is the subject line, not another control. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        {current && (
          <Tooltip title={current.path}>
            <span className="cf-open-file">
              <bdi>{current.path}</bdi>
            </span>
          </Tooltip>
        )}
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
            filterOption={(input, opt) =>
              String(opt?.searchText ?? opt?.value ?? "").toLowerCase().includes(input.toLowerCase())
            }
            onChange={(v) => setInstance(v)}
            options={[
              {
                value: ALL_INSTANCES,
                searchText: "all instances",
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    All instances
                    <Tag style={{ margin: 0, fontSize: 10, lineHeight: "16px" }}>{instances.length}</Tag>
                  </span>
                ),
              },
              ...instances.map((i) => ({
                value: i.name,
                searchText: i.name,
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
              })),
            ]}
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
              {managed.has(current.path) ? (
                <StatusPill tone="ok">Managed</StatusPill>
              ) : (
                canEdit && (
                  <Tooltip title="Not managed yet; add it to scan for settings">
                    <Button size="small" icon={<PlusCircleOutlined />} onClick={() => addToManaged(current.path)}>
                      Add to managed
                    </Button>
                  </Tooltip>
                )
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
              {/* No "Unsaved" pill. An edit keeps itself, so a badge that comes
                  and goes on every pause in the typing is a flicker reporting a
                  state nobody has to act on. Saving is said once, quietly, in
                  the status strip at the bottom. */}
              {/* Only for markdown: everything else in a configuration
                  repository IS its source, and a "raw" switch on a values file
                  would be a switch between the same thing twice. */}
              {isMarkdown(current.path) && (
                <Tooltip title="Read this file as a document, or edit its markdown source">
                  <Segmented
                    size="small"
                    value={mdMode}
                    onChange={(v) => setMdMode(v as "preview" | "raw")}
                    options={[
                      { value: "preview", label: "Preview", icon: <ReadOutlined /> },
                      { value: "raw", label: "Raw", icon: <CodeOutlined /> },
                    ]}
                  />
                </Tooltip>
              )}
              {/* No "N parameters here" list. On a real file that was seven
                  hundred entries of a dropdown taller than the screen, offering
                  to jump away from the file being edited - a list nobody can
                  read, answering a question the grid already answers better. */}
              {/* The diff is a VIEW of this file, opened deliberately - it used
                  to arrive on its own the moment anything differed, which meant
                  typing one character replaced the editor under the cursor.
                  What it does do on its own is OFFER itself: the moment the file
                  differs from what is committed, the button goes amber and says
                  so. Attention without interruption - the cursor stays where it
                  was, and looking is one click when the reader is ready. */}
              <Tooltip
                title={
                  committed === undefined
                    ? "This file is new in your draft, so there is nothing to compare it against"
                    : hasFileChanges
                      ? "Show what your changes do to this file against the committed version"
                      : "This file matches the committed version"
                }
              >
                <span className="inline-flex">
                  <Button
                    size="small"
                    type={diffOpen ? "primary" : "default"}
                    className={hasFileChanges && !diffOpen ? "cf-diff-offer" : undefined}
                    icon={<DiffOutlined />}
                    disabled={!hasFileChanges}
                    onClick={() => setShowDiff((v) => !v)}
                  >
                    View difference
                  </Button>
                </span>
              </Tooltip>
              {/* How to read it. Side by side is right for a block that moved;
                  inline is right for a value that changed, and on a narrow
                  window it is the only one that fits. The choice sticks, so
                  somebody who reads diffs one way sets it once. */}
              {diffOpen && (
                <Segmented
                  size="small"
                  value={diffLayout}
                  onChange={(v) => setDiffLayout(v as DiffLayout)}
                  options={[
                    { value: "split", label: "Split", icon: <SplitCellsOutlined /> },
                    { value: "inline", label: "Inline", icon: <MergeCellsOutlined /> },
                  ]}
                />
              )}
              {canEdit && <SubmitChangesButton instances={gridQ.data?.instances} />}
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: [
                    { key: "undo", icon: <UndoOutlined />, label: "Discard unsaved typing", disabled: dirty === null },
                    { key: "copy", icon: <CopyOutlined />, label: "Copy content" },
                    { key: "download", icon: <DownloadOutlined />, label: "Download file" },
                    { type: "divider" as const },
                    { key: "compare", icon: <BranchesOutlined />, label: "Compare across instances or branches" },
                  ],
                  onClick: ({ key }) => {
                    if (key === "undo") setDirty(null);
                    if (key === "copy") void copy();
                    if (key === "download") download();
                    if (key === "compare") {
                      if (instance) setCompare(instance, null);
                      localStorage.setItem("configer.compareMode", "files");
                      setSection("compare");
                    }
                  },
                }}
              >
                <Button size="small" icon={<MoreOutlined />} aria-label="More file actions" />
              </Dropdown>
            </>
          )}
        </div>
      </div>

      {problem && (
        <Alert
          type="error"
          showIcon
          style={{ padding: "6px 12px" }}
          message={
            <span>
              {problem.message}
              {problem.snippet && (
                <>
                  {" "}
                  <code className="mono" style={{ fontSize: 11 }}>{problem.snippet}</code>
                </>
              )}
            </span>
          }
          description={
            <span style={{ fontSize: 12 }}>
              Nothing was staged, and your typing is untouched. Fix the line and it saves itself.
            </span>
          }
          action={
            problem.line > 0 ? (
              <Button size="small" onClick={() => setReveal(problem.line)}>
                Go to line {problem.line}
              </Button>
            ) : undefined
          }
        />
      )}

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
                {current && showPreview ? (
                  <Suspense fallback={<FilesSkeleton />}>
                    <MarkdownView content={dirty ?? current.content} />
                  </Suspense>
                ) : current ? (
                  <Suspense fallback={<FilesSkeleton />}>
                    <MonacoFileView
                      key={`${instance}|${current.path}`}
                      path={current.path}
                      content={dirty ?? current.content}
                      original={createdFiles.has(current.path) ? undefined : committed}
                      diff={diffOpen}
                      diffLayout={diffLayout}
                      dark={mode === "dark"}
                      editable={canEdit}
                      revealLine={problem?.line || focusMark?.line || reveal}
                      revealColumn={problem?.line ? problem.column : focusMark?.col}
                      marks={dirty === null ? marks : undefined}
                      problem={problem?.line ? { line: problem.line, column: problem.column, message: problem.message } : undefined}
                      onDirty={(v) => setDirty(v === current.content ? null : v)}
                      onSave={(v) => save.mutate({ path: current.path, content: v })}
                      onBlur={() => flush.current()}
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
            {/* Where saving is said. It is a strip, not a dialog: an edit that
                keeps itself does not need announcing, and a notification over
                the file somebody is typing in is an interruption whatever it
                says. The slot is always rendered so nothing beside it moves. */}
            <span className="cf-save-state" aria-live="polite">
              {saveState}
            </span>
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
