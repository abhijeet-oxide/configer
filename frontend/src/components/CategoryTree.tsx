import {
  Dropdown, Modal, Select, Tag, Tooltip, Tree, Typography, Input,
  App as AntApp, type GetRef,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CopyOutlined, EditOutlined, FilterFilled } from "../icons";
import { api, expandBinding, nameSegments, type Grid, type Instance, type Parameter } from "../api";
import { useElementSize } from "../hooks";
import { buildNameTree, groupLeaf, nameEntries, type NameNode } from "../paramtree";
import { markBusy } from "../busy";
import { useUI } from "../store";

// Left panel: the single Parameters tree, so it alone flanks the matrix (the
// hero). It holds the parameter NAME hierarchy - a dotted name like
// admin.rebuildslave.failretryInterval nests as admin › rebuildslave ›
// failretryInterval, with each parameter a clickable leaf. Selecting one
// scrolls the grid to that row; and in reverse, selecting a grid row reveals
// its leaf here. Instance columns are steered from the grid itself (click a
// header, or the column manager), not a second tree.
//
// A GROUP answers to three different intentions, and they are three different
// gestures rather than one gesture that guesses:
//
//   click        - LOOK at it. Its rows are picked out in the grid and
//                  everything around them stays where it is. Clicking a folder
//                  used to hide the rest of the estate, which answers "show me
//                  only this" - an instruction nobody gave.
//   double click - EDIT it. Every setting under the branch opens as one form,
//                  with what it applies to said out loud.
//   right click  - the rest: filter the grid down to it, or duplicate an entry
//                  of a repeated structure.

interface TreeItem {
  key: string;
  title: React.ReactNode;
  searchText: string;
  isLeaf?: boolean;
  children?: TreeItem[];
}

// An indexed step - net-info[3] - is one ENTRY of a repeated structure. That is
// the only place duplicating means anything, and it is what the reader is
// looking at when they want another one.
const INDEXED = /\[\d+\]$/;

/** One entry of a repeated structure, and where it lives. */
interface DuplicableEntry {
  /** the step as the tree shows it, e.g. "net-info[3]" */
  label: string;
  /** the binding's file, which may still be templated ("{folder}/x.xml") */
  file: string;
  /** the entry's own path inside that file */
  path: string;
}

// DuplicateEntryModal asks the one question a copy cannot answer for itself -
// WHICH instance's file to copy in - and then stages the copy exactly as a hand
// edit of the same file would be staged.
//
// The instance question only gets asked when it is real. A shared file has no
// instance, and a fleet of one has no choice to make; asking anyway is a dialog
// that exists to be dismissed.
function DuplicateEntryModal({
  entry,
  instances,
  onClose,
}: {
  entry: DuplicableEntry;
  instances: Instance[];
  onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { selectedInstance, setSection, setFileFocus } = useUI();
  const templated = entry.file.includes("{folder}") || entry.file.includes("{instance}");
  const choices = templated ? instances : [];
  const [instance, setInstance] = useState<string | undefined>(
    () => (choices.find((i) => i.name === selectedInstance) ?? choices[0])?.name,
  );
  const target = choices.find((i) => i.name === instance);
  const file = expandBinding({ file: entry.file, path: entry.path }, target ?? null);

  const dup = useMutation({
    mutationFn: () =>
      api.duplicateEntry({ instance, file, path: entry.path, author: "Local user" }),
    onSuccess: (r) => {
      const copy = r.newPath.split("/").filter(Boolean).pop() ?? "a new entry";
      message.success(
        r.newParameters > 0
          ? `Copied as ${copy}, staged in your draft with ${r.newParameters} setting${r.newParameters === 1 ? "" : "s"} to fill in.`
          : `Copied as ${copy}, staged in your draft.`,
        6,
      );
      qc.invalidateQueries();
      onClose();
      // Land in the file on the copy: the next thing anyone does with a
      // duplicated block is fill it in.
      setFileFocus({ path: r.file, instance, allInstances: !instance });
      setSection("files");
    },
    onError: (e: Error) => message.error(e.message, 8),
  });

  return (
    <Modal
      open
      title={`Duplicate ${entry.label}`}
      okText="Duplicate"
      confirmLoading={dup.isPending}
      onOk={() => dup.mutate()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Typography.Paragraph style={{ marginBottom: 12 }}>
        A copy of this entry is added <b>after the last one</b> in the file, so nothing
        already there is renumbered. Everything it carries comes with it, and the settings
        inside it are staged as new parameters you can then edit.
      </Typography.Paragraph>
      {choices.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Which instance's file
          </Typography.Text>
          <Select
            style={{ width: "100%", marginTop: 4 }}
            value={instance}
            onChange={setInstance}
            options={choices.map((i) => ({ value: i.name, label: i.name }))}
          />
        </div>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }} className="mono">
        {file}
      </Typography.Text>
    </Modal>
  );
}

// prune keeps only what the search box asked for: a node that matches, and
// every ancestor it hangs from so the match can be reached.
//
// antd's own filterTreeNode does not do this - it marks matching nodes and
// leaves the whole tree on screen, which on a catalog of seven hundred
// parameters looks exactly like a search box that does nothing. A branch that
// matches keeps ALL of its children, because somebody who typed the name of a
// folder wants what is in it, not the one child whose name repeats the folder's.
function prune(items: TreeItem[], q: string): TreeItem[] {
  const out: TreeItem[] = [];
  for (const it of items) {
    const self = it.searchText.includes(q);
    if (self) {
      out.push(it);
      continue;
    }
    const kids = it.children ? prune(it.children, q) : [];
    if (kids.length) out.push({ ...it, children: kids });
  }
  return out;
}

// Every group key in a tree, so a search can open exactly the branches it found
// something in.
function keysOf(items: TreeItem[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeItem[]) => {
    for (const it of list) {
      if (it.children?.length) {
        out.push(it.key);
        walk(it.children);
      }
    }
  };
  walk(items);
  return out;
}

// All intermediate dotted prefixes of a name, so revealing a leaf can expand
// exactly the branches that contain it (admin.rebuildslave.x -> [admin,
// admin.rebuildslave]).
//
// The steps come from api.nameSegments, never from splitting the name here: a
// key that itself contains a dot ("query.dependencies") is ONE step, and
// splitting on every dot nested a level the file has never had - and then
// looked for the leaf under a branch that does not exist.
function ancestorPrefixes(parts: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(0, i + 1).join("."));
  return out;
}

export default function CategoryTree({ grid }: { grid: Grid }) {
  const { categoryKey, setCategory, groupKey, setGroup, openGroupEditor, selectParam, selectedParamId, setJump, filters, setFilters } = useUI();
  const [query, setQuery] = useState("");
  const filter = query.trim().toLowerCase();
  const { ref, height } = useElementSize<HTMLDivElement>();
  const treeRef = useRef<GetRef<typeof Tree>>(null);

  // Build the name trie from each parameter's own name STEPS (see
  // api.nameSegments) rather than from splitting its name on every dot. The
  // grid walks this same tree for its row order, so the two cannot disagree.
  const nameRoot = useMemo(() => buildNameTree(grid.rows.map((r) => r.param)), [grid.rows]);

  // The entries a reader can ask for another of: a node that IS one entry of a
  // repeated structure, with a file behind it that says where to copy from.
  //
  // A node's depth is also the number of path steps it spans - the name steps
  // and the XPath steps are the same split (see api.nameSegments) - so the
  // entry's own path is the binding path cut at that depth.
  const dupEntries = useMemo(() => {
    const out = new Map<string, DuplicableEntry>();
    const walk = (n: NameNode) => {
      for (const c of n.children.values()) {
        walk(c);
        if (!INDEXED.test(c.seg) || !c.sample) continue;
        const b = c.sample.bindings?.[0];
        // XML is where repeated elements surface as indexed steps. A YAML or
        // JSON list is folded into one list parameter long before it reaches
        // this tree, so there is no per-entry node to click.
        if (!b?.file || !b.path || b.format !== "xml") continue;
        const steps = b.path.split("/").filter(Boolean);
        if (steps.length < c.depth) continue;
        out.set(c.prefix, {
          label: c.seg,
          file: b.file,
          path: "/" + steps.slice(0, c.depth).join("/"),
        });
      }
    };
    walk(nameRoot);
    return out;
  }, [nameRoot]);

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

  const paramByID = useMemo(() => {
    const m = new Map<string, Parameter>();
    for (const r of grid.rows) m.set(r.param.id, r.param);
    return m;
  }, [grid.rows]);

  const [duplicating, setDuplicating] = useState<DuplicableEntry | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>(allNameKeys);
  // Keep the expand-all default in sync if the catalog changes.
  useEffect(() => setExpandedKeys((prev) => Array.from(new Set([...prev, ...allNameKeys]))), [allNameKeys]);

  const treeData = useMemo(() => {
    // Drawn in the order nameEntries gives - the same call the grid walks for
    // its rows, which is why the last leaf here is the last row there.
    const toItems = (node: NameNode): TreeItem[] =>
      nameEntries(node).map((e) => {
        if (e.kind === "param") {
          const p = e.param;
          return {
            key: `p:${p.id}`,
            isLeaf: true,
            searchText: p.name.toLowerCase(),
            title: (
              <Tooltip title={p.name} placement="right">
                <Typography.Text style={{ fontSize: 12 }} className="mono" ellipsis>
                  {p.leaf}
                </Typography.Text>
              </Tooltip>
            ),
          };
        }
        const c = e.node;
        const entry = dupEntries.get(c.prefix);
        const label = (
          <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{c.seg}</span>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>{c.count}</Typography.Text>
          </span>
        );
        const filtered = categoryKey === c.prefix;
        return {
          key: c.prefix,
          searchText: c.prefix.toLowerCase(),
          // Right-click is where the instructions live, so that clicking a
          // folder can stay the harmless thing it looks like. Duplicating is
          // here too: an entry of a repeated structure answers "give me
          // another one of these", and doing it by hand meant selecting the
          // block in the editor, pasting it, fixing the indentation, and
          // hoping the paste did not land somewhere that renumbered its
          // neighbours.
          title: (
            <Dropdown
              trigger={["contextMenu"]}
              menu={{
                items: [
                  { key: "edit", icon: <EditOutlined />, label: `Edit ${c.count} setting${c.count === 1 ? "" : "s"} here…` },
                  ...(filtered
                    ? []
                    : [{ key: "filter", icon: <FilterFilled />, label: "Show only this group" }]),
                  ...(entry
                    ? [{ key: "dup", icon: <CopyOutlined />, label: `Duplicate ${entry.label}` }]
                    : []),
                ],
                onClick: ({ key, domEvent }) => {
                  domEvent.stopPropagation();
                  if (key === "dup" && entry) setDuplicating(entry);
                  else if (key === "edit") {
                    markBusy();
                    openGroupEditor(c.prefix);
                  }
                  else if (key === "filter") {
                    setCategory(c.prefix);
                    setGroup(c.prefix);
                    selectParam(null);
                  }
                },
              }}
            >
              {label}
            </Dropdown>
          ),
          children: toItems(c),
        };
      });
    return [
      { key: "__all__", searchText: "all parameters", title: <b>All Parameters ({grid.rows.length})</b> },
      ...toItems(nameRoot),
    ];
  }, [nameRoot, dupEntries, grid.rows.length, categoryKey, openGroupEditor, setCategory, setGroup, selectParam]);


  // What the tree actually draws. With nothing typed it is the whole catalog;
  // with a query it is the matches and the branches they hang from, opened so
  // they can be seen. "All Parameters" stays at the top either way - it is the
  // way back, and a way back that disappears when you need it is not one.
  const shown = useMemo(() => {
    if (!filter) return treeData;
    const [all, ...rest] = treeData;
    return [all, ...prune(rest, filter)];
  }, [treeData, filter]);

  // While a search is on, the branches it found something in are open. The
  // reader's own expand/collapse state is untouched and comes back the moment
  // the box is cleared.
  const searchExpanded = useMemo(() => (filter ? keysOf(shown) : []), [filter, shown]);
  const matchCount = useMemo(() => {
    if (!filter) return 0;
    let n = 0;
    const walk = (list: TreeItem[]) => {
      for (const it of list) {
        if (it.isLeaf) n++;
        if (it.children) walk(it.children);
      }
    };
    walk(shown.slice(1));
    return n;
  }, [filter, shown]);

  // Reverse sync: when a parameter becomes selected (typically by clicking a
  // grid row), reveal and scroll to its leaf here.
  const leafKey = selectedParamId ? `p:${selectedParamId}` : null;
  useEffect(() => {
    if (!selectedParamId) return;
    const param = paramByID.get(selectedParamId);
    if (!param) return;
    setExpandedKeys((prev) => Array.from(new Set([...prev, ...ancestorPrefixes(nameSegments(param))])));
    const t = setTimeout(() => treeRef.current?.scrollTo({ key: `p:${selectedParamId}` }), 60);
    return () => clearTimeout(t);
  }, [selectedParamId, paramByID]);

  return (
    <div className="cat-tree" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "8px 8px 0", height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 4px" }}>
          <Typography.Text strong>Parameters</Typography.Text>
        </div>
        <Input.Search
          placeholder="Filter groups and parameters"
          size="small"
          allowClear
          style={{ marginTop: 8 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* The narrowing, said where the narrowing happened. A grid showing 5
            of 721 rows with nothing on screen to explain it is the worst thing
            this panel can do, and the chip is also the way out - which is why
            the toolbar no longer carries a button for it and the right-click
            menu no longer carries its opposite. */}
        <div className="cat-tree-state">
          {filter && (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {matchCount} match{matchCount === 1 ? "" : "es"}
            </Typography.Text>
          )}
          {categoryKey && (
            <Tag
              color="processing"
              closable
              onClose={() => setCategory(null)}
              style={{ marginInlineEnd: 0, maxWidth: "100%" }}
            >
              <FilterFilled style={{ marginInlineEnd: 4 }} />
              Only <span className="mono">{groupLeaf(categoryKey)}</span>
            </Tag>
          )}
        </div>
        <div ref={ref} style={{ flex: 1, minHeight: 0 }}>
          <Tree<TreeItem>
            ref={treeRef}
            treeData={shown}
            blockNode
            showLine={{ showLeafIcon: false }}
            height={Math.max(height, 100)}
            virtual
            expandedKeys={filter ? searchExpanded : expandedKeys}
            onExpand={(keys) => !filter && setExpandedKeys(keys)}
            selectedKeys={leafKey ? [leafKey] : groupKey ? [groupKey] : categoryKey ? [categoryKey] : ["__all__"]}
            onSelect={(keys) => {
              const k = keys[0] as string | undefined;
              if (!k) return;
              if (k.startsWith("p:")) {
                // Parameter leaf: the grid keeps showing everything - just
                // scroll to the row and flash it. Only when an active name
                // filter would hide the row is the filter cleared (never
                // narrowed) so the jump can land.
                const id = k.slice(2);
                const name = paramByID.get(id)?.name ?? "";
                if (categoryKey && name !== categoryKey && !name.startsWith(categoryKey + "."))
                  setCategory(null);
                setGroup(null);
                selectParam(id);
                setJump("param", id);
                return;
              }
              // A group node picks its rows out in the grid and leaves the rest
              // of the estate where it is. It clears the parameter selection,
              // because ?param= refines a view of one row and the reader has
              // just asked for a branch. Picking "All Parameters" is an
              // explicit "show everything", so it also lifts the name filter
              // and the hidden row filters (invalid-only, overrides-only,
              // hide-n/a) - otherwise the list can stay narrowed for a reason
              // nothing on screen explains.
              if (k === "__all__") {
                setCategory(null);
                setGroup(null);
                if (filters.invalidOnly || filters.overriddenOnly || filters.hideNA || filters.files.length)
                  setFilters({ invalidOnly: false, overriddenOnly: false, hideNA: false, files: [] });
              } else {
                setGroup(k);
                // A filter left on from a different branch would hide the very
                // rows this click is asking to see.
                if (categoryKey && k !== categoryKey && !k.startsWith(categoryKey + ".")) setCategory(null);
              }
              selectParam(null);
            }}
            // Double click EDITS the branch: every setting under it as one
            // form. A leaf is one row, which the grid already edits in place,
            // so it opens nothing rather than a dialog around a single cell.
            onDoubleClick={(_e, node) => {
              const k = String((node as unknown as { key: React.Key }).key);
              if (k === "__all__" || k.startsWith("p:")) return;
              // The pointer says so before anything else can: a branch of
              // hundreds has work to do before its dialog can paint, and a
              // double click that produces nothing reads as a double click
              // that missed. Cleared by the dialog itself once it is up.
              markBusy();
              openGroupEditor(k);
            }}
          />
        </div>
      </div>
      {duplicating && (
        <DuplicateEntryModal
          entry={duplicating}
          instances={grid.instances}
          onClose={() => setDuplicating(null)}
        />
      )}
    </div>
  );
}
