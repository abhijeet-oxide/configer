import { Modal, Segmented, Tag } from "antd";
import { SearchOutlined } from "../icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import {
  queryAll,
  resolveTarget,
  useSearchOpen,
  type AppCtx,
  type Nav,
  type SearchContext,
  type SearchHit,
  type SearchScope,
} from "../search";

// SearchPalette is the one "search anything, go anywhere" surface. It runs in
// two modes over a single set of registered providers: GLOBAL (applications,
// change requests, and every registered action/navigation - offered from
// anywhere) and APP (the open application's parameters, values, and changes,
// over the already-loaded grid). Every result carries a structured target, so
// selecting one navigates through the same deep-links the store owns. Adding a
// new searchable entity or action never touches this file - it registers a
// provider or a command and appears here automatically.

// The sections that belong to one application (mirrors the store's routing set);
// used to decide whether "this application" search is available.
const APP_SECTIONS = new Set([
  "overview", "config", "compare", "changes", "drafts", "approvals", "instances", "files", "drift", "import", "audit",
]);

const TYPE_LABEL: Record<SearchHit["type"], string> = {
  application: "App",
  parameter: "Parameter",
  instance: "Instance",
  change: "Change",
  command: "Action",
  file: "File",
};

export default function SearchPalette() {
  const { open, mode: openedMode, close, toggle } = useSearchOpen();
  const { setSection, selectParam, setJump, repoId, section } = useUI();
  const switchRepo = useSwitchRepo();

  const [q, setQ] = useState("");
  const [mode, setMode] = useState<SearchScope>("global");
  const [cursor, setCursor] = useState(0);
  const [results, setResults] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const inApp = !!repoId && APP_SECTIONS.has(section);

  // Cmd/Ctrl-K opens (and toggles closed). It opens on the surface that fits
  // where you are: inside an application it defaults to searching that app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle(inApp ? "app" : "global");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, inApp]);

  // On open, adopt the requested mode (falling back to global when no app is
  // open) and reset the query.
  useEffect(() => {
    if (!open) return;
    setMode(inApp ? openedMode : "global");
    setQ("");
    setCursor(0);
    const t = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [open, openedMode, inApp]);

  // The data providers search over - all from the shared react-query cache, so
  // opening the palette does not trigger fetches when a view already loaded it.
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, enabled: open, staleTime: 30_000 });
  const gridQ = useQuery({ queryKey: ["grid"], queryFn: api.grid, enabled: open && mode === "app" && !!repoId });
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, enabled: open && mode === "app" && !!repoId });

  const nav: Nav = useMemo(
    () => ({
      switchRepo,
      setSection,
      selectParam,
      setJump,
      openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    }),
    [switchRepo, setSection, selectParam, setJump],
  );

  const appCtx: AppCtx = useMemo(
    () => ({ repoId, section, inApp, nav }),
    [repoId, section, inApp, nav],
  );

  const ctx: SearchContext = useMemo(
    () => ({
      mode,
      repoId,
      inApp,
      data: { workspace: wsQ.data, grid: gridQ.data, changes: changesQ.data },
      appCtx,
    }),
    [mode, repoId, inApp, wsQ.data, gridQ.data, changesQ.data, appCtx],
  );

  // Run the providers whenever the query, mode, or underlying data changes. A
  // guard drops a stale in-flight result if inputs change before it resolves.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const id = setTimeout(() => {
      queryAll(ctx, q).then((hits) => {
        if (!cancelled) {
          setResults(hits);
          setCursor(0);
        }
      });
    }, 40);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [open, q, ctx]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (hit: SearchHit) => {
    close();
    resolveTarget(hit.target, appCtx);
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
      const hit = results[cursor];
      if (hit) choose(hit);
    }
  };

  const loading = (mode === "app" && (gridQ.isLoading || changesQ.isLoading)) || wsQ.isLoading;
  const placeholder =
    mode === "app" ? "Search parameters, values, changes, or an action…" : "Search applications, actions, or a section…";

  return (
    <Modal
      open={open}
      onCancel={close}
      footer={null}
      closable={false}
      width={640}
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
          placeholder={placeholder}
          style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 16, color: "var(--text-1)" }}
        />
        {repoId && (
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => setMode(v as SearchScope)}
            options={[
              { label: "Global", value: "global" },
              { label: "This app", value: "app" },
            ]}
          />
        )}
        <kbd style={{ fontSize: 11, color: "var(--text-3)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px" }}>esc</kbd>
      </div>

      <div ref={listRef} style={{ maxHeight: 440, overflow: "auto", padding: 6 }}>
        {results.length === 0 && (
          <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--text-3)", fontSize: 13 }}>
            {loading ? "Loading…" : q ? `No matches for "${q.trim()}"` : "Type to search."}
          </div>
        )}
        {results.map((r, i) => {
          const active = i === cursor;
          return (
            <div
              key={`${r.type}:${r.id}`}
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
              <span style={{ color: "var(--text-3)", display: "flex", flexShrink: 0 }}>{r.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    className={r.type === "parameter" ? "mono" : undefined}
                    style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {r.title}
                  </span>
                  {r.badges?.map((b) => (
                    <Tag key={b.text} color={b.color} style={{ margin: 0, fontSize: 10, lineHeight: "16px" }}>
                      {b.text}
                    </Tag>
                  ))}
                </div>
                {r.subtitle && (
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.subtitle}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11, color: "var(--text-3)", flexShrink: 0 }}>{TYPE_LABEL[r.type]}</span>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 16, padding: "8px 16px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-3)" }}>
        <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </Modal>
  );
}
