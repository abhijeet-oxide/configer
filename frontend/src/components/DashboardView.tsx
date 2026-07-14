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
  CheckCircleFilled,
  WarningFilled,
  SyncOutlined,
  ApartmentOutlined,
  FileAddOutlined,
  FileTextOutlined,
  DeleteOutlined,
  SwapOutlined,
  FolderAddOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, type Grid, type Finding } from "../api";
import { StateTag } from "./CrSteps";
import { ActivitySparkline, CategoryDonut, HealthTiles, STATUS, type TileDatum } from "./charts";
import { useUI } from "../store";
import { envHex } from "../theme";

// DashboardView is the application Overview: an operational command center that
// answers, without navigating anywhere, is it healthy, is anything waiting,
// is there drift, are versions consistent, and what changed recently. A live
// signal ribbon sits up top; actionable stat cards, a health map, and activity
// panels fill the rest so the page always feels alive.

export function relTime(iso?: string): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Compact one-line label/icon/color for a repository event, shared by the
// events panel below (the full treatment lives in RepoChangesView).
const findingBrief: Record<Finding["type"], { icon: React.ReactNode; color: string; label: string }> = {
  new_file: { icon: <FileAddOutlined />, color: "#0ca30c", label: "New file" },
  file_changed: { icon: <FileTextOutlined />, color: "#1677ff", label: "File changed" },
  file_deleted: { icon: <DeleteOutlined />, color: "#d03b3b", label: "File deleted" },
  file_renamed: { icon: <SwapOutlined />, color: "#fa8c16", label: "File renamed" },
  new_folder: { icon: <FolderAddOutlined />, color: "#6c3df4", label: "New folder" },
};

// A single live-status pill in the ribbon: an icon + short text, tinted by
// state and optionally clickable through to the view that owns it.
function Signal({
  icon,
  label,
  color,
  onClick,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  color: string;
  onClick?: () => void;
}) {
  return (
    <span
      className={onClick ? "card-clickable" : undefined}
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 500,
        padding: "3px 10px", borderRadius: 999, border: `1px solid ${color}33`, background: `${color}14`,
        color, cursor: onClick ? "pointer" : "default", whiteSpace: "nowrap",
      }}
    >
      {icon}
      {label}
    </span>
  );
}

export default function DashboardView({ grid, embedded }: { grid: Grid; embedded?: boolean }) {
  const { setSection, setFilters } = useUI();
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 15_000 });
  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft });
  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus });
  const findingsQ = useQuery({ queryKey: ["findings"], queryFn: api.findings, refetchInterval: 30_000, retry: false });

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
  const recent = (changesQ.data ?? []).slice(0, 6);
  const st = statusQ.data;
  const findings = findingsQ.data?.findings ?? [];
  const params = grid.rows.length;

  // Distinct software versions in play: one is consistent, several is a spread
  // worth surfacing (the honest signal we can compute without vendor metadata).
  const versions = [...new Set(grid.instances.map((i) => i.softwareVersion).filter(Boolean))] as string[];

  // Instances touched by any not-yet-published change, so "Your systems" can
  // flag what moved recently without needing a new backend field.
  const touched = new Set<string>();
  for (const c of changesQ.data ?? []) {
    if (c.state === "published" || c.state === "rejected") continue;
    for (const it of c.items ?? []) if (it.instance) touched.add(it.instance);
  }

  // change activity per day, last 14 days
  const days: { label: string; count: number }[] = [];
  for (let d = 13; d >= 0; d--) {
    const day = new Date(Date.now() - d * 86400_000);
    const key = day.toISOString().slice(0, 10);
    const count = (changesQ.data ?? []).filter((c) => c.updatedAt?.slice(0, 10) === key).length;
    days.push({ label: key.slice(5), count });
  }

  const donutData = grid.categories.map((c) => ({ label: c.title, value: c.count }));

  const syncSignal = !st?.remote
    ? { icon: <BranchesOutlined />, label: "Local only", color: "#8c8c8c" }
    : st.upstreamGone
      ? { icon: <WarningFilled />, label: "Branch removed on remote", color: STATUS.critical }
      : st.behind > 0
        ? { icon: <SyncOutlined />, label: `${st.behind} behind remote`, color: "#1677ff" }
        : { icon: <SyncOutlined />, label: "Git live", color: STATUS.good };

  return (
    <div style={{ padding: 20, height: "100%", overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {grid.project}
        </Typography.Title>
        {embedded ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            overview of the selected configuration
          </Typography.Text>
        ) : (
          <Typography.Link onClick={() => setSection("workspace")} style={{ fontSize: 12 }}>
            all configurations <RightOutlined style={{ fontSize: 10 }} />
          </Typography.Link>
        )}
      </div>

      {/* Live signal ribbon: the at-a-glance operational state. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Signal
          icon={invalid ? <WarningFilled /> : <CheckCircleFilled />}
          color={invalid ? STATUS.critical : STATUS.good}
          label={invalid ? `${invalid} to fix` : "Healthy"}
          onClick={() => {
            setFilters({ invalidOnly: invalid > 0 });
            setSection("config");
          }}
        />
        <Signal
          icon={invalid ? <WarningFilled /> : <CheckCircleFilled />}
          color={invalid ? STATUS.warning : STATUS.good}
          label={invalid ? "Validation issues" : "Validation passed"}
        />
        <Signal
          icon={findings.length ? <WarningFilled /> : <CheckCircleFilled />}
          color={findings.length ? STATUS.warning : STATUS.good}
          label={findings.length ? `${findings.length} repository change${findings.length === 1 ? "" : "s"}` : "No drift"}
          onClick={() => setSection("drift")}
        />
        <Signal {...syncSignal} />
        <Signal
          icon={<ApartmentOutlined />}
          color={versions.length > 1 ? STATUS.warning : "#6c3df4"}
          label={versions.length === 1 ? versions[0] : versions.length ? `${versions.length} versions` : "no version set"}
        />
        <Signal icon={<TableOutlined />} color="#1677ff" label={`${params} parameters`} />
        <Signal icon={<CloudServerOutlined />} color="#1677ff" label={`${grid.instances.length} instances`} />
      </div>

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
          <Card
            size="small"
            hoverable
            className="stat-accent card-clickable"
            style={{ "--accent": findings.length ? "#fa8c16" : "#0ca30c" } as React.CSSProperties}
            onClick={() => setSection("drift")}
          >
            <Statistic
              title="Repository changes"
              value={findings.length === 0 ? "None" : findings.length}
              valueStyle={{ fontSize: 20, color: findings.length ? "#fa8c16" : "#389e0d" }}
              prefix={findings.length ? <WarningTwoTone twoToneColor="#faad14" /> : <CheckCircleTwoTone twoToneColor="#52c41a" />}
              suffix={findings.length ? <RightOutlined style={{ fontSize: 12 }} /> : undefined}
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
            <HealthTiles data={tiles} onClick={() => setSection("config")} />
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
        <Col xs={24} lg={8} style={{ display: "flex" }}>
          <Card
            size="small"
            title="Recent activity"
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
                    <Space direction="vertical" size={0} style={{ width: "100%" }}>
                      <Space wrap size={6}>
                        <StateTag state={cr.state} />
                        <b>{cr.title}</b>
                      </Space>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {cr.author} · {cr.items?.length ?? 0} change{(cr.items?.length ?? 0) === 1 ? "" : "s"} · {relTime(cr.updatedAt)}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={8} style={{ display: "flex" }}>
          <Card
            size="small"
            title="Repository events"
            style={{ flex: 1 }}
            extra={
              <Button size="small" type="link" onClick={() => setSection("drift")}>
                {findings.length ? "Review" : "Open"}
              </Button>
            }
          >
            {findings.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No changes on Git since you last looked."
              />
            ) : (
              <List
                size="small"
                dataSource={findings.slice(0, 6)}
                renderItem={(f) => {
                  const m = findingBrief[f.type];
                  return (
                    <List.Item style={{ cursor: "pointer" }} onClick={() => setSection("drift")}>
                      <Space size={8} align="start">
                        <span style={{ color: m.color, marginTop: 2 }}>{m.icon}</span>
                        <Space direction="vertical" size={0}>
                          <Typography.Text style={{ fontSize: 13 }}>
                            <Tag color={m.color} style={{ marginInlineEnd: 6 }}>{m.label}</Tag>
                            <span className="mono" style={{ fontSize: 12 }}>{f.path.split("/").pop()}</span>
                          </Typography.Text>
                          {f.candidates ? (
                            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                              {f.candidates} candidate setting{f.candidates === 1 ? "" : "s"}
                            </Typography.Text>
                          ) : null}
                        </Space>
                      </Space>
                    </List.Item>
                  );
                }}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={8} style={{ display: "flex" }}>
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
                        background: envHex(i.environment),
                      }}
                    />
                    {i.name}
                    {touched.has(i.name) && <Tag color="orange" style={{ fontSize: 10, marginInlineStart: 2 }}>edited</Tag>}
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {i.softwareVersion} · {i.region ?? "-"}
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
            {" "}Your edits become a <b>change request</b>, get reviewed, and only go live after approval; you can't break anything by exploring.
          </Typography.Text>
        </Space>
      </Card>
    </div>
  );
}
