import { useMemo, useRef, useState } from "react";
import { Button, Popconfirm, Tooltip } from "antd";
import { PlusCircleOutlined, MinusCircleOutlined, RightOutlined } from "../icons";
import { vsFileIcon, vsFolderIcon } from "./vsIcons";

// FileExplorer is a hand-built, VS Code-grade file tree: 22px rows, compact
// single-child folder chains (instances/prod collapses to one row), rotating
// chevrons, indent guides, vscode-icons file glyphs, end-ellipsis names that
// adapt to the panel width, right-aligned state badges (managed dot, M
// modified, U new) and hover actions. Arrow keys walk it like an editor.

export interface ExplorerState {
  changed: Set<string>;
  created: Set<string>;
  managed: Set<string>;
}

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
  selected,
  state,
  onSelect,
  onAdd,
  onRemove,
}: {
  files: string[];
  selected: string | null;
  state: ExplorerState;
  onSelect: (path: string) => void;
  /** add a file or folder prefix to management (scan for settings) */
  onAdd?: (prefix: string) => void;
  /** stop managing a file (retire its parameters) */
  onRemove?: (file: string) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

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

  const activate = (r: RowItem) => {
    setCursor(r.key);
    if (r.isDir) toggle(r.key);
    else onSelect(r.key);
  };

  // Arrow-key navigation over the visible rows, VS Code style.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = rows.findIndex((r) => r.key === (cursor ?? selected));
    const move = (d: number) => {
      const next = rows[Math.min(rows.length - 1, Math.max(0, idx + d))];
      if (next) {
        setCursor(next.key);
        if (!next.isDir) onSelect(next.key);
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
    } else if (e.key === "Enter") {
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
            {r.isDir ? vsFolderIcon(!!r.open) : vsFileIcon(r.name)}
            <span className={`fx-name${created ? " fx-created" : ""}${modified ? " fx-modified" : ""}`}>
              {r.name}
            </span>
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
