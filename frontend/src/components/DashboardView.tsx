import { Card, Col, Row, Statistic, Typography, Tag, List, Space, Button, Empty } from "antd";
import {
  CheckCircleTwoTone,
  WarningTwoTone,
  InboxOutlined,
  EditOutlined,
  CloudServerOutlined,
  RightOutlined,
  BranchesOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, type Grid } from "../api";
import { StateTag } from "./CrSteps";
import { ActivitySparkline, CategoryDonut, HealthTiles, type TileDatum } from "./charts";
import { useUI } from "../store";

// DashboardView is the landing page — a visual command center that fills the
// viewport with genuinely useful data: health map, category inventory, change
// activity, recent history, and a Git education footer.

export function relTime(iso?: string): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function DashboardView({ grid }: { grid: Grid }) {
  const { setSection, setFilters } = useUI();
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 15_000 });
  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft });
  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus });

  // per-instance health for the tile map
  const tiles: TileDatum[] = grid.instances.map((i) => {
    let invalid = 0;
    let pending = 0;
    for (const r of grid.rows) {
      const c = r.cells[i.name];
      if (!c) continue;
      if (!c.valid) invalid++;
      if (c.pending) pending++;
    }
    return { name: i.name, environment: i.environment, version: i.softwareVersion, invalid, pending };
  });
  const invalid = tiles.reduce((s, t) => s + t.invalid, 0);

  const awaiting = changesQ.data?.filter((c) => c.state === "under_review") ?? [];
  const pending = draftQ.data?.draft?.items?.length ?? 0;
  const recent = (changesQ.data ?? []).slice(0, 7);
  const st = statusQ.data;

  // change activity per day, last 14 days
  const days: { label: string; count: number }[] = [];
  for (let d = 13; d >= 0; d--) {
    const day = new Date(Date.now() - d * 86400_000);
    const key = day.toISOString().slice(0, 10);
    const count = (changesQ.data ?? []).filter((c) => c.updatedAt?.slice(0, 10) === key).length;
    days.push({ label: key.slice(5), count });
  }

  const donutData = grid.categories.map((c) => ({ label: c.title, value: c.count }));

  return (
    <div style={{ padding: 20, height: "100%", overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {grid.project}
      </Typography.Title>

      <Row gutter={[14, 14]}>
        <Col xs={24} sm={12} xxl={6}>
          <Card
            size="small"
            hoverable
            className="stat-accent card-clickable"
            style={{ "--accent": invalid ? "#d03b3b" : "#0ca30c" } as React.CSSProperties}
            onClick={() => {
              setFilters({ invalidOnly: invalid > 0 });
              setSection("config");
            }}
          >
            <Statistic
              title="Configuration health"
              value={invalid === 0 ? "All settings valid" : `${invalid} to fix`}
              valueStyle={{ fontSize: 20, color: invalid ? "#cf1322" : "#389e0d" }}
              prefix={invalid === 0 ? <CheckCircleTwoTone twoToneColor="#52c41a" /> : <WarningTwoTone twoToneColor="#faad14" />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xxl={6}>
          <Card
            size="small"
            hoverable
            className="stat-accent card-clickable"
            style={{ "--accent": "#1677ff" } as React.CSSProperties}
            onClick={() => setSection("approvals")}
          >
            <Statistic
              title="Waiting for approval"
              value={awaiting.length}
              valueStyle={{ fontSize: 20, color: awaiting.length ? "#1677ff" : undefined }}
              prefix={<InboxOutlined />}
              suffix={awaiting.length ? <RightOutlined style={{ fontSize: 12 }} /> : undefined}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xxl={6}>
          <Card
            size="small"
            hoverable
            className="stat-accent card-clickable"
            style={{ "--accent": "#fa8c16" } as React.CSSProperties}
            onClick={() => setSection("config")}
          >
            <Statistic
              title="Your unsent edits"
              value={pending}
              valueStyle={{ fontSize: 20, color: pending ? "#fa8c16" : undefined }}
              prefix={<EditOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xxl={6}>
          <Card size="small" className="stat-accent" style={{ "--accent": "#6c3df4" } as React.CSSProperties}>
            <Statistic
              title="Systems (instances)"
              value={grid.instances.length}
              valueStyle={{ fontSize: 20 }}
              prefix={<CloudServerOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[14, 14]}>
        <Col xs={24} lg={14}>
          <Card
            size="small"
            title="System health map"
            styles={{ body: { minHeight: 120 } }}
            extra={
              <Button size="small" type="link" icon={<TableOutlined />} onClick={() => setSection("config")}>
                Open editor
              </Button>
            }
          >
            <HealthTiles
              data={tiles}
              onClick={() => setSection("config")}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={5}>
          <Card size="small" title="Settings by category" styles={{ body: { minHeight: 120 } }}>
            <CategoryDonut data={donutData} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={5}>
          <Card size="small" title="Change activity (14 days)" styles={{ body: { minHeight: 120 } }}>
            <ActivitySparkline days={days} width={230} height={78} />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {(changesQ.data ?? []).length} change request{(changesQ.data ?? []).length === 1 ? "" : "s"} total
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[14, 14]} style={{ flex: 1, alignItems: "stretch" }}>
        <Col xs={24} lg={14} style={{ display: "flex" }}>
          <Card
            size="small"
            title="Recent changes"
            style={{ flex: 1 }}
            extra={
              <Button size="small" type="link" onClick={() => setSection("changes")}>
                See all
              </Button>
            }
          >
            {recent.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No changes yet.">
                <Button type="primary" size="small" onClick={() => setSection("config")}>
                  Edit your first setting
                </Button>
              </Empty>
            ) : (
              <List
                size="small"
                dataSource={recent}
                renderItem={(cr) => (
                  <List.Item
                    style={{ cursor: "pointer" }}
                    onClick={() => setSection(cr.state === "under_review" ? "approvals" : "changes")}
                  >
                    <Space wrap>
                      <StateTag state={cr.state} />
                      <span>
                        <b>{cr.author}</b> — {cr.title}
                        <Typography.Text type="secondary">
                          {" "}· {cr.items?.length ?? 0} change{(cr.items?.length ?? 0) === 1 ? "" : "s"} · {relTime(cr.updatedAt)}
                        </Typography.Text>
                      </span>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10} style={{ display: "flex" }}>
          <Card size="small" title="Your systems" style={{ flex: 1 }}>
            <List
              size="small"
              dataSource={grid.instances}
              renderItem={(i) => (
                <List.Item>
                  <Space>
                    <span
                      style={{
                        width: 8, height: 8, borderRadius: 4, display: "inline-block",
                        background: i.environment === "production" ? "#f5222d" : i.environment === "staging" ? "#fa8c16" : "#52c41a",
                      }}
                    />
                    {i.name}
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {i.softwareVersion} · {i.region ?? "—"}
                  </Typography.Text>
                </List.Item>
              )}
            />
            <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4 }}>
              {[...new Set(grid.instances.map((i) => i.environment ?? "unknown"))].map((e) => (
                <Tag key={e} style={{ fontSize: 11 }}>
                  {e} × {grid.instances.filter((i) => (i.environment ?? "unknown") === e).length}
                </Tag>
              ))}
            </div>
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Space wrap>
          <BranchesOutlined />
          <Typography.Text>
            Everything here is stored in <b>Git</b>
            {st?.remote ? <> and synced with your repository (branch <code>{st.branch}</code>)</> : <> (branch <code>{st?.branch ?? "main"}</code>)</>}.
            {" "}Your edits become a <b>change request</b>, get reviewed, and only go live after approval — you can't break anything by exploring.
          </Typography.Text>
        </Space>
      </Card>
    </div>
  );
}
