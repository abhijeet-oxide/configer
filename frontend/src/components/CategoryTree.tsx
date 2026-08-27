import {
  Checkbox, Dropdown, Modal, Select, Tooltip, Tree, Typography, Input,
  App as AntApp, type GetRef,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CopyOutlined, EditOutlined, FilterFilled } from "../icons";
import { api, expandBinding, nameSegments, type Grid, type Instance, type Parameter } from "../api";
import { useElementSize } from "../hooks";
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

// A node in the parameter-name trie.
interface NameNode {
  seg: string;
  prefix: string; // full dotted prefix, e.g. "admin.rebuildslave"
  depth: number; // how many steps deep, which is also how many path steps it spans
  count: number; // parameters in this subtree
  params: { id: string; name: string; leaf: string }[];
  children: Map<string, NameNode>;
  // A parameter from anywhere under this node, so the node can answer "which
  // file, and where in it" without the tree carrying bindings of its own.
  sample?: Parameter;
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
  const [filter, setFilter] = useState("");
  const [showFull, setShowFull] = useState(false);
  const { ref, height } = useElementSize<HTMLDivElement>();
  const treeRef = useRef<GetRef<typeof Tree>>(null);

  // Build the name trie from each parameter's own name STEPS (see
  // api.nameSegments) rather than from splitting its name on every dot.
  const nameRoot = useMemo(() => {
    const root: NameNode = { seg: "", prefix: "", depth: 0, count: 0, params: [], children: new Map() };
    for (const r of grid.rows) {
      const name = r.param.name;
      const parts = nameSegments(r.param);
      const leaf = parts[parts.length - 1];
      let level = root;
      let prefix = "";
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        prefix = prefix ? `${prefix}.${seg}` : seg;
        let node = level.children.get(seg);
        if (!node) {
          node = { seg, prefix, depth: i + 1, count: 0, params: [], children: new Map() };
          level.children.set(seg, node);
        }
        node.count++;
        if (!node.sample) node.sample = r.param;
        level = node;
      }
      level.params.push({ id: r.param.id, name, leaf });
    }
    return root;
  }, [grid.rows]);

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
    // A node's children (sub-groups AND its own leaf params) are ordered by
    // segment together, so the tree reads in the same order as the grid table
    // (which sorts by full name).
    const toItems = (node: NameNode): TreeItem[] => {
      const entries: { seg: string; item: TreeItem }[] = [];
      for (const c of node.children.values()) {
        const entry = dupEntries.get(c.prefix);
        const label = (
          <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{c.seg}</span>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>{c.count}</Typography.Text>
          </span>
        );
        const filtered = categoryKey === c.prefix;
        entries.push({
          seg: c.seg,
          item: {
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
                    {
                      key: "filter",
                      icon: <FilterFilled />,
                      label: filtered ? "Stop showing only this group" : "Show only this group",
                    },
                    ...(entry
                      ? [{ key: "dup", icon: <CopyOutlined />, label: `Duplicate ${entry.label}` }]
                      : []),
                  ],
                  onClick: ({ key, domEvent }) => {
                    domEvent.stopPropagation();
                    if (key === "dup" && entry) setDuplicating(entry);
                    else if (key === "edit") openGroupEditor(c.prefix);
                    else if (key === "filter") {
                      setCategory(filtered ? null : c.prefix);
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
  }, [nameRoot, dupEntries, grid.rows.length, showFull, categoryKey, openGroupEditor, setCategory, setGroup, selectParam]);


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
              openGroupEditor(k);
            }}
            filterTreeNode={filter ? (node) => node.searchText.includes(filter) : undefined}
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
