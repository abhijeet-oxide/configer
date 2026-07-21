import { Modal, Segmented, Tag } from "antd";
import { SearchOutlined } from "../icons";
import { Kbd } from "./ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";
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
  const { setSection, selectParam, setJump, setRepo, repoId, section } = useUI();
  const qc = useQueryClient();

  const [q, setQ] = useState("");
  const [mode, setMode] = useState<SearchScope>("global");
  const [cursor, setCursor] = useState(0);
  const [results, setResults] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const inApp = !!repoId && APP_SECTIONS.has(section);

  // A stable repo switch (setRepo and qc are stable, so this never changes
  // identity). Rebuilding it every render is what made the search effect below
  // re-fire on every keystroke/arrow and reset the cursor - keeping it stable is
  // half of that fix.
  const switchRepo = useCallback(
    (id: string | null) => {
      setRepo(id);
      qc.clear();
    },
    [setRepo, qc],
  );

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
    const t = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [open, openedMode, inApp]);

  // The cursor returns to the top only when the query or mode changes - never on
  // an unrelated re-render, so arrow-key navigation stays put.
  useEffect(() => setCursor(0), [q, mode]);

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

  const appCtx: AppCtx = useMemo(() => ({ repoId, section, inApp, nav }), [repoId, section, inApp, nav]);

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

  // Run the providers whenever the query, mode, or underlying data changes. The
  // ctx above is now stable across unrelated renders, so this fires only on real
  // input changes. A guard drops a stale in-flight result; the cursor is clamped
  // (not reset) so a shrinking result set never yanks the selection to the top.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const id = setTimeout(() => {
      queryAll(ctx, q).then((hits) => {
        if (cancelled) return;
        setResults(hits);
        setCursor((c) => Math.min(c, Math.max(0, hits.length - 1)));
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
  }, [cursor, results]);

  const choose = (hit: SearchHit) => {
    close();
    resolveTarget(hit.target, appCtx);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (results.length ? (c + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (results.length ? (c - 1 + results.length) % results.length : 0));
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
      style={{ top: "12vh" }}
      styles={{
        body: { padding: 0 },
        content: {
          padding: 0,
          overflow: "hidden",
          borderRadius: 16,
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-neu-lg)",
          background: "var(--surface)",
        },
      }}
      destroyOnClose
    >
      {/* Input row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "15px 18px", borderBottom: "1px solid var(--border)" }}>
        <SearchOutlined style={{ fontSize: 18, color: "var(--text-3)" }} />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 16,
            color: "var(--text)",
          }}
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
      </div>

      {/* Results */}
      <div ref={listRef} style={{ maxHeight: "56vh", overflow: "auto", padding: 8 }}>
        {results.length === 0 ? (
          <div style={{ padding: "44px 16px", textAlign: "center", color: "var(--text-3)" }}>
            <SearchOutlined style={{ fontSize: 26, opacity: 0.35 }} />
            <div style={{ marginTop: 10, fontSize: 13 }}>
              {loading ? "Loading…" : q ? `No matches for "${q.trim()}"` : "Search across your applications, or jump to anything."}
            </div>
          </div>
        ) : (
          results.map((r, i) => {
            const active = i === cursor;
            return (
              <div
                key={`${r.type}:${r.id}`}
                data-idx={i}
                onMouseMove={() => setCursor(i)}
                onClick={() => choose(r)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "8px 10px",
                  borderRadius: 10,
                  cursor: "pointer",
                  // Neutral, low-contrast highlight (no brand glow); a thin left
                  // accent marks the selection without straining the eye.
                  background: active ? "var(--surface-2)" : "transparent",
                  boxShadow: active ? "inset 2px 0 0 var(--brand-border)" : "none",
                }}
              >
                {/* Icon tile */}
                <span
                  style={{
                    width: 30,
                    height: 30,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 9,
                    border: "1px solid var(--border)",
                    background: active ? "var(--surface)" : "var(--surface-2)",
                    color: active ? "var(--text)" : "var(--text-3)",
                    fontSize: 15,
                  }}
                >
                  {r.icon}
                </span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      className={r.type === "parameter" ? "mono" : undefined}
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: "var(--text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
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
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--text-3)",
                        marginTop: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.subtitle}
                    </div>
                  )}
                </div>

                {/* Trailing: an Enter hint on the active row, the type otherwise. */}
                {active ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, color: "var(--text-3)", fontSize: 11 }}>
                    Open <Kbd>↵</Kbd>
                  </span>
                ) : (
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: 0.3,
                      textTransform: "uppercase",
                      color: "var(--text-3)",
                      background: "var(--surface-2)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "1px 7px",
                    }}
                  >
                    {TYPE_LABEL[r.type]}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer legend */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "9px 16px",
          borderTop: "1px solid var(--border)",
          fontSize: 11.5,
          color: "var(--text-3)",
          background: "var(--surface-2)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <Kbd>↵</Kbd> open
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <Kbd>esc</Kbd> close
        </span>
        {results.length > 0 && (
          <span style={{ marginLeft: "auto" }}>
            {results.length} result{results.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </Modal>
  );
}
