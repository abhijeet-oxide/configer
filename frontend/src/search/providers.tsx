// The built-in search providers. Each is one register() call and reads only
// data the app already holds in the react-query cache, so a keystroke never
// hits the network:
//   - commands    (both surfaces) over the command registry
//   - applications(global)        over the workspace summary
//   - parameters  (app)           over the loaded grid (names, category, values)
//   - changes     (app)           over the application's change requests
// A later phase adds a global server-backed provider for cross-application
// parameters/instances; it registers here the same way and the palette is none
// the wiser.

import { AppstoreOutlined, TableOutlined, PullRequestOutlined, ClusterOutlined } from "../icons";
import { api, bindingsOf, type Grid, type Row, type ChangeState, type RepoSummary, type SearchHitDTO } from "../api";
import { fmtValue } from "../rules";
import { allCommands } from "../commands/registry";
import { register } from "./registry";
import type { HitBadge, SearchHit } from "./types";

// --- commands --------------------------------------------------------------

register({
  id: "commands",
  scope: "both",
  query: (ctx) =>
    allCommands()
      .filter((c) => (c.scope ?? "both") === "both" || c.scope === ctx.mode)
      .filter((c) => !c.when || c.when(ctx.appCtx))
      .map(
        (c): SearchHit => ({
          type: "command",
          id: c.id,
          title: c.title,
          subtitle: c.category,
          icon: c.icon,
          keywords: c.keywords,
          score: 0,
          target: { kind: "command", commandId: c.id },
        }),
      ),
});

// --- applications (global) -------------------------------------------------

function appSubtitle(r: RepoSummary): string {
  const parts = [`${r.params} parameter${r.params === 1 ? "" : "s"}`, `${r.instances} instance${r.instances === 1 ? "" : "s"}`];
  return parts.join(" · ");
}

register({
  id: "applications",
  scope: "global",
  query: (ctx) =>
    (ctx.data.workspace?.repos ?? []).map(
      (r): SearchHit => ({
        type: "application",
        id: r.id,
        title: r.name,
        subtitle: appSubtitle(r),
        icon: <AppstoreOutlined />,
        keywords: [r.name, r.project, r.id, r.branch].filter(Boolean).join(" "),
        score: 0,
        badges: r.drafts ? [{ text: `${r.drafts} draft${r.drafts === 1 ? "" : "s"}` }] : undefined,
        target: { kind: "navigate", app: r.id, view: "overview" },
      }),
    ),
});

// --- parameters (app) ------------------------------------------------------

// paramHit summarizes one grid row the way the palette wants it: the spread of
// values across instances feeds the keyword haystack, so an in-app search
// matches a parameter by its value too (cheap - the grid is already loaded).
function paramHit(row: Row, grid: Grid, repoId: string | null): SearchHit {
  const counts = new Map<string, number>();
  let invalid = 0;
  for (const inst of grid.instances) {
    const c = row.cells[inst.name];
    if (!c || !c.set) continue;
    if (!c.valid) invalid++;
    counts.set(fmtValue(c.value), 1);
  }
  const files = bindingsOf(row.param).map((b) => b.file);
  const source = files.length ? files[0].split("/").pop() ?? files[0] : "unbound";
  const badges: HitBadge[] = [];
  if (invalid > 0) badges.push({ text: `${invalid} invalid`, color: "error" });
  if (row.param.scope === "global") badges.push({ text: "global", color: "purple" });
  return {
    type: "parameter",
    id: row.param.id,
    title: row.param.name,
    subtitle: `${row.param.category} · ${source}`,
    icon: <TableOutlined />,
    keywords: [row.param.displayName, row.param.description, row.param.category, row.param.id, source, ...counts.keys()]
      .filter(Boolean)
      .join(" "),
    score: 0,
    badges: badges.length ? badges : undefined,
    target: { kind: "navigate", app: repoId, view: "config", param: row.param.id },
  };
}

register({
  id: "parameters",
  scope: "app",
  query: (ctx) => {
    const grid = ctx.data.grid;
    if (!grid) return [];
    return grid.rows.map((row) => paramHit(row, grid, ctx.repoId));
  },
});

// --- change requests (app) -------------------------------------------------

const STATE_LABEL: Record<ChangeState, string> = {
  draft: "Draft",
  under_review: "Under review",
  approved: "Approved",
  published: "Published",
  rejected: "Rejected",
};

register({
  id: "changes",
  scope: "app",
  query: (ctx) =>
    (ctx.data.changes ?? []).map(
      (cr): SearchHit => ({
        type: "change",
        id: String(cr.id),
        title: `#${cr.id} ${cr.title}`,
        subtitle: `${STATE_LABEL[cr.state]} · ${cr.author}`,
        icon: <PullRequestOutlined />,
        keywords: [cr.title, cr.reference, cr.category, cr.author, cr.state].filter(Boolean).join(" "),
        score: 0,
        badges: [{ text: STATE_LABEL[cr.state] }],
        target: {
          kind: "navigate",
          app: ctx.repoId,
          view: cr.state === "under_review" ? "approvals" : "changes",
        },
      }),
    ),
});

// --- global cross-application index (server-backed, async) -----------------

// The one provider that reaches beyond the loaded app: parameters, instances,
// and change requests across EVERY application, from GET /api/search. It runs
// only in global mode and only on a non-empty query (empty global is filled
// instantly by the client apps + commands providers), and cancels a superseded
// request so keystrokes do not race. The server already builds each hit's
// target; the client passes it straight through.

function iconFor(type: SearchHitDTO["type"]) {
  if (type === "parameter") return <TableOutlined />;
  if (type === "instance") return <ClusterOutlined />;
  return <PullRequestOutlined />;
}

let inflight: AbortController | null = null;

register({
  id: "global-index",
  scope: "global",
  query: async (_ctx, q) => {
    const query = q.trim();
    if (!query) return [];
    inflight?.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    let res: { hits: SearchHitDTO[] };
    try {
      res = await api.search(query, { scope: "global", limit: 20, signal: ctrl.signal });
    } catch {
      return []; // aborted or offline: yield nothing, local providers still answer
    }
    return res.hits.map(
      (h): SearchHit => ({
        type: h.type,
        id: `${h.appId}:${h.id}`, // param/instance ids are app-scoped; namespace them
        title: h.title,
        subtitle: h.subtitle,
        icon: iconFor(h.type),
        keywords: h.keywords,
        score: 0,
        badges: h.badges,
        target: h.target,
      }),
    );
  },
});
