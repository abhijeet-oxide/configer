import { Card, Col, Row, Skeleton, Space } from "antd";

// State-aware skeletons: each mirrors the exact layout it is standing in for,
// so the page doesn't "jump" when real data arrives. (The npm package
// "boneyard" was evaluated for this and rejected: it is an unrelated,
// unmaintained Backbone.js toolkit, not a skeleton library.)

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
