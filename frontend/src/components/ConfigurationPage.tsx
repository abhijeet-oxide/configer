import { Dropdown, Badge } from "antd";
import { DownOutlined } from "../icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";

// ConfigurationPage is the single home of everything about ONE application:
// a quiet underline tab row (Overview, Editor, Instances, Changes) over the
// active view, with lower-traffic surfaces (Files, Compare, Approvals,
// Repository changes, Audit, Import) folded under More. Tabs map 1:1 to the
// store's `section`, so deep links and browser history keep working exactly
// as before; this is chrome, not a router.

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

const TABS: { key: string; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "config", label: "Editor" },
  { key: "instances", label: "Instances" },
  { key: "changes", label: "Changes" },
];

// Lower-traffic surfaces fold under More so the strip stays calm. Files and
// Compare are advanced/inspection views over the same configuration; Approvals
// is reached from the workspace Inbox or a Change row.
const MORE: { key: string; label: string }[] = [
  { key: "files", label: "Files" },
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

  // "drafts" is a legacy alias of the Releases view.
  const active = section === "drafts" ? "changes" : section;
  const moreActive = MORE.find((m) => m.key === active);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface)" }}>
      <div className="app-tabs" role="tablist">
        {TABS.map((t) => (
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
          </button>
        ))}
        <Dropdown
          trigger={["click"]}
          menu={{
            selectedKeys: moreActive ? [moreActive.key] : [],
            items: MORE.map((m) => ({
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
            {findings > 0 && !moreActive && <CountPill n={findings} />}
            <DownOutlined style={{ fontSize: 9, marginLeft: 2 }} />
          </button>
        </Dropdown>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{children}</div>
    </div>
  );
}
