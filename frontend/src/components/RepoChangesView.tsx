import {
  Alert,
  Button,
  Card,
  Empty,
  List,
  Popconfirm,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
} from "antd";
import {
  FileAddOutlined,
  EditOutlined,
  DeleteOutlined,
  SwapOutlined,
  FolderAddOutlined,
  ReloadOutlined,
  CheckOutlined,
  DownloadOutlined,
  TableOutlined,
  EyeOutlined,
  HistoryOutlined,
} from "../icons";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Finding } from "../api";
import { useUI } from "../store";
import { relTime } from "./DashboardView";
import { AllClearArt, StatePanel } from "./illustrations";

// RepoChangesView is the inbox for everything that happened directly on Git,
// outside Configer: new config files, edits, deletions, renames and new
// folders. The header tiles give the shape of the drift at a glance and act
// as filters; each finding explains itself in plain words and offers a
// one-click resolution. When there is no drift, the page shows the latest
// commits it is watching instead of going blank.

const findingMeta: Record<
  Finding["type"],
  { icon: React.ReactNode; color: string; hex: string; label: string }
> = {
  new_file: { icon: <FileAddOutlined />, color: "green", hex: "var(--c-ok)", label: "New files" },
  file_changed: { icon: <EditOutlined />, color: "blue", hex: "var(--c-review)", label: "Changed" },
  file_deleted: { icon: <DeleteOutlined />, color: "red", hex: "var(--c-danger)", label: "Deleted" },
  file_renamed: { icon: <SwapOutlined />, color: "orange", hex: "var(--c-pending)", label: "Renamed" },
  new_folder: { icon: <FolderAddOutlined />, color: "purple", hex: "#6c3df4", label: "New folders" },
};

export default function RepoChangesView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { setSection, setImportFocus, selectParam } = useUI();
  const [filter, setFilter] = useState<Finding["type"] | null>(null);

  const findingsQ = useQuery({ queryKey: ["findings"], queryFn: api.findings, refetchInterval: 30_000 });
  const data = findingsQ.data;
  const findings = data?.findings ?? [];
  const shown = filter ? findings.filter((f) => f.type === filter) : findings;
  // Latest commits fill the all-clear state, proving the watch is live.
  const historyQ = useQuery({
    queryKey: ["history", 8],
    queryFn: () => api.history(8),
    enabled: !findingsQ.isLoading && findings.length === 0,
    staleTime: 30_000,
  });

  const ack = useMutation({
    mutationFn: api.ackFindings,
    onSuccess: () => {
      message.success("All repository changes marked as seen.");
      qc.invalidateQueries({ queryKey: ["findings"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const retire = useMutation({
    mutationFn: (file: string) => api.retireFile(file, "demo-user"),
    onSuccess: (res) => {
      message.success(`${res.retired.length} parameter(s) retired with one commit on Git.`);
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const goImport = (focus: string) => {
    setImportFocus(focus);
    setSection("import");
  };

  const countOf = (t: Finding["type"]) => findings.filter((f) => f.type === t).length;

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Repository changes
          </Typography.Title>
          <Typography.Text type="secondary">
            Anything committed directly on Git, outside Configer, shows up here so nothing happens
            behind your back. Acting on an item is optional; the repository is already the source
            of truth.
          </Typography.Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} loading={findingsQ.isFetching} onClick={() => findingsQ.refetch()}>
            Check now
          </Button>
          {findings.length > 0 && (
            <Popconfirm
              title="Mark everything as seen?"
              description="The list clears; future commits will appear as new items."
              onConfirm={() => ack.mutate()}
            >
              <Button icon={<CheckOutlined />} loading={ack.isPending}>
                Mark all as seen
              </Button>
            </Popconfirm>
          )}
        </Space>
      </div>

      {/* The shape of the drift at a glance; tiles filter the list below. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14 }}>
        <Card
          size="small"
          hoverable
          onClick={() => setFilter(null)}
          className="stat-accent"
          style={{
            "--accent": findings.length ? "var(--c-pending)" : "var(--c-ok)",
            borderColor: filter === null ? (findings.length ? "var(--c-pending)" : undefined) : undefined,
          } as React.CSSProperties}
        >
          <Statistic
            title="Pending events"
            value={findings.length}
            prefix={<EyeOutlined style={{ color: findings.length ? "var(--c-pending)" : "var(--c-ok)" }} />}
            valueStyle={{ fontSize: 22, color: findings.length ? "var(--c-pending)" : undefined }}
          />
        </Card>
        {(Object.keys(findingMeta) as Finding["type"][]).map((t) => {
          const m = findingMeta[t];
          const n = countOf(t);
          return (
            <Card
              key={t}
              size="small"
              hoverable={n > 0}
              onClick={() => n > 0 && setFilter(filter === t ? null : t)}
              className="stat-accent"
              style={{
                "--accent": m.hex,
                opacity: n === 0 ? 0.55 : 1,
                borderColor: filter === t ? m.hex : undefined,
                cursor: n > 0 ? "pointer" : "default",
              } as React.CSSProperties}
            >
              <Statistic
                title={m.label}
                value={n}
                prefix={<span style={{ color: m.hex }}>{m.icon}</span>}
                valueStyle={{ fontSize: 22, color: n ? m.hex : undefined }}
              />
            </Card>
          );
        })}
      </div>

      {findingsQ.isError && (
        <Alert
          type="warning"
          showIcon
          message="Repository changes can't be checked right now."
          description="The service will keep retrying automatically."
        />
      )}

      {!findingsQ.isError && findings.length === 0 && (
        // All clear: say so, and show the commit stream being watched so the
        // page proves it is alive instead of standing empty.
        <div style={{ display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap", flex: 1 }}>
          <Card style={{ flex: "1 1 340px", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <StatePanel
              art={<AllClearArt size={116} />}
              title="No drift; you're all caught up"
              subtitle={
                <>
                  Nothing has been committed directly on Git since you last looked. New commits are
                  checked automatically
                  {data && (
                    <>
                      {" "}(currently at <code>{data.headSha.slice(0, 7)}</code>)
                    </>
                  )}
                  .
                </>
              }
            />
          </Card>
          <Card
            size="small"
            title={
              <Space size={8}>
                <HistoryOutlined /> Latest commits on this branch
              </Space>
            }
            style={{ flex: "1 1 420px" }}
          >
            <List
              size="small"
              dataSource={historyQ.data?.commits ?? []}
              loading={historyQ.isLoading}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No history available." /> }}
              renderItem={(c) => (
                <List.Item style={{ paddingInline: 0 }}>
                  <Space align="start" size={10} style={{ width: "100%" }}>
                    <Tag className="mono" style={{ fontSize: 11, marginInlineEnd: 0 }}>
                      {c.short}
                    </Tag>
                    <Space direction="vertical" size={0} style={{ flex: 1, minWidth: 0 }}>
                      <Typography.Text style={{ fontSize: 13 }} ellipsis>
                        {c.message}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {c.author} · {relTime(c.date)}
                      </Typography.Text>
                    </Space>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        </div>
      )}

      {shown.map((f, i) => (
        <FindingCard
          key={`${f.type}|${f.path}|${i}`}
          finding={f}
          onImport={goImport}
          onRetire={(file) => retire.mutate(file)}
          retiring={retire.isPending}
          onViewParam={(id) => {
            selectParam(id);
            setSection("config");
          }}
        />
      ))}
      {findings.length > 0 && shown.length === 0 && (
        <Empty description="Nothing matches this filter." style={{ marginTop: 24 }}>
          <Button size="small" onClick={() => setFilter(null)}>
            Show everything
          </Button>
        </Empty>
      )}

      {data && data.baseSha !== data.headSha && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Comparing last seen commit <code>{data.baseSha.slice(0, 7)}</code> with the current
          commit <code>{data.headSha.slice(0, 7)}</code>.
        </Typography.Text>
      )}
    </div>
  );
}

function FindingCard({
  finding: f,
  onImport,
  onRetire,
  retiring,
  onViewParam,
}: {
  finding: Finding;
  onImport: (focus: string) => void;
  onRetire: (file: string) => void;
  retiring: boolean;
  onViewParam: (paramId: string) => void;
}) {
  const m = findingMeta[f.type];
  return (
    <Card size="small" className="stat-accent" style={{ "--accent": m.hex } as React.CSSProperties}>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        <div
          style={{
            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 17, color: m.hex, background: `${m.hex}1a`,
          }}
        >
          {m.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size={8} wrap>
            <Tag color={m.color}>{m.label.replace(/s$/, "")}</Tag>
            <span className="mono" style={{ fontWeight: 600 }}>
              {f.type === "file_renamed" && f.oldPath ? (
                <>
                  <span style={{ opacity: 0.55, textDecoration: "line-through" }}>{f.oldPath}</span>
                  {" "}<SwapOutlined style={{ opacity: 0.5 }} />{" "}{f.path}
                </>
              ) : (
                f.path
              )}
            </span>
            {f.candidates ? <Tag color="green">{f.candidates} candidate setting(s)</Tag> : null}
          </Space>
          <Typography.Paragraph type="secondary" style={{ margin: "6px 0 0", fontSize: 13 }}>
            {f.detail}
          </Typography.Paragraph>
          {f.params && f.params.length > 0 && (
            <Space size={4} wrap style={{ marginTop: 6 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Affected:
              </Typography.Text>
              {f.params.slice(0, 8).map((p) => (
                <Tooltip key={p} title="Open in the Editor">
                  <Tag style={{ cursor: "pointer" }} className="mono" onClick={() => onViewParam(p)}>
                    {p}
                  </Tag>
                </Tooltip>
              ))}
              {f.params.length > 8 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  and {f.params.length - 8} more
                </Typography.Text>
              )}
            </Space>
          )}
        </div>
        <div style={{ flexShrink: 0 }}>
          {f.type === "new_file" && (
            <Button type="primary" icon={<DownloadOutlined />} onClick={() => onImport(f.path)}>
              Import settings
            </Button>
          )}
          {f.type === "new_folder" && (
            <Button type="primary" icon={<DownloadOutlined />} onClick={() => onImport(f.path)}>
              Scan this folder
            </Button>
          )}
          {f.type === "file_deleted" && (
            <Popconfirm
              title={`Retire ${f.params?.length ?? 0} parameter(s)?`}
              description="They are removed from the catalog with one reviewable commit on Git. Restore the file instead if the deletion was a mistake."
              okText="Retire"
              okButtonProps={{ danger: true }}
              onConfirm={() => onRetire(f.path)}
            >
              <Button danger icon={<DeleteOutlined />} loading={retiring}>
                Retire parameters
              </Button>
            </Popconfirm>
          )}
          {f.type === "file_changed" && f.params && f.params.length > 0 && (
            <Button icon={<TableOutlined />} onClick={() => onViewParam(f.params![0])}>
              View in editor
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
