import { Card, Col, Row, Skeleton, Space } from "antd";

// State-aware skeletons: each mirrors the exact layout it is standing in for,
// so the page doesn't "jump" when real data arrives, and the user never sees a
// generic spinner. Every skeleton here is modelled directly on the component
// that replaces it (see the matching view file). (The npm package "boneyard"
// was evaluated for this and rejected: it is an unrelated, unmaintained
// Backbone.js toolkit, not a skeleton library.)

// A small helper so nested skeletons share one shimmer cadence.
const line = (w: number | string, h = 14): React.CSSProperties => ({ width: w, height: h });

export function DashboardSkeleton() {
  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      <Skeleton.Input active size="small" style={{ width: 180 }} />
      <Row gutter={[14, 14]}>
        {[0, 1, 2, 3].map((i) => (
          <Col xs={24} sm={12} xxl={6} key={i}>
            <Card size="small"><Skeleton active paragraph={false} title={{ width: "60%" }} /><Skeleton.Input active size="small" style={{ width: 120 }} /></Card>
          </Col>
        ))}
      </Row>
      <Row gutter={[14, 14]}>
        <Col xs={24} lg={14}>
          <Card size="small">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))", gap: 8 }}>
              {[...Array(6)].map((_, i) => (
                <Skeleton.Node key={i} active style={{ width: "100%", height: 74 }} />
              ))}
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={5}>
          <Card size="small">
            <Space>
              <Skeleton.Avatar active size={110} shape="circle" />
              <Skeleton active paragraph={{ rows: 3, width: 90 }} title={false} />
            </Space>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={5}>
          <Card size="small"><Skeleton.Node active style={{ width: "100%", height: 90 }} /></Card>
        </Col>
      </Row>
      <Card size="small"><Skeleton active paragraph={{ rows: 4 }} title={{ width: 140 }} /></Card>
    </div>
  );
}

export function GridSkeleton() {
  return (
    <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10, height: "100%" }}>
      <Space>
        <Skeleton.Input active size="small" style={{ width: 140 }} />
        <Skeleton.Button active size="small" />
        <Skeleton.Button active size="small" />
      </Space>
      {/* header row */}
      <Space size={8}>
        {[180, 70, 140, 110, 110, 110, 110].map((w, i) => (
          <Skeleton.Input key={i} active size="small" style={{ width: w }} />
        ))}
      </Space>
      {[...Array(11)].map((_, i) => (
        <Space size={8} key={i}>
          {[180, 70, 140, 110, 110, 110, 110].map((w, j) => (
            <Skeleton.Input key={j} active={i < 6} size="small" style={{ width: w, opacity: 1 - i * 0.07 }} />
          ))}
        </Space>
      ))}
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, maxWidth: 900 }}>
      <Skeleton.Input active size="small" style={{ width: 200 }} />
      {[...Array(3)].map((_, i) => (
        <Card size="small" key={i}>
          <Skeleton active title={{ width: "40%" }} paragraph={{ rows: 2 }} />
        </Card>
      ))}
    </div>
  );
}

// One placeholder card matching RepoCard in WorkspaceView: a 330px card with a
// header (icon + two name lines + action), a tag strip, three statistics, an
// environment tag strip and a footer button.
function RepoCardSkeleton() {
  return (
    <Card style={{ width: 330 }} styles={{ body: { padding: 14 } }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <Skeleton.Avatar active size={22} shape="square" style={{ marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Skeleton.Input active size="small" style={{ ...line(150), display: "block" }} />
          <Skeleton.Input active size="small" style={{ ...line(190, 10), marginTop: 6 }} />
        </div>
        <Skeleton.Button active size="small" style={{ width: 24 }} />
      </div>
      <Space size={4} style={{ marginTop: 12 }}>
        <Skeleton.Button active size="small" style={{ width: 58 }} />
        <Skeleton.Button active size="small" style={{ width: 74 }} />
      </Space>
      <div style={{ display: "flex", gap: 24, marginTop: 14 }}>
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <Skeleton.Input active size="small" style={{ ...line(64, 10) }} />
            <Skeleton.Input active size="small" style={{ ...line(30, 20), marginTop: 6, display: "block" }} />
          </div>
        ))}
      </div>
      <Space size={4} style={{ marginTop: 12 }}>
        <Skeleton.Button active size="small" style={{ width: 66 }} />
        <Skeleton.Button active size="small" style={{ width: 66 }} />
      </Space>
      <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
        <Skeleton.Button active size="small" style={{ width: 96 }} />
      </div>
    </Card>
  );
}

// Standing in for the Applications grid while the workspace loads. Shows the
// same card shape the user is about to see, so nothing shifts on arrival and
// the "no applications" empty state never flashes for connected workspaces.
export function WorkspaceSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 16, alignItems: "stretch" }}>
      {[...Array(count)].map((_, i) => (
        <RepoCardSkeleton key={i} />
      ))}
    </div>
  );
}

// Mirrors RenderedFilesView: a file tree on the left and a code pane on the
// right, under the same header. Replaces the bare centred <Spin/>.
export function FilesSkeleton() {
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 14 }}>
      <div style={{ width: 280, flexShrink: 0 }}>
        <Skeleton.Input active size="small" style={{ ...line(150, 12) }} />
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton.Input
              key={i}
              active
              size="small"
              style={{ ...line(`${88 - (i % 3) * 14}%`, 14), marginLeft: i % 4 === 0 ? 0 : 16 }}
            />
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        <Space size={8}>
          <Skeleton.Button active size="small" style={{ width: 220 }} />
          <Skeleton.Button active size="small" style={{ width: 48 }} />
          <Skeleton.Button active size="small" style={{ width: 64 }} />
        </Space>
        <div
          style={{
            flex: 1,
            borderRadius: 8,
            border: "1px solid rgba(128,128,128,0.25)",
            background: "rgba(128,128,128,0.06)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 7,
          }}
        >
          {[...Array(14)].map((_, i) => (
            <Skeleton.Input
              key={i}
              active={i < 9}
              size="small"
              style={{ ...line(`${[42, 68, 55, 80, 34, 60, 72, 48, 64, 38, 76, 52, 44, 30][i]}%`, 12), opacity: 1 - i * 0.05 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// Mirrors the Change Requests table: a header/toolbar row, a column-header
// strip, then data rows. Replaces AntD's built-in table spinner overlay so the
// shape matches what loads in.
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  const cols = [56, 320, 130, 90, 240, 130, 230];
  return (
    <div style={{ padding: 16, height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
        <Skeleton.Input active size="small" style={{ width: 200 }} />
        <Skeleton.Button active size="small" style={{ width: 90 }} />
      </div>
      <div style={{ border: "1px solid rgba(128,128,128,0.18)", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 16, padding: "12px 16px", background: "rgba(128,128,128,0.06)" }}>
          {cols.map((w, i) => (
            <Skeleton.Input key={i} active size="small" style={{ ...line(Math.min(w, 90), 12) }} />
          ))}
        </div>
        {[...Array(rows)].map((_, r) => (
          <div
            key={r}
            style={{ display: "flex", gap: 16, padding: "14px 16px", borderTop: "1px solid rgba(128,128,128,0.12)", opacity: 1 - r * 0.08 }}
          >
            {cols.map((w, i) => (
              <Skeleton.Input key={i} active={r < 4} size="small" style={{ ...line(w, 14) }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// Mirrors ApprovalsView: a title, a lead paragraph and a couple of review
// cards, each with a step strip and a before/after item block.
export function ApprovalsSkeleton() {
  return (
    <div style={{ padding: 20, height: "100%", overflow: "auto", maxWidth: 980 }}>
      <Skeleton.Input active size="small" style={{ width: 160, height: 24 }} />
      <div style={{ marginTop: 10, marginBottom: 18 }}>
        <Skeleton active title={false} paragraph={{ rows: 1, width: "70%" }} />
      </div>
      <Space direction="vertical" size={14} style={{ width: "100%" }}>
        {[0, 1].map((i) => (
          <Card key={i} size="small" title={<Skeleton.Input active size="small" style={{ width: 260 }} />}>
            <Space size={6} style={{ marginBottom: 12 }}>
              {[0, 1, 2, 3].map((s) => (
                <Skeleton.Button key={s} active size="small" style={{ width: 70 }} />
              ))}
            </Space>
            <Skeleton active title={false} paragraph={{ rows: 3 }} />
            <Space style={{ marginTop: 12 }}>
              <Skeleton.Button active style={{ width: 150 }} />
              <Skeleton.Button active style={{ width: 90 }} />
            </Space>
          </Card>
        ))}
      </Space>
    </div>
  );
}

// Mirrors PluginsView: a two-column grid of small cards, each a title, a tag,
// a description and an id/version line.
export function PluginsSkeleton() {
  return (
    <div style={{ padding: 24, overflow: "auto", height: "100%" }}>
      <Skeleton.Input active size="small" style={{ width: 140, height: 24 }} />
      <div style={{ marginTop: 10, marginBottom: 16 }}>
        <Skeleton active title={false} paragraph={{ rows: 1, width: "80%" }} />
      </div>
      <Row gutter={[16, 16]}>
        {[...Array(6)].map((_, i) => (
          <Col xs={24} md={12} key={i}>
            <Card size="small" title={<Skeleton.Input active size="small" style={{ width: 140 }} />} extra={<Skeleton.Button active size="small" style={{ width: 70 }} />}>
              <Skeleton active title={false} paragraph={{ rows: 2, width: ["90%", "60%"] }} />
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
