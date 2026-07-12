# Configer — Enterprise UX & Product Design Audit

**Reviewer role:** Principal Product Designer / UX Architect (design review before a hypothetical release to enterprise users)
**Build reviewed:** `main` @ `5e441fa` (PR #11 merged), Go backend + React/Vite/AntD 5 SPA, serving the `telco-platform` sample repository (18 parameters × 6 instances).
**Method:** Backend and frontend deployed locally (`:8080` / `:5173`) and driven end-to-end in a real Chromium browser (Playwright). Every view was exercised (Overview, Configuration grid + Files, Instances, Change Requests, Repository Changes, Compare, History, Approvals, Import, Settings, Plugins), plus the edit → pending → change-request pipeline, the command/search bar, the View/Filter/Add-Parameter menus, light **and** dark themes, and four viewport tiers (phone 390px, tablet 820px, laptop 1280–1440px, ultrawide 2560px). Code was read to confirm root causes where the UI alone was ambiguous.

---

## 1. Executive Summary

Configer is a **genuinely strong, thoughtfully built product** that is already well above the average internal tool. The mental model (rows = parameters, columns = instances, Git as source of truth) is coherent and consistently expressed. Several flows — the change-request review modal, the pending-cell affordances, typed/validated inline editors, the offline resilience, deep-linkable views, and the responsive phone tier — are at or near the bar set by GitHub, Linear, and Stripe.

It is **not yet at world-class enterprise polish**, and the gaps are concentrated in a small number of high-leverage areas:

1. **Dark mode is broken on the primary working surface** (the Configuration editor renders on white while the rest of the app is dark). This is the single most damaging first impression for a product that ships dark mode as a headline feature.
2. **The grid under-uses laptop-class screens** — the surface where users spend 90% of their time shows only 2 of 6 instance columns at 1440px because metadata columns dominate the width.
3. **Accessibility is below WCAG AA** on the custom grid (no ARIA grid semantics, no keyboard cell navigation, editing is mouse-only) and on a few key controls.
4. **The identity/account layer is absent** — the avatar is decorative, there is no user menu, no notification center, and no in-app help.
5. **"Search everything (⌘K)" over-promises** — it is a parameter filter, not the command palette its label implies.

None of these are architectural; all are addressable in a focused polish pass. The recommendations below are ordered by impact.

### What is already excellent (keep and protect)

- **Change-request review modal:** production-touch warning, before→after diff table with per-row undo, required rationale, change-type + reference fields, and a plain-language explanation of exactly what happens in Git. This is best-in-class.
- **Pending-edit affordances:** orange dashed cell, hover "before → after" tooltip, live count badge on *Create Change Request*, details panel updates live. Excellent feedback loop.
- **Typed editing:** per-type editors (toggle/number-with-clamp/enum-dropdown/list-chips), inline validation, scope-source badges, version-aware `new`/`deprecated`/`n/a` cells.
- **Resilience:** deployment-aware "can't connect" state, offline edit queue, per-view skeletons that mirror real layout.
- **Empty states** on Approvals ("Inbox zero" + KPIs) and Repository Changes ("You're all caught up").
- **Responsive strategy:** four real tiers with a sensible read-only phone experience.

---

## 2. Prioritized Findings

Each finding uses: **Severity · Category · Problem · Why it hurts · Recommendation · Reference · User benefit · Effort · Screens.**

---

### CRITICAL / HIGH

#### H-1 · Dark mode does not apply to the Configuration editor
- **Severity:** High
- **Category:** Design system consistency / theming
- **Current problem:** With dark mode active (nav rail and top bar correctly dark, Overview fully dark), navigating to **Configuration** renders the category tree, the parameter grid, and the details panel on **white** backgrounds with dark text. Verified in a single session: `Overview` is fully themed dark while `Configuration` stays light. The AntD dark algorithm *is* applied (the Sider computes `#17181a`), so this is a surface-specific override — the custom grid CSS falls back to `var(--grid-bg, #fff)` and the editor panels do not pick up the token background.
- **Why it hurts:** Dark mode is a headline feature (README, top-bar toggle). The editor is where users spend the vast majority of their time. A white grid inside a dark shell reads as *broken*, not as a theme — it undermines trust in the whole product on first try.
- **Recommendation:** Drive every editor surface from theme tokens: set `--grid-bg` (and any zebra/fixed-column fallbacks) from `token.colorBgContainer` / `colorFillAlter`, remove `#fff` literal fallbacks, and audit `index.css` for hardcoded light values (`#fff`, light zebra tints). Add a visual-regression screenshot test that loads `view=config` in dark mode and asserts a dark cell background so this can't regress.
- **Reference:** GitHub, Linear, Datadog — a single theme applies uniformly to every surface including data grids.
- **User benefit:** A coherent, trustworthy dark experience; reduced eye strain for the long editing sessions this tool is built for.
- **Effort:** Small–Medium
- **Screens:** Configuration (Table + tree + details); verify Import, Compare, Instances, History, Change Requests tables in dark too.

#### H-2 · The grid wastes laptop width; instance columns (the whole point) are crowded out
- **Severity:** High
- **Category:** Layout & screen utilization / tables
- **Current problem:** At 1440px only **2 of 6** instance columns are visible; at 1280px and on tablets, ~1. The four metadata columns (Parameter, Type, Scope, Description) consume the majority of grid width, and the details panel (22%) + tree (16%) further squeeze the center. At 2560px all six instances fit comfortably — proving the content is fine and the *allocation* is the problem. There is no visible horizontal-scroll affordance, no column pinning/reordering, and instance columns cannot be individually hidden.
- **Why it hurts:** In a product whose core metaphor is "columns = instances," seeing only two instances at once defeats the purpose (comparing values across deployments). Users must widen the browser, collapse panels, or hunt through the View menu — cognitive load on the most-used screen.
- **Recommendation:** Prioritize instance columns in the width budget. Concrete moves: (a) fold Type + Scope into compact inline chips within the Parameter cell (as a default density), reclaiming a whole column; (b) make the Description column opt-in / truncate-with-tooltip by default; (c) add an always-available horizontal scroller with a subtle shadow/edge affordance and sticky Parameter column (already sticky — good); (d) add a "fit N instances" quick control and remember it; (e) allow per-instance column hide/pin and column reorder. Consider collapsing the details panel to a slide-over by default in the editor so the grid gets the full center.
- **Reference:** Airtable / Notion tables (row-header stays, data columns dominate, horizontal scroll is first-class); Google Sheets frozen first column; Stripe/Datadog dense tables with column management.
- **User benefit:** See and compare more instances at a glance; the "spreadsheet" promise is fulfilled on the hardware users actually have.
- **Effort:** Medium
- **Screens:** Configuration (Table).

#### H-3 · Accessibility below WCAG AA on the core grid and key controls
- **Severity:** High
- **Category:** Accessibility
- **Current problem:** The custom grid has **no ARIA grid semantics** (no `role="grid"/row/gridcell/columnheader`) and **no keyboard cell navigation** — editing is triggered only by **double-click** and cell actions only by **right-click**, with no keyboard path to either. Across the entire component set there are only **3 ARIA attributes** (all on charts). The **global search input has no visible focus outline** (`outline: none`). Icon-only buttons rely on tooltips, which are not reliably exposed to screen readers as accessible names.
- **Why it hurts:** Keyboard and screen-reader users cannot operate the primary surface at all. Enterprise procurement increasingly requires a VPAT/WCAG AA statement; this would fail. The missing focus ring on search also hurts sighted keyboard users.
- **Recommendation:** (1) Add grid ARIA roles and roving-tabindex keyboard navigation (arrow keys to move, Enter/F2 to edit, Escape to cancel — already wired for mouse, expose to keyboard; Shift+F10/Menu key to open the cell context menu). (2) Restore a visible focus ring on the search input and audit for other `outline:none`. (3) Give every icon-only button an `aria-label` in addition to the tooltip. (4) Add page landmarks and a "skip to grid" link. (5) Verify contrast of the muted gray metadata text and badges against AA (4.5:1).
- **Reference:** AG Grid / Glide Data Grid accessible-grid patterns; GitHub's keyboard-navigable tables; W3C APG "grid" pattern.
- **User benefit:** Keyboard power-users go faster; screen-reader users can work; the product becomes procurement-eligible.
- **Effort:** Medium–Large
- **Screens:** Configuration grid; global search; all icon-only buttons.

#### H-4 · No account/identity layer: avatar is decorative, no user menu, no help
- **Severity:** High (for enterprise readiness)
- **Category:** Missing features / information architecture
- **Current problem:** The top-right avatar (`DU`) has **no click handler and no menu**. There is no profile, no preferences, no sign-out, no "keyboard shortcuts," no "help/docs," no "about/version" (the deployment chip lives only at the bottom of the rail). The notification **bell is only a shortcut to Approvals** — there is no notification center, feed, or history. Auth/SSO is on the roadmap, so identity is understandably stubbed, but the *shell* for it is missing.
- **Why it hurts:** Every enterprise app anchors personalization, session, and help in the avatar menu; its absence makes the product feel like a demo. Users have nowhere to find shortcuts, theme/appearance, or help, and no way to sign out.
- **Recommendation:** Add an avatar dropdown now (even pre-auth): Profile/Account (stub), Appearance (move theme/brand/text-size here from the top bar, or mirror), Keyboard shortcuts, Help & docs, What's new, About (name/version/env). Turn the bell into a real notification popover (recent change-request state transitions, repo findings, sync events) with read/unread, falling back to "You're all caught up."
- **Reference:** GitHub/Linear/Notion avatar menus; Vercel/Datadog notification centers.
- **User benefit:** Discoverable personalization, help, and session control; a shell ready for SSO/RBAC.
- **Effort:** Medium
- **Screens:** Top bar (global).

#### H-5 · "Search everything (⌘K)" is a filter, not a command palette
- **Severity:** Medium–High
- **Category:** Search experience / navigation / productivity
- **Current problem:** The prominent "Search everything… (⌘K)" bar filters parameters/values in the grid and jumps to matches. It is **not** a command palette: no navigation commands (go to Compare, open instance X, switch application), no actions (create change request, import file), no recent/saved searches, no fuzzy cross-entity results, and it only operates within the current application.
- **Why it hurts:** ⌘K sets a strong expectation (Linear/GitHub/Notion/VS Code) of a universal command surface. Labeling it "Search everything" while it searches only parameters within one app is a discoverability and trust mismatch, and it leaves real navigation/action shortcuts unbuilt.
- **Recommendation:** Evolve ⌘K into a true palette with grouped results: **Parameters/values** (current behavior), **Instances**, **Applications**, **Navigation** (all views), **Actions** (create CR, import, toggle theme, focus mode), plus **Recent** and **Saved searches**. Keep the in-grid filter as a separate, clearly-scoped "Search parameters…" box (which already exists in the grid toolbar).
- **Reference:** Linear, GitHub, Notion, Raycast, VS Code command palettes.
- **User benefit:** One keystroke to anywhere/anything; power-user velocity; fulfills the ⌘K promise.
- **Effort:** Medium
- **Screens:** Global (top bar), all views.

---

### MEDIUM

#### M-1 · Semantic color: "production" rendered in danger-red
- **Severity:** Medium
- **Category:** Semantic color usage
- **Current problem:** The `production` environment badge is red/pink (`#f5222d`), including on healthy instances and in the deployment chip. Red conventionally signals error/danger/destruction.
- **Why it hurts:** A healthy production instance flagged red creates false alarm and dilutes red's meaning, so *real* errors read as less urgent. Also risks color-only differentiation.
- **Recommendation:** Reserve red exclusively for errors/failures/destructive actions. Give environments an identity palette that is not overloaded with status (e.g. production = deep blue/indigo, staging = amber, development = green/teal), and keep a separate status color (green healthy / amber degraded / red failing) shown as an icon+label, never color alone.
- **Reference:** AWS/Azure environment tags vs. health status; Datadog monitor colors.
- **User benefit:** Color carries one consistent meaning; alarms are trustworthy.
- **Effort:** Small
- **Screens:** Overview, Instances, Configuration headers, deployment chip.

#### M-2 · Settings is thin and mislabeled as "workspace-wide administration"
- **Severity:** Medium
- **Category:** Information architecture / missing features
- **Current problem:** Settings contains only *Import parameters*, *Manage applications*, and the *Plugins* list, with large empty space. Appearance/theme lives in the top bar (not here); there is no notifications config, no integrations/GitHub-token management surface, no account, no RBAC/SSO placeholders, no default-view or keyboard-shortcut preferences.
- **Why it hurts:** Users look in Settings for exactly the things that aren't there. The page reads as unfinished, and the breadcrumb still shows an app context on a workspace-global page.
- **Recommendation:** Organize Settings into sections (left sub-nav or cards): **Appearance** (theme/brand/density/text size), **Notifications**, **Integrations** (Git providers, tokens, webhooks), **Applications**, **Plugins**, **Members & roles** (stub for RBAC), **Import**. Fix the breadcrumb so global views don't show an application crumb.
- **Reference:** GitHub org settings, Vercel/Stripe settings hubs.
- **User benefit:** One predictable home for configuration; a shell that scales with the roadmap.
- **Effort:** Medium
- **Screens:** Settings; breadcrumb (global).

#### M-3 · Poor use of vertical space; sparse panels on large screens
- **Severity:** Medium
- **Category:** Layout & screen utilization
- **Current problem:** On ultrawide, ~40% of the viewport below the grid is empty. The details panel has large gaps between stat rows. The History view shows a single commit stranded at the top of an otherwise empty page. Tablet shows the grid ending mid-screen with dead space below.
- **Why it hurts:** Wasted space signals low information density and an unfinished feel; it also means users scroll/hunt for content that could be shown at once.
- **Recommendation:** Fill leftover grid space with the documented group-overview strip consistently (it appears at some sizes but not all). In the details panel, tighten spacing and add a live per-parameter value chart / recent-change timeline. Give History a real timeline with filters (author, date, scope) and a per-parameter value history drill-in (the backend already supports it per the changelog). On tablet, let the grid grow to fill height.
- **Reference:** Datadog/Grafana dense dashboards; GitHub commit history density.
- **User benefit:** More at a glance, less scrolling, a more premium feel.
- **Effort:** Medium
- **Screens:** Configuration (ultrawide/tablet), Details panel, History.

#### M-4 · Browser Back/Forward does not traverse in-app navigation
- **Severity:** Medium
- **Category:** Navigation / URL structure
- **Current problem:** Deep-linking works on load and reload (`?app&view&param&inst&files`), which is great. But the store keeps the URL in sync with `history.replaceState` (not `pushState`), so moving between views/parameters creates **no history entries**. The **Back** button therefore leaves the app entirely instead of returning to the previous view; the `popstate` handler exists but has nothing to pop to.
- **Why it hurts:** Back is the most-used navigation control on the web. Users expect Back to undo a navigation; instead it ejects them, which feels broken.
- **Recommendation:** Use `pushState` for meaningful navigations (view/param/instance/app changes) and keep `replaceState` only for transient same-view updates (e.g. toggling files). The existing `popstate` handler already re-applies state correctly.
- **Reference:** Any SPA with proper routing (GitHub, Linear).
- **User benefit:** Back/Forward behave as expected; shareable *and* navigable history.
- **Effort:** Small
- **Screens:** Global.

#### M-5 · Compare is limited to two instances
- **Severity:** Medium
- **Category:** Data visualization / productivity
- **Current problem:** Compare diffs exactly two instances. For a 6-instance (and at scale, dozens-of-instances) product, two-way compare is limiting.
- **Why it hurts:** The most common real question is "how does this value differ across *all* prod regions?" or "which instances drift from baseline?" — not answerable with a pairwise view.
- **Recommendation:** Add N-way compare (pick a baseline, show every instance as a column, highlight cells that differ from baseline) and a "differs-across-instances" filter in the grid itself. The Change column badge is redundant with row color — drop or make it an icon.
- **Reference:** Configu / Kubernetes kustomize overlays diff; spreadsheet conditional formatting.
- **User benefit:** Answer real multi-environment questions in one view.
- **Effort:** Medium
- **Screens:** Compare; Configuration (filter).

#### M-6 · Enterprise productivity primitives missing (saved views, favorites, recents, bulk)
- **Severity:** Medium
- **Category:** Enterprise productivity features
- **Current problem:** No saved views/filters (only density + 3 column toggles persist), no favorites/pinned parameters, no "recently viewed," no multi-select for bulk cell edits (single-cell "copy value to…" exists via right-click, but not multi-cell/row bulk ops), no grid export (CSV/XLSX). Workspace cards have a star, but there's no global "favorites" surface that uses it.
- **Why it hurts:** At the stated scale (tens of thousands of parameters), power users need to save context and act in bulk; without these, every session restarts cold and edits are one-at-a-time.
- **Recommendation:** Add named saved views (category + filters + columns + density + compare pair), favorites/pins with a rail or Overview surface, a recents list, rectangular multi-select with bulk set/reset/exclude/copy, and grid export.
- **Reference:** Airtable views, Jira saved filters, GitHub saved searches, Notion favorites.
- **User benefit:** Faster repeat work, less re-navigation, bulk operations at scale.
- **Effort:** Large
- **Screens:** Configuration, Overview, nav.

---

### LOW

#### L-1 · Empty states without a primary action
- **Severity:** Low
- **Category:** Empty states
- **Problem:** Change Requests empty state explains ("Edit some cells in the Config Editor to start a draft") but offers no button. Others (Approvals, Repo Changes) are stronger.
- **Recommendation:** Add a primary CTA ("Open Config Editor") and, where useful, a doc link/illustration. Standardize the empty-state component so all views match.
- **Effort:** Small · **Screens:** Change Requests, and any other text-only empties.

#### L-2 · Icon-only actions have tooltips but no visible labels or SR names
- **Severity:** Low
- **Category:** Icons / accessibility
- **Problem:** Instances row actions (edit/clone/archive/delete) have tooltips and a delete Popconfirm (good), but no visible labels and tooltip titles aren't guaranteed SR-accessible names.
- **Recommendation:** Add `aria-label` to each; consider a text label or an overflow "⋯" menu with labeled items for the row actions.
- **Effort:** Small · **Screens:** Instances.

#### L-3 · Modals can exceed the viewport
- **Severity:** Low
- **Category:** Micro UX
- **Problem:** The Add Parameter modal is cut off at 900px height (Source file field below the fold), requiring page-level scroll interplay.
- **Recommendation:** Cap modal body height with internal scroll and a sticky footer holding the primary/secondary actions.
- **Effort:** Small · **Screens:** Add Parameter (and audit other tall modals).

#### L-4 · Tables lack in-table search/filter (pattern gap)
- **Severity:** Low
- **Category:** Tables / search
- **Problem:** The Instances table has no search/filter (fine at 6 rows, a gap at scale); no bulk selection/actions there.
- **Recommendation:** Add a search box, column filters, and multi-select bulk actions (archive/label) as instance counts grow.
- **Effort:** Small–Medium · **Screens:** Instances.

#### L-5 · Console noise
- **Severity:** Low
- **Category:** Overall quality / performance
- **Problem:** AntD deprecation warning (`destroyOnClose` → `destroyOnHidden`) and a 404 for a resource on load.
- **Recommendation:** Clear deprecations and the 404 (likely a favicon/asset) so the console is clean — a signal of polish and a prerequisite for spotting real errors.
- **Effort:** Small · **Screens:** Global.

---

### ENHANCEMENTS (raise from "very good" to "world-class")

- **E-1 · Onboarding & help (Medium):** No product tour, no contextual help panel, no in-app docs links. Add a first-run tour of the core loop (edit cell → review → send → approve → publish) and a persistent Help/`?` with searchable docs. *(Ref: Linear onboarding, Stripe docs drawer.)*
- **E-2 · Richer data viz (Medium):** Overview's donut + 14-day sparkline + health tiles are good; add per-parameter value trends, a drift timeline, an environment×parameter difference heatmap, and (later) a dependency/topology view. *(Ref: Datadog, Grafana.)*
- **E-3 · Audit log distinct from Git history (Small–Medium):** History is commit-centric; add an activity/audit log of *who did what in Configer* (edits, submits, approvals, imports, retires) with actor/time/target filters — an enterprise/compliance expectation. *(Ref: GitHub audit log.)*
- **E-4 · Keyboard shortcuts beyond ⌘K (Small):** Add a discoverable shortcut set (`g` then key to switch views, `e` to edit cell, `/` to focus search, `?` for the cheatsheet) surfaced in the avatar menu. *(Ref: GitHub/Linear.)*
- **E-5 · Consistent micro-interactions (Small):** Standardize transition durations/easings, hover/pressed states on custom cells, tooltip open delays, and copy-confirmation feedback so every surface feels part of one system.
- **E-6 · Split/side-by-side views (Medium):** Let users open Compare or Files beside the grid (resizable split) rather than as a full-screen mode switch. *(Ref: VS Code, Figma.)*
- **E-7 · AI assist entry point (Enhancement):** The plugin architecture anticipates an AI provider; reserve a consistent entry (⌘K action + side panel) for "describe a change → draft change request" and "ask across configs."

---

## 3. Category Scorecard

| # | Category | Assessment | Priority fixes |
|---|----------|-----------|----------------|
| 1 | Overall product quality | **Good**, dragged down by dark-mode breakage & sparse shells | H-1, H-4 |
| 2 | Design-system consistency | Good in light; **broken in dark editor** | H-1 |
| 3 | Layout & screen utilization | Under-uses laptop/ultrawide; instance columns crowded | H-2, M-3 |
| 4 | Navigation | Deep-linking good; **Back button broken**; solid IA | M-4 |
| 5 | Information architecture | GitHub-style rail+tabs is strong; Settings thin; breadcrumb slip | M-2 |
| 6 | Forms | **Strong** (autofocus, required markers, validation, file choice) | L-3 |
| 7 | Tables | Grid virtualized & typed; **column allocation** & a11y weak; no export/bulk | H-2, H-3, M-6 |
| 8 | Search | In-app filter good; **no real command palette / cross-app / saved** | H-5, M-6 |
| 9 | User feedback | **Excellent** (pending cells, CR modal, toasts, skeletons) | — |
| 10 | Semantic color | Mostly good; **production=red** overloads danger | M-1 |
| 11 | Icons | Consistent Phosphor set; labels/SR names thin | L-2 |
| 12 | Visual hierarchy | Clear primary CTAs; good emphasis | — |
| 13 | Responsiveness | **4 real tiers**; laptop density is the weak point | H-2 |
| 14 | Accessibility | **Below AA** on grid & search focus | H-3 |
| 15 | Performance | Virtualized grid smooth; console noise only | L-5 |
| 16 | Interaction design | Rich mouse interactions; **keyboard parity missing** | H-3, E-5 |
| 17 | State management | **Strong** (offline queue, snapshots, live sync, deep links) | M-4 |
| 18 | Enterprise productivity | **Gaps**: saved views, favorites, recents, bulk, audit log | M-6, E-3 |
| 19 | Data visualization | Good dashboard start; room for trends/heatmaps/topology | E-2 |
| 20 | Empty states | Mostly good; one lacks a CTA | L-1 |
| 21 | Error recovery | Undo in CR modal, Popconfirm delete, reset-to-inherited: **good** | — |
| 22 | Productivity (clicks) | One-at-a-time editing; no multi-select/bulk | M-6 |
| 23 | Micro UX | Autofocus/Esc/pending all good; modal overflow, transitions | L-3, E-5 |
| 24 | Benchmarking | Competitive on the core loop; behind on shell/a11y/palette | H-1..H-5 |
| 25 | Missing features | Account menu, notifications, help, command palette, saved views, audit log | H-4, H-5, M-6, E-1, E-3 |

---

## 4. Recommended Sequencing

**Phase 1 — "Looks finished" (days):** H-1 (dark-mode editor), M-4 (Back button), L-5 (console), L-1/L-3 (empty-state CTA, modal overflow), M-1 (production color). Highest perceived-quality gain per unit effort.

**Phase 2 — "Feels enterprise" (1–2 sprints):** H-2 (grid column allocation), H-4 (avatar menu + notifications + help shell), M-2 (Settings hub), H-5 (command palette v1).

**Phase 3 — "Procurement-ready & power-user" (2–4 sprints):** H-3 (grid a11y + keyboard), M-6 (saved views/favorites/bulk/export), M-5 (N-way compare), E-3 (audit log), E-1 (onboarding).

**Phase 4 — "Delight":** E-2 (data viz), E-4 (shortcuts), E-5 (micro-interactions), E-6 (split views), E-7 (AI entry).

---

## 5. Methodology & Evidence

- **Deployment:** `go run ./cmd/configer` (backend, `:8080`, `CONFIGER_REPO=../sample-repo`) + `npm run dev` (frontend, `:5173`, proxying `/api`). Both build clean on `main`.
- **Coverage:** All 12 views exercised; edit→pending→change-request pipeline completed (created a real pending edit on `network.admin.port` and opened the review modal); View/Filter/Add-Parameter menus opened; light + dark themes; viewports at 390 / 820 / 1280 / 1440 / 2560 px.
- **Code confirmation:** Root causes verified in source where UI was ambiguous — dark grid fallback (`index.css` `var(--grid-bg,#fff)`, `store.ts`/`theme.ts`), URL sync via `replaceState` (`store.ts`), avatar with no handler and bell→Approvals (`TopBar.tsx`), ARIA coverage (3 attributes total), instance action tooltips (`InstancesView.tsx`).
- **Scope note:** Auth/RBAC/SSO, Postgres cache, schema import, and the AI module are explicitly on the roadmap (`docs/PLAN.md`) and were assessed as *shell readiness*, not judged as missing implementations.

*Prepared as a design review for engineering, product, and design. Findings are opinionated by intent and ordered by impact; even items marked "good" include a path to better.*
