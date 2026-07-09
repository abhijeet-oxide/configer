import { Card, Col, Row, Statistic, Typography, Tag, List, Space, Button, Empty } from "antd";
import {
  CheckCircleTwoTone,
  WarningTwoTone,
  InboxOutlined,
  EditOutlined,
  CloudServerOutlined,
  RightOutlined,
  BranchesOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, type Grid } from "../api";
import { StateTag } from "./CrSteps";
import { useUI } from "../store";

// DashboardView is the landing page: plain-language status cards, recent
// activity in human sentences, and a gentle reminder that everything lives on
// Git and nothing goes live without approval.

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

  let invalid = 0;
  for (const r of grid.rows) {
    for (const c of Object.values(r.cells)) if (!c.valid) invalid++;
  }
  const awaiting = changesQ.data?.filter((c) => c.state === "under_review") ?? [];
  const pending = draftQ.data?.draft?.items?.length ?? 0;
  const envs = new Map<string, number>();
  for (const i of grid.instances) {
    const e = i.environment ?? "unknown";
    envs.set(e, (envs.get(e) ?? 0) + 1);
  }
  const recent = (changesQ.data ?? []).slice(0, 6);
  const st = statusQ.data;

  return (
    <div style={{ padding: 20, height: "100%", overflow: "auto" }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        {grid.project}
      </Typography.Title>

      <Row gutter={[14, 14]}>
        <Col xs={24} sm={12} xl={6}>
          <Card
            size="small"
            hoverable
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
        <Col xs={24} sm={12} xl={6}>
          <Card size="small" hoverable onClick={() => setSection("approvals")}>
            <Statistic
              title="Waiting for approval"
              value={awaiting.length}
              valueStyle={{ fontSize: 20, color: awaiting.length ? "#1677ff" : undefined }}
              prefix={<InboxOutlined />}
              suffix={awaiting.length ? <RightOutlined style={{ fontSize: 12 }} /> : undefined}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card size="small" hoverable onClick={() => setSection("config")}>
            <Statistic
              title="Your unsent edits"
              value={pending}
              valueStyle={{ fontSize: 20, color: pending ? "#fa8c16" : undefined }}
              prefix={<EditOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card size="small">
            <Statistic
              title="Systems (instances)"
              value={grid.instances.length}
              valueStyle={{ fontSize: 20 }}
              prefix={<CloudServerOutlined />}
            />
            <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
              {[...envs.entries()].map(([e, n]) => (
                <Tag key={e} style={{ fontSize: 11 }}>{e} × {n}</Tag>
              ))}
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[14, 14]} style={{ marginTop: 14 }}>
        <Col xs={24} lg={14}>
          <Card size="small" title="Recent changes" extra={
            <Button size="small" type="link" onClick={() => setSection("changes")}>
              See all
            </Button>
          }>
            {recent.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No changes yet — edit a value in the Config Editor to start." />
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
                        <Typography.Text type="secondary"> · {cr.items?.length ?? 0} change{(cr.items?.length ?? 0) === 1 ? "" : "s"} · {relTime(cr.updatedAt)}</Typography.Text>
                      </span>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card size="small" title="Your systems">
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
          </Card>
        </Col>
      </Row>

      <Card size="small" style={{ marginTop: 14 }}>
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
