import { useMemo, useRef, useState } from "react";
import { Button, Checkbox, Popconfirm, Tooltip } from "antd";
import { PlusCircleOutlined, MinusCircleOutlined, RightOutlined } from "../icons";
import { vsFileIcon, vsFolderIcon } from "./vsIcons";

// FileExplorer is THE file tree of the product - the Files workspace, the
// onboarding and import wizards and the path picker all render this one
// component so trees look and behave identically everywhere. It is hand-built
// to VS Code's standard: 22px rows, compact single-child folder chains
// (instances/prod collapses to one row), rotating chevrons, indent guides,
// vscode-icons file glyphs, end-ellipsis names that adapt to the panel width,
// right-aligned state badges (managed dot, M modified, U new) and hover
// actions. Arrow keys walk it like an editor. An optional checkable mode adds
// tri-state checkboxes (folders reflect and toggle their descendants), which
// is how the wizards pick files.

export interface ExplorerState {
  changed: Set<string>;
  created: Set<string>;
  managed: Set<string>;
}

const EMPTY_STATE: ExplorerState = {
  changed: new Set(),
  created: new Set(),
  managed: new Set(),
};

interface DirNode {
  name: string; // display name; compact chains join with "/"
  key: string; // full path prefix ending in "/"
  dirs: DirNode[];
  files: string[]; // full paths
}

interface RowItem {
  key: string; // folder key ("x/y/") or file path
  name: string;
  depth: number;
  isDir: boolean;
  open?: boolean;
}

function buildTree(paths: string[]): DirNode {
  const root: DirNode = { name: "", key: "", dirs: [], files: [] };
  const dirOf = new Map<string, DirNode>([["", root]]);
  for (const p of [...paths].sort()) {
    const parts = p.split("/");
    let key = "";
    let cur = root;
    for (const seg of parts.slice(0, -1)) {
      key += seg + "/";
      let d = dirOf.get(key);
      if (!d) {
        d = { name: seg, key, dirs: [], files: [] };
        cur.dirs.push(d);
        dirOf.set(key, d);
      }
      cur = d;
    }
    cur.files.push(p);
  }
  // Compact chains: a folder whose only content is one subfolder merges into
  // it (VS Code's "compact folders"), so deep GitOps paths stay one row.
  const compact = (d: DirNode): DirNode => {
    while (d.dirs.length === 1 && d.files.length === 0) {
      const child = d.dirs[0];
      d = { ...child, name: d.name ? `${d.name}/${child.name}` : child.name };
    }
    return { ...d, dirs: d.dirs.map(compact) };
  };
  return { ...root, dirs: root.dirs.map(compact) };
}

export default function FileExplorer({
  files,
  selected = null,
  state = EMPTY_STATE,
  onSelect,
  onAdd,
  onRemove,
  checked,
  onCheck,
  checkDisabled,
  meta,
}: {
  files: string[];
  selected?: string | null;
  state?: ExplorerState;
  onSelect?: (path: string) => void;
  /** add a file or folder prefix to management (scan for settings) */
  onAdd?: (prefix: string) => void;
  /** stop managing a file (retire its parameters) */
  onRemove?: (file: string) => void;
  /** checkable mode: the currently checked file paths */
  checked?: Set<string>;
  /** checkable mode: called with the full next set of checked file paths */
  onCheck?: (checked: Set<string>) => void;
  /** checkable mode: files whose checkbox cannot be changed */
  checkDisabled?: Set<string>;
  /** small right-aligned annotation per file row (counts, tags) */
  meta?: (path: string) => React.ReactNode;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const checkable = !!onCheck;

  const tree = useMemo(() => buildTree(files), [files]);

  const rows = useMemo(() => {
    const out: RowItem[] = [];
    const walk = (d: DirNode, depth: number) => {
      for (const sub of d.dirs) {
        const open = !closed.has(sub.key);
        out.push({ key: sub.key, name: sub.name, depth, isDir: true, open });
        if (open) walk(sub, depth + 1);
      }
      for (const f of d.files) {
        out.push({ key: f, name: f.split("/").pop() ?? f, depth, isDir: false });
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, closed]);

  const toggle = (key: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Checkable mode: a folder speaks for the toggleable files underneath it.
  const toggleFiles = (paths: string[], to: boolean) => {
    if (!onCheck || !checked) return;
    const next = new Set(checked);
    for (const p of paths) {
      if (checkDisabled?.has(p)) continue;
      if (to) next.add(p);
      else next.delete(p);
    }
    onCheck(next);
  };
  const filesUnder = (dirKey: string) => files.filter((f) => f.startsWith(dirKey));

  const activate = (r: RowItem) => {
    setCursor(r.key);
    if (r.isDir) toggle(r.key);
    else if (checkable) {
      if (!checkDisabled?.has(r.key)) toggleFiles([r.key], !checked?.has(r.key));
    } else onSelect?.(r.key);
  };

  // Arrow-key navigation over the visible rows, VS Code style.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = rows.findIndex((r) => r.key === (cursor ?? selected));
    const move = (d: number) => {
      const next = rows[Math.min(rows.length - 1, Math.max(0, idx + d))];
      if (next) {
        setCursor(next.key);
        if (!next.isDir && !checkable) onSelect?.(next.key);
      }
    };
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "ArrowRight") {
      const r = rows[idx];
      if (r?.isDir && !r.open) {
        e.preventDefault();
        toggle(r.key);
      }
    } else if (e.key === "ArrowLeft") {
      const r = rows[idx];
      if (r?.isDir && r.open) {
        e.preventDefault();
        toggle(r.key);
      }
    } else if (e.key === "Enter" || (e.key === " " && checkable)) {
      const r = rows[idx];
      if (r) {
        e.preventDefault();
        activate(r);
      }
    }
  };

  return (
    <div
      ref={boxRef}
      className="fx"
      tabIndex={0}
      role="tree"
      onKeyDown={onKeyDown}
      style={{ outline: "none" }}
    >
      {rows.map((r) => {
        const isSelected = !r.isDir && r.key === selected;
        const isCursor = r.key === cursor;
        const managed = !r.isDir && state.managed.has(r.key);
        const created = state.created.has(r.key);
        const modified = !created && state.changed.has(r.key);
        let box: React.ReactNode = null;
        if (checkable && checked) {
          if (r.isDir) {
            const under = filesUnder(r.key);
            const on = under.filter((f) => checked.has(f)).length;
            box = (
              <Checkbox
                className="fx-check"
                checked={on > 0 && on === under.length}
                indeterminate={on > 0 && on < under.length}
                disabled={under.every((f) => checkDisabled?.has(f))}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => toggleFiles(under, e.target.checked)}
              />
            );
          } else {
            box = (
              <Checkbox
                className="fx-check"
                checked={checked.has(r.key)}
                disabled={checkDisabled?.has(r.key)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => toggleFiles([r.key], e.target.checked)}
              />
            );
          }
        }
        return (
          <div
            key={r.key}
            role="treeitem"
            aria-expanded={r.isDir ? r.open : undefined}
            aria-selected={isSelected}
            className={`fx-row${isSelected ? " fx-selected" : ""}${isCursor && !isSelected ? " fx-cursor" : ""}`}
            onClick={() => activate(r)}
            title={r.isDir ? r.name : r.key}
          >
            {Array.from({ length: r.depth }).map((_, i) => (
              <span key={i} className="fx-guide" />
            ))}
            <span className={`fx-chevron${r.isDir && r.open ? " fx-chevron-open" : ""}`}>
              {r.isDir && <RightOutlined style={{ fontSize: 9 }} />}
            </span>
            {box}
            {r.isDir ? vsFolderIcon(!!r.open) : vsFileIcon(r.name)}
            <span className={`fx-name${created ? " fx-created" : ""}${modified ? " fx-modified" : ""}`}>
              {r.name}
            </span>
            {!r.isDir && meta && <span className="fx-meta">{meta(r.key)}</span>}
            <span className="fx-actions" onClick={(e) => e.stopPropagation()}>
              {!r.isDir && managed && onRemove ? (
                <Popconfirm
                  title="Stop managing this file?"
                  description="Its parameters are retired (removed from the catalog); the file itself is untouched."
                  okText="Stop managing"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => onRemove(r.key)}
                >
                  <Tooltip title="Stop managing (retire its parameters)">
                    <Button size="small" type="text" icon={<MinusCircleOutlined style={{ fontSize: 11 }} />} />
                  </Tooltip>
                </Popconfirm>
              ) : onAdd ? (
                <Tooltip title={r.isDir ? "Scan this folder for settings" : "Add to managed: scan this file for settings"}>
                  <Button
                    size="small"
                    type="text"
                    icon={<PlusCircleOutlined style={{ fontSize: 11 }} />}
                    onClick={() => onAdd(r.key)}
                  />
                </Tooltip>
              ) : null}
            </span>
            <span className="fx-badges">
              {managed && (
                <Tooltip title="Managed: parameters map into this file">
                  <span className="fx-dot" />
                </Tooltip>
              )}
              {created && (
                <Tooltip title="New: added in your draft, not committed yet">
                  <span className="fx-mark fx-mark-u">U</span>
                </Tooltip>
              )}
              {modified && (
                <Tooltip title="Modified: carries pending draft changes">
                  <span className="fx-mark fx-mark-m">M</span>
                </Tooltip>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
