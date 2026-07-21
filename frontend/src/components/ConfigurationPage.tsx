import { Dropdown, Badge } from "antd";
import { useMemo } from "react";
import { DownOutlined } from "../icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";
import { useElementSize } from "../hooks";

// ConfigurationPage is the single home of everything about ONE application: a
// quiet underline tab row over the active view. Every tab is a peer and shows
// whenever it fits; only when the strip runs out of room do the lowest-priority
// tabs fold, in order, into a trailing "More". Tabs map 1:1 to the store's
// `section`, so deep links and browser history keep working; this is chrome,
// not a router.

/** Sections that live under the Configuration page (vs. workspace level). */
export const APP_SECTIONS = new Set([
  "overview",
  "config",
  "compare",
  "changes",
  "drafts",
  "approvals",
  "instances",
  "files",
  "drift",
  "import",
  "audit",
]);

// All application tabs, in display AND priority order: earlier tabs win space,
// later ones fold into More first. Parameters (the configuration grid) and
// Files (its underlying truth) sit together up front.
const ALL_TABS: { key: string; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "config", label: "Parameters" },
  { key: "files", label: "Files" },
  { key: "instances", label: "Instances" },
  { key: "changes", label: "Changes" },
  { key: "compare", label: "Compare" },
  { key: "approvals", label: "Approvals" },
  { key: "drift", label: "Repository changes" },
  { key: "audit", label: "Audit" },
  { key: "import", label: "Import settings" },
];

function CountPill({ n, tone = "review" }: { n: number; tone?: "review" | "pending" }) {
  if (!n) return null;
  return (
    <span
      style={{
        minWidth: 16,
        height: 16,
        padding: "0 5px",
        borderRadius: "var(--r-pill)",
        background: `var(--c-${tone}-bg)`,
        border: `1px solid var(--c-${tone}-bd)`,
        color: `var(--c-${tone})`,
        fontSize: 10.5,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
      }}
    >
      {n}
    </span>
  );
}

export default function ConfigurationPage({
  section,
  children,
}: {
  section: string;
  children: React.ReactNode;
}) {
  const { setSection } = useUI();
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 20_000 });
  const findingsQ = useQuery({ queryKey: ["findings"], queryFn: api.findings, refetchInterval: 30_000, retry: false });
  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const awaiting = changesQ.data?.filter((c) => c.state === "under_review").length ?? 0;
  const findings = findingsQ.data?.findings?.length ?? 0;
  const draftItems = draftQ.data?.draft?.items?.length ?? 0;

  // "drafts" is a legacy alias of the Changes view.
  const active = section === "drafts" ? "changes" : section;

  // Count pill a tab carries (drives both display and its width estimate).
  const pillOf = (key: string): number =>
    key === "config" ? draftItems : key === "changes" || key === "approvals" ? awaiting : key === "drift" ? findings : 0;

  const { ref: barRef, width: barW } = useElementSize<HTMLDivElement>();

  // Split the tabs into what fits and what folds. Estimate each tab's width
  // from its label (a monospaced-ish 7.5px/char plus padding, and a little more
  // when it carries a count pill); before the first measurement everything
  // shows. The active tab is always kept visible even if it would otherwise
  // fold, so the current view never hides behind More.
  const { visible, overflow } = useMemo(() => {
    const est = (t: { key: string; label: string }) => t.label.length * 7.5 + 30 + (pillOf(t.key) > 0 ? 22 : 0);
    const avail = barW || 100000;
    const total = ALL_TABS.reduce((s, t) => s + est(t), 0);
    if (total <= avail) return { visible: ALL_TABS, overflow: [] as typeof ALL_TABS };
    const MORE_W = 84;
    const vis: typeof ALL_TABS = [];
    const of: typeof ALL_TABS = [];
    let used = 0;
    for (const t of ALL_TABS) {
      const w = est(t);
      if (used + w <= avail - MORE_W) {
        vis.push(t);
        used += w;
      } else of.push(t);
    }
    // Guarantee the active tab is shown.
    if (active && !vis.some((v) => v.key === active)) {
      const idx = of.findIndex((o) => o.key === active);
      if (idx >= 0) vis.push(of.splice(idx, 1)[0]);
    }
    return { visible: vis, overflow: of };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barW, active, draftItems, awaiting, findings]);

  const moreActive = overflow.find((m) => m.key === active);
  // Attention still living inside the folded set surfaces on the More button.
  const overflowBadge = overflow.reduce((n, t) => n + (t.key === "drift" ? findings : t.key === "approvals" ? awaiting : 0), 0);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface)" }}>
      <div className="app-tabs" role="tablist" ref={barRef} style={{ flexWrap: "nowrap", overflow: "hidden" }}>
        {visible.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={active === t.key}
            className={`app-tab${active === t.key ? " app-tab-active" : ""}`}
            onClick={() => setSection(t.key)}
          >
            {t.label}
            {t.key === "config" && <CountPill n={draftItems} tone="pending" />}
            {t.key === "changes" && <CountPill n={awaiting} />}
            {t.key === "approvals" && <CountPill n={awaiting} />}
            {t.key === "drift" && <CountPill n={findings} tone="pending" />}
          </button>
        ))}
        {overflow.length > 0 && (
          <Dropdown
            trigger={["click"]}
            menu={{
              selectedKeys: moreActive ? [moreActive.key] : [],
              items: overflow.map((m) => ({
                key: m.key,
                label: (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {m.label}
                    {m.key === "drift" && findings > 0 && (
                      <Badge count={findings} size="small" color="var(--c-pending)" />
                    )}
                    {m.key === "approvals" && awaiting > 0 && (
                      <Badge count={awaiting} size="small" color="var(--c-review)" />
                    )}
                  </span>
                ),
              })),
              onClick: ({ key }) => setSection(key),
            }}
          >
            <button className={`app-tab${moreActive ? " app-tab-active" : ""}`}>
              {moreActive ? moreActive.label : "More"}
              {overflowBadge > 0 && !moreActive && <CountPill n={overflowBadge} />}
              <DownOutlined style={{ fontSize: 9, marginLeft: 2 }} />
            </button>
          </Dropdown>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{children}</div>
    </div>
  );
}
