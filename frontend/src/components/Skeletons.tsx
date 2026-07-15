// State-aware, full-page skeletons. Every loading state in the app renders
// through these so loading always looks the same: a shimmer standing in for
// the EXACT layout that is about to appear, filling the whole page (never a
// cluster of tiny boxes), so nothing jumps when real data arrives.
//
// The primitive is the `.sk` CSS class (index.css): a fluid shimmer bar whose
// size comes entirely from the surrounding layout (%, fr, flex). Skeletons
// here compose it with the same grid/flex scaffolding the real views use.

/** One shimmer bar. Width/height default to filling the parent. */
function Sk({
  w = "100%",
  h = 14,
  r,
  style,
}: {
  w?: number | string;
  h?: number | string;
  r?: number;
  style?: React.CSSProperties;
}) {
  return <span className="sk" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

/** A bordered panel standing in for a Card, with optional title bar. */
function SkPanel({
  title = true,
  children,
  style,
}: {
  title?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="sk-panel" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, minWidth: 0, ...style }}>
      {title && <Sk w="38%" h={14} />}
      {children}
    </div>
  );
}

/** Rows of text lines with varied widths, for list/paragraph areas. */
function SkLines({ rows = 3, gap = 10 }: { rows?: number; gap?: number }) {
  const widths = ["92%", "68%", "80%", "55%", "74%", "62%", "86%", "48%"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {[...Array(rows)].map((_, i) => (
        <Sk key={i} w={widths[i % widths.length]} h={12} />
      ))}
    </div>
  );
}

/** The shared page header: a title line and a subtitle line. */
function SkHeader() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Sk w={220} h={22} />
      <Sk w="min(420px, 60%)" h={12} />
    </div>
  );
}

// ---------------------------------------------------------------- overview

// Mirrors DashboardView (the application Overview tab): signal pills, a row
// of stat cards, the health-map row, then activity panels filling the rest.
export function OverviewSkeleton() {
  return (
    <div style={{ padding: 20, height: "100%", overflow: "hidden", display: "flex", flexDirection: "column", gap: 14 }}>
      <Sk w={200} h={22} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {[104, 128, 150, 92, 118, 130, 122].map((w, i) => (
          <Sk key={i} w={w} h={26} r={999} />
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
        {[...Array(4)].map((_, i) => (
          <SkPanel key={i} title={false} style={{ height: 84, justifyContent: "center" }}>
            <Sk w="55%" h={11} />
            <Sk w="40%" h={20} />
          </SkPanel>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(0, 1fr) minmax(0, 1fr)", gap: 14 }}>
        <SkPanel style={{ minHeight: 150 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
            {[...Array(6)].map((_, i) => (
              <Sk key={i} h={72} r={8} />
            ))}
          </div>
        </SkPanel>
        <SkPanel style={{ minHeight: 150 }}>
          <Sk h={96} r={8} />
        </SkPanel>
        <SkPanel style={{ minHeight: 150 }}>
          <Sk h={72} r={8} />
          <Sk w="70%" h={11} />
        </SkPanel>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, flex: 1, minHeight: 160 }}>
        {[...Array(3)].map((_, i) => (
          <SkPanel key={i}>
            <SkLines rows={5} gap={14} />
          </SkPanel>
        ))}
      </div>
    </div>
  );
}

/** @deprecated kept as an alias; the Overview tab skeleton is the dashboard one. */
export const DashboardSkeleton = OverviewSkeleton;

// -------------------------------------------------------------------- grid

// Mirrors the Config Editor: category tree on the left, the parameter grid
// (toolbar, header row, data rows) filling the rest of the viewport.
export function GridSkeleton() {
  const cols = "minmax(200px, 2.4fr) 90px minmax(120px, 1.3fr) repeat(4, minmax(90px, 1fr))";
  return (
    <div style={{ height: "100%", overflow: "hidden", display: "flex" }}>
      <div
        style={{
          width: "15%", minWidth: 170, maxWidth: 280, padding: 14,
          borderRight: "1px solid rgba(127,137,160,0.18)",
          display: "flex", flexDirection: "column", gap: 12,
        }}
      >
        <Sk w="80%" h={26} r={6} />
        {["90%", "72%", "82%", "64%", "76%", "58%", "70%", "66%", "78%", "54%"].map((w, i) => (
          <Sk key={i} w={w} h={13} style={{ marginLeft: i % 3 === 0 ? 0 : 14, opacity: 1 - i * 0.05 }} />
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Sk w={150} h={24} />
          <Sk w={76} h={24} />
          <Sk w={76} h={24} />
          <span style={{ flex: 1 }} />
          <Sk w={180} h={24} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: cols, gap: 10 }}>
          {[...Array(7)].map((_, i) => (
            <Sk key={i} h={16} />
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", gap: 12 }}>
          {[...Array(16)].map((_, r) => (
            <div key={r} style={{ display: "grid", gridTemplateColumns: cols, gap: 10, opacity: Math.max(0.15, 1 - r * 0.06) }}>
              {[...Array(7)].map((_, c) => (
                <Sk key={c} w={c === 0 ? `${88 - (r % 4) * 9}%` : "85%"} h={13} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- lists

export function ListSkeleton() {
  return (
    <div style={{ padding: "16px 20px", height: "100%", overflow: "hidden", display: "flex", flexDirection: "column", gap: 12 }}>
      <SkHeader />
      {[...Array(4)].map((_, i) => (
        <SkPanel key={i} style={{ opacity: 1 - i * 0.15 }}>
          <SkLines rows={2} />
        </SkPanel>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ tables

// Mirrors a full-width table view (Release history, Instances…): page header,
// a toolbar, a column-header strip, then data rows filling the page.
export function TableSkeleton({ rows = 9 }: { rows?: number }) {
  const cols = "56px minmax(200px, 2.6fr) minmax(90px, 1fr) minmax(70px, 0.8fr) minmax(160px, 1.8fr) minmax(90px, 1fr) minmax(140px, 1.6fr)";
  return (
    <div style={{ padding: "16px 20px", height: "100%", overflow: "hidden", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <SkHeader />
        <Sk w={130} h={30} r={6} />
      </div>
      <div className="sk-panel" style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "grid", gridTemplateColumns: cols, gap: 16, padding: "12px 16px",
            background: "rgba(127,137,160,0.06)", borderBottom: "1px solid rgba(127,137,160,0.14)",
          }}
        >
          {[...Array(7)].map((_, i) => (
            <Sk key={i} w="70%" h={12} />
          ))}
        </div>
        {[...Array(rows)].map((_, r) => (
          <div
            key={r}
            style={{
              display: "grid", gridTemplateColumns: cols, gap: 16, padding: "15px 16px",
              borderTop: r === 0 ? "none" : "1px solid rgba(127,137,160,0.1)",
              opacity: Math.max(0.2, 1 - r * 0.09),
            }}
          >
            {[...Array(7)].map((_, c) => (
              <Sk key={c} w={c === 1 ? `${92 - (r % 3) * 12}%` : "80%"} h={13} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- approvals

// Mirrors ApprovalsView: page header, the pipeline stat strip, then the
// review queue on the left and the selected change request on the right.
export function ApprovalsSkeleton() {
  return (
    <div style={{ padding: "16px 24px", height: "100%", overflow: "hidden", display: "flex", flexDirection: "column", gap: 14 }}>
      <SkHeader />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        {[...Array(4)].map((_, i) => (
          <SkPanel key={i} title={false} style={{ height: 80, justifyContent: "center" }}>
            <Sk w="60%" h={11} />
            <Sk w="30%" h={20} />
          </SkPanel>
        ))}
      </div>
      <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
        <div style={{ flex: "0 0 330px", display: "flex", flexDirection: "column", gap: 10 }}>
          <Sk w={110} h={12} />
          {[...Array(3)].map((_, i) => (
            <SkPanel key={i} title={false} style={{ opacity: 1 - i * 0.25 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <Sk w={82} h={20} r={999} />
                <Sk w="55%" h={14} />
              </div>
              <Sk w="70%" h={11} />
            </SkPanel>
          ))}
        </div>
        <SkPanel style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {[...Array(3)].map((_, s) => (
              <Sk key={s} w={110} h={22} r={999} />
            ))}
          </div>
          <SkLines rows={5} gap={16} />
          <div style={{ display: "flex", gap: 10, marginTop: "auto" }}>
            <Sk w={170} h={38} r={6} />
            <Sk w={110} h={38} r={6} />
          </div>
        </SkPanel>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- compare

// Mirrors ComparePanel: the side pickers toolbar and a diff table below.
// `toolbar={false}` renders only the table part, for use below a real,
// already-rendered toolbar while just the diff loads.
export function CompareSkeleton({ toolbar = true }: { toolbar?: boolean }) {
  const cols = "minmax(180px, 1.6fr) minmax(120px, 2fr) minmax(120px, 2fr) 110px";
  return (
    <div style={{ padding: toolbar ? "12px 16px" : 0, height: "100%", overflow: "hidden", display: "flex", flexDirection: "column", gap: 12 }}>
      {toolbar && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Sk w={80} h={16} />
          <Sk w={280} h={26} r={6} />
          <Sk w={20} h={16} />
          <Sk w={280} h={26} r={6} />
          <Sk w={140} h={26} r={6} />
        </div>
      )}
      <div className="sk-panel" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {[...Array(11)].map((_, r) => (
          <div
            key={r}
            style={{
              display: "grid", gridTemplateColumns: cols, gap: 16, padding: "13px 16px",
              borderTop: r === 0 ? "none" : "1px solid rgba(127,137,160,0.1)",
              background: r === 0 ? "rgba(127,137,160,0.06)" : undefined,
              opacity: Math.max(0.2, 1 - r * 0.08),
            }}
          >
            {[...Array(4)].map((_, c) => (
              <Sk key={c} w={c === 3 ? 60 : "80%"} h={13} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- files

// Mirrors FilesView: a file tree on the left, a code pane filling the right.
export function FilesSkeleton() {
  return (
    <div style={{ flex: 1, minHeight: 0, height: "100%", display: "flex", gap: 14 }}>
      <div style={{ width: "22%", minWidth: 200, maxWidth: 300, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        <Sk w="70%" h={14} />
        {["88%", "74%", "60%", "82%", "68%", "56%", "78%", "64%"].map((w, i) => (
          <Sk key={i} w={w} h={13} style={{ marginLeft: i % 4 === 0 ? 0 : 16, opacity: 1 - i * 0.07 }} />
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <Sk w="min(260px, 40%)" h={26} r={6} />
          <Sk w={54} h={26} r={6} />
          <Sk w={70} h={26} r={6} />
        </div>
        <div className="sk-panel" style={{ flex: 1, minHeight: 0, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 9, overflow: "hidden" }}>
          {[42, 68, 55, 80, 34, 60, 72, 48, 64, 38, 76, 52, 44, 30, 58, 66].map((w, i) => (
            <Sk key={i} w={`${w}%`} h={12} style={{ opacity: Math.max(0.2, 1 - i * 0.05) }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- workspace

// One placeholder application card matching RepoCard in WorkspaceView.
function RepoCardSkeleton({ fade = 1 }: { fade?: number }) {
  return (
    <SkPanel title={false} style={{ opacity: fade }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <Sk w={24} h={24} r={6} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 7 }}>
          <Sk w="55%" h={15} />
          <Sk w="80%" h={10} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Sk w={62} h={20} r={999} />
        <Sk w={84} h={20} r={999} />
        <Sk w={70} h={20} r={999} />
      </div>
      <div style={{ display: "flex", gap: 24, marginTop: 2 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Sk w={62} h={10} />
            <Sk w={30} h={18} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Sk w={120} h={26} r={6} />
      </div>
    </SkPanel>
  );
}

// Standing in for the Applications page while the workspace loads: the same
// header, the cards grid filling the width, and the attention rail.
export function WorkspaceSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
        gap: 14,
        marginTop: 16,
      }}
    >
      {[...Array(count)].map((_, i) => (
        <RepoCardSkeleton key={i} fade={Math.max(0.35, 1 - i * 0.13)} />
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- plugins

// Mirrors PluginsView: a header and a two-column grid of small cards.
export function PluginsSkeleton() {
  return (
    <div style={{ padding: "16px 20px", height: "100%", overflow: "hidden", display: "flex", flexDirection: "column", gap: 14 }}>
      <SkHeader />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
        {[...Array(6)].map((_, i) => (
          <SkPanel key={i} style={{ opacity: Math.max(0.3, 1 - i * 0.12) }}>
            <SkLines rows={2} />
          </SkPanel>
        ))}
      </div>
    </div>
  );
}

/** A short two-line-per-item list, for inline "recent activity" areas. */
export function InlineListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 10 }}>
      {[...Array(rows)].map((_, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6, opacity: 1 - i * 0.18 }}>
          <Sk w={`${78 - (i % 3) * 14}%`} h={13} />
          <Sk w="45%" h={10} />
        </div>
      ))}
    </div>
  );
}
