import { Modal, Tag } from "antd";
import { SearchOutlined, ArrowRightOutlined } from "../icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, bindingsOf, type Grid, type Row } from "../api";
import { fmtValue } from "../rules";
import { useUI } from "../store";

// CommandPalette is the parameter-first "search everything" surface behind
// Cmd/Ctrl-K. Type a parameter name (or value, file, description) and see its
// whole picture at once - the spread of values across instances, where it is
// defined, and whether anything is invalid - then press Enter to land on that
// row in Configure. A short list of navigation commands rides along so the
// same key jumps between sections without leaving the keyboard.

interface ParamResult {
  kind: "param";
  id: string;
  name: string;
  category: string;
  scope: string;
  invalid: number;
  /** distinct effective values across instances, most common first */
  spread: { value: string; count: number }[];
  source: string;
  hay: string;
}

interface NavResult {
  kind: "nav";
  id: string;
  label: string;
  section: string;
  hay: string;
}

type Result = ParamResult | NavResult;

const NAV: { id: string; label: string; section: string }[] = [
  { id: "nav-overview", label: "Overview", section: "overview" },
  { id: "nav-configure", label: "Configure", section: "config" },
  { id: "nav-instances", label: "Instances", section: "instances" },
  { id: "nav-changes", label: "Changes", section: "changes" },
  { id: "nav-inbox", label: "Inbox (approvals)", section: "inbox" },
  { id: "nav-home", label: "Home", section: "home" },
  { id: "nav-applications", label: "Applications", section: "workspace" },
];

function summarize(row: Row, grid: Grid): ParamResult {
  const counts = new Map<string, number>();
  let invalid = 0;
  for (const inst of grid.instances) {
    const c = row.cells[inst.name];
    if (!c || !c.set) continue;
    if (!c.valid) invalid++;
    const v = fmtValue(c.value);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const spread = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
  const files = bindingsOf(row.param).map((b) => b.file);
  const source = files.length ? files[0].split("/").pop() ?? files[0] : "unbound";
  return {
    kind: "param",
    id: row.param.id,
    name: row.param.name,
    category: row.param.category,
    scope: row.param.scope,
    invalid,
    spread,
    source,
    hay: [row.param.name, row.param.displayName, row.param.description, row.param.category, row.param.id, source]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  };
}

export default function CommandPalette() {
  const { setSection, selectParam, setJump, repoId } = useUI();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const gridQ = useQuery({ queryKey: ["grid"], queryFn: api.grid, enabled: open && !!repoId });
  const grid = gridQ.data;

  // Cmd/Ctrl-K opens; it toggles so a second press (or Esc) closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setCursor(0);
      // Focus after the modal has mounted its input.
      const t = setTimeout(() => inputRef.current?.focus(), 40);
      return () => clearTimeout(t);
    }
  }, [open]);

  const params = useMemo(() => (grid ? grid.rows.map((r) => summarize(r, grid)) : []), [grid]);

  const results = useMemo<Result[]>(() => {
    const query = q.trim().toLowerCase();
    const navHits: NavResult[] = NAV.map(
      (n): NavResult => ({ kind: "nav", id: n.id, label: n.label, section: n.section, hay: n.label.toLowerCase() }),
    ).filter((n) => !query || n.hay.includes(query));
    const paramHits = (query ? params.filter((p) => p.hay.includes(query)) : params).slice(0, 50);
    // Parameters lead (the primary job); navigation trails.
    return [...paramHits, ...navHits];
  }, [q, params]);

  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (r: Result) => {
    setOpen(false);
    if (r.kind === "nav") {
      setSection(r.section);
      return;
    }
    setSection("config");
    selectParam(r.id);
    setJump("param", r.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[cursor];
      if (r) choose(r);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      closable={false}
      width={620}
      style={{ top: 90 }}
      styles={{ body: { padding: 0 }, content: { padding: 0, overflow: "hidden" } }}
      destroyOnClose
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
        <SearchOutlined style={{ fontSize: 16, color: "var(--text-3)" }} />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={repoId ? "Search parameters, values, files, or a section…" : "Search sections…"}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 16,
            color: "var(--text-1)",
          }}
        />
        <kbd style={{ fontSize: 11, color: "var(--text-3)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px" }}>esc</kbd>
      </div>

      <div ref={listRef} style={{ maxHeight: 420, overflow: "auto", padding: 6 }}>
        {results.length === 0 && (
          <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--text-3)", fontSize: 13 }}>
            {gridQ.isLoading ? "Loading…" : q ? `No matches for "${q.trim()}"` : "Type to search."}
          </div>
        )}
        {results.map((r, i) => {
          const active = i === cursor;
          return (
            <div
              key={r.id}
              data-idx={i}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(r)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "9px 12px",
                borderRadius: 8,
                cursor: "pointer",
                background: active ? "var(--surface-2)" : "transparent",
              }}
            >
              {r.kind === "nav" ? (
                <>
                  <ArrowRightOutlined style={{ color: "var(--text-3)" }} />
                  <span style={{ flex: 1, fontSize: 14 }}>Go to {r.label}</span>
                  <span style={{ fontSize: 11, color: "var(--text-3)" }}>Section</span>
                </>
              ) : (
                <>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.name}
                      </span>
                      {r.invalid > 0 && (
                        <Tag color="error" style={{ margin: 0, fontSize: 10, lineHeight: "16px" }}>
                          {r.invalid} invalid
                        </Tag>
                      )}
                      {r.scope === "global" && (
                        <Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: "16px" }}>global</Tag>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.category} · {r.source}
                    </div>
                  </div>
                  <ValueSpread spread={r.spread} />
                </>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 16, padding: "8px 16px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-3)" }}>
        <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> open in Configure</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </Modal>
  );
}

// ValueSpread shows the distribution of a parameter's value across instances:
// the most common values first, each with how many instances hold it. A single
// chip means every instance agrees; several means the value varies.
function ValueSpread({ spread }: { spread: { value: string; count: number }[] }) {
  if (spread.length === 0) return <span style={{ fontSize: 11, color: "var(--text-3)" }}>not set</span>;
  const shown = spread.slice(0, 3);
  const more = spread.length - shown.length;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0, maxWidth: 260, overflow: "hidden" }}>
      {shown.map((s) => (
        <span
          key={s.value}
          className="mono"
          title={`${s.value} on ${s.count} instance${s.count === 1 ? "" : "s"}`}
          style={{
            fontSize: 11,
            padding: "1px 6px",
            borderRadius: 10,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 120,
          }}
        >
          {s.value === "" ? "(empty)" : s.value}
          <span style={{ color: "var(--text-3)", marginLeft: 4 }}>{s.count}</span>
        </span>
      ))}
      {more > 0 && <span style={{ fontSize: 11, color: "var(--text-3)" }}>+{more}</span>}
    </div>
  );
}
