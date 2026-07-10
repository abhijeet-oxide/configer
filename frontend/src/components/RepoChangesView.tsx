import {
  Alert,
  Button,
  Card,
  Popconfirm,
  Result,
  Space,
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
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Finding } from "../api";
import { useUI } from "../store";

// RepoChangesView is the inbox for everything that happened directly on Git,
// outside Configer: new config files, edits, deletions, renames and possible
// version drops. Each finding explains itself in plain words and offers a
// one-click resolution, reinforcing that Git is the source of truth and
// Configer only streamlines it.

const findingMeta: Record<
  Finding["type"],
  { icon: React.ReactNode; color: string; label: string }
> = {
  new_file: { icon: <FileAddOutlined />, color: "green", label: "New file" },
  file_changed: { icon: <EditOutlined />, color: "blue", label: "File changed" },
  file_deleted: { icon: <DeleteOutlined />, color: "red", label: "File deleted" },
  file_renamed: { icon: <SwapOutlined />, color: "orange", label: "File renamed" },
  new_folder: { icon: <FolderAddOutlined />, color: "purple", label: "New folder" },
};

export default function RepoChangesView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { setSection, setImportFocus, selectParam } = useUI();

  const findingsQ = useQuery({ queryKey: ["findings"], queryFn: api.findings, refetchInterval: 30_000 });

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

  const data = findingsQ.data;
  const findings = data?.findings ?? [];

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "20px 24px", maxWidth: 1000, margin: "0 auto" }}>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              Repository Changes
            </Typography.Title>
            <Typography.Text type="secondary">
              Anything committed directly on Git, outside Configer, shows up here so nothing
              happens behind your back. Acting on an item is optional; the repository is already
              the source of truth.
            </Typography.Text>
          </div>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={findingsQ.isFetching}
              onClick={() => findingsQ.refetch()}
            >
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

        {findingsQ.isError && (
          <Alert
            type="warning"
            showIcon
            message="Repository changes can't be checked right now."
            description="The service will keep retrying automatically."
          />
        )}

        {!findingsQ.isError && findings.length === 0 && (
          <Result
            status="success"
            title="You're all caught up"
            subTitle="No changes have been made directly on Git since you last looked. New commits are checked for automatically."
          />
        )}

        {findings.map((f, i) => (
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

        {data && data.baseSha !== data.headSha && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Comparing last seen commit <code>{data.baseSha.slice(0, 7)}</code> with the current
            commit <code>{data.headSha.slice(0, 7)}</code>.
          </Typography.Text>
        )}
      </Space>
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
    <Card size="small">
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        <div
          style={{
            width: 36, height: 36, borderRadius: 10, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 17, background: `var(--ant-color-${m.color}-bg, rgba(0,0,0,0.04))`,
          }}
        >
          {m.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size={8} wrap>
            <Tag color={m.color}>{m.label}</Tag>
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
                <Tooltip key={p} title="Open in the Config Editor">
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
              Import parameters
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
