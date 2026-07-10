import {
  Breadcrumb,
  Input,
  Space,
  Tooltip,
  Button,
  Badge,
  Avatar,
  Dropdown,
  Modal,
  Form,
  Tag,
  Table,
  Alert,
  Typography,
  Select,
  App as AntApp,
  type InputRef,
} from "antd";
import {
  SearchOutlined,
  MoonOutlined,
  SunOutlined,
  BellOutlined,
  QuestionCircleOutlined,
  PullRequestOutlined,
  BgColorsOutlined,
  SyncOutlined,
  CloudServerOutlined,
  ArrowRightOutlined,
  DeleteOutlined,
  FontSizeOutlined,
} from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChangeItem, type Instance } from "../api";
import { fmtValue } from "../rules";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { brands, type BrandKey } from "../theme";

// afterValue renders the post-change value with action awareness.
function afterValue(it: ChangeItem & { action?: string }) {
  if (it.action === "exclude") return "∅ removed from this instance";
  if (it.action === "reset") return "(back to inherited value)";
  return fmtValue(it.new);
}

// Application header: breadcrumb context, git-liveness indicator, the global
// parameter search (⌘K), theme controls, and the Create Change Request flow.
export default function TopBar({ project, instances }: { project?: string; instances?: Instance[] }) {
  const { mode, setMode, brand, setBrand, fontScale, setFontScale, search, setSearch, setSection, selectParam, repoId } =
    useUI();
  const switchRepo = useSwitchRepo();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const searchRef = useRef<InputRef>(null);
  const [crOpen, setCrOpen] = useState(false);
  const [form] = Form.useForm<{ title: string; description?: string; reference?: string; category?: string }>();

  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus, refetchInterval: 20_000 });
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 20_000 });
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const repos = wsQ.data?.repos ?? [];
  const activeRepo = repos.find((r) => r.id === repoId);
  const items = draftQ.data?.draft?.items ?? [];
  const pending = items.length;
  const awaiting = changesQ.data?.filter((c) => c.state === "under_review").length ?? 0;
  const prodTouched = items.some(
    (it) => instances?.find((i) => i.name === it.instance)?.environment === "production",
  );

  const revert = useMutation({
    mutationFn: (it: ChangeItem) => api.revertValue(it.paramId, it.instance),
    onSuccess: () => qc.invalidateQueries(),
  });

  const submit = useMutation({
    mutationFn: (v: { title: string; description?: string; reference?: string; category?: string }) =>
      api.submitChange(draftQ.data!.draft!.id, { ...v, author: "demo-user" }),
    onSuccess: (cr) => {
      setCrOpen(false);
      form.resetFields();
      qc.invalidateQueries();
      message.success(
        cr.prUrl
          ? `Change request #${cr.id} submitted, PR ${cr.prUrl}`
          : `Change request #${cr.id} submitted on branch ${cr.branch}`,
        6,
      );
      setSection("changes");
    },
    onError: (e: Error) => message.error(e.message),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const st = statusQ.data;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, width: "100%" }}>
      <Breadcrumb
        items={[
          {
            title: (
              <a onClick={() => setSection("workspace")} style={{ cursor: "pointer" }}>
                Workspace
              </a>
            ),
          },
          {
            title: (
              <Dropdown
                trigger={["click"]}
                menu={{
                  selectedKeys: repoId ? [repoId] : [],
                  items: [
                    ...repos.map((r) => ({
                      key: r.id,
                      label: (
                        <Space size={6}>
                          {r.name}
                          {r.project && r.project !== r.name && (
                            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                              {r.project}
                            </Typography.Text>
                          )}
                        </Space>
                      ),
                    })),
                    { type: "divider" as const },
                    { key: "__workspace", label: "Connect or manage repositories…" },
                  ],
                  onClick: ({ key }) => {
                    if (key === "__workspace") {
                      setSection("workspace");
                    } else if (key !== repoId) {
                      switchRepo(key);
                    }
                  },
                }}
              >
                <a style={{ cursor: "pointer" }}>
                  <b>{activeRepo?.name ?? project ?? "…"}</b>{" "}
                  <span style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
                </a>
              </Dropdown>
            ),
          },
          { title: st?.branch || "main" },
        ]}
      />
      {st && (
        <Tooltip
          title={
            st.upstreamGone
              ? `The branch "${st.branch}" no longer exists on the remote; it may have been deleted on GitHub. Your local work is safe; ask an administrator to restore the branch or point Configer at a different one.`
              : st.remote
                ? `Synced with the Git remote${st.syncError ? `: ${st.syncError}` : ""}. Commits made directly on Git are picked up automatically.`
                : "Local repository (no remote configured)"
          }
        >
          <Tag
            icon={st.syncError || st.upstreamGone ? <CloudServerOutlined /> : <SyncOutlined spin={statusQ.isFetching} />}
            color={st.upstreamGone ? "error" : st.syncError ? "warning" : st.behind > 0 ? "processing" : "success"}
            style={{ marginInlineEnd: 0 }}
          >
            {st.upstreamGone
              ? "branch removed on remote"
              : st.remote
                ? st.behind > 0
                  ? `${st.behind} behind`
                  : "git: live"
                : "git: local"}
          </Tag>
        </Tooltip>
      )}
      <div style={{ flex: 1 }} />
      <Input
        ref={searchRef}
        prefix={<SearchOutlined />}
        placeholder="Search everything… (⌘K)"
        size="small"
        allowClear
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: "clamp(180px, 24vw, 380px)" }}
      />
      <Space size={6}>
        <Tooltip title={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}>
          <Button
            size="small"
            type="text"
            icon={mode === "light" ? <MoonOutlined /> : <SunOutlined />}
            onClick={() => setMode(mode === "light" ? "dark" : "light")}
          />
        </Tooltip>
        <Dropdown
          menu={{
            selectedKeys: [brand],
            items: Object.entries(brands).map(([k, v]) => ({
              key: k,
              label: (
                <Space>
                  <span style={{ width: 10, height: 10, borderRadius: 5, background: v.colorPrimary, display: "inline-block" }} />
                  {v.label}
                </Space>
              ),
            })),
            onClick: ({ key }) => setBrand(key as BrandKey),
          }}
        >
          <Button size="small" type="text" icon={<BgColorsOutlined />} />
        </Dropdown>
        <Tooltip title={fontScale === "normal" ? "Larger text (easier reading)" : "Normal text size"}>
          <Button
            size="small"
            type={fontScale === "large" ? "primary" : "text"}
            ghost={fontScale === "large"}
            icon={<FontSizeOutlined />}
            onClick={() => setFontScale(fontScale === "normal" ? "large" : "normal")}
          />
        </Tooltip>
        <Tooltip title="Help"><Button size="small" type="text" icon={<QuestionCircleOutlined />} /></Tooltip>
        <Tooltip title={awaiting ? `${awaiting} change request(s) waiting for approval` : "No approvals waiting"}>
          <Badge count={awaiting} size="small">
            <Button size="small" type="text" icon={<BellOutlined />} onClick={() => setSection("approvals")} />
          </Badge>
        </Tooltip>
        <Badge count={pending} size="small" offset={[-4, 0]}>
          <Button
            size="small"
            type="primary"
            icon={<PullRequestOutlined />}
            disabled={pending === 0}
            onClick={() => setCrOpen(true)}
          >
            Create Change Request
          </Button>
        </Badge>
        <Avatar size={26} style={{ background: "#7c3aed", flexShrink: 0 }}>DU</Avatar>
      </Space>

      <Modal
        title={`Review your changes (${pending})`}
        open={crOpen}
        onCancel={() => setCrOpen(false)}
        onOk={() => form.submit()}
        okText="Send for review"
        okButtonProps={{ disabled: pending === 0 }}
        confirmLoading={submit.isPending}
        width={760}
      >
        {prodTouched && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 10 }}
            message="This change touches PRODUCTION instances"
            description="It will only go live after an approver publishes it."
          />
        )}
        <Table<ChangeItem>
          size="small"
          rowKey={(it) => `${it.paramId}|${it.instance}`}
          dataSource={items}
          pagination={false}
          style={{ marginBottom: 14 }}
          columns={[
            {
              title: "Setting",
              dataIndex: "paramId",
              render: (v: string) => (
                <Typography.Link
                  onClick={() => {
                    // jump straight to the cell in the editor
                    selectParam(v);
                    setSection("config");
                    setCrOpen(false);
                  }}
                >
                  <span className="mono">{v}</span>
                </Typography.Link>
              ),
            },
            {
              title: "Instance",
              dataIndex: "instance",
              width: 140,
              render: (v: string, it: ChangeItem) =>
                it.scope === "global" ? <Tag color="purple">everyone (global)</Tag> : <Tag>{v}</Tag>,
            },
            {
              title: "Before",
              dataIndex: "old",
              render: (v) => <span className="mono" style={{ opacity: 0.6 }}>{fmtValue(v)}</span>,
            },
            { title: "", width: 30, render: () => <ArrowRightOutlined style={{ opacity: 0.45 }} /> },
            {
              title: "After",
              render: (_v, it) => (
                <span className="mono" style={{ color: "#389e0d" }}>{afterValue(it)}</span>
              ),
            },
            {
              title: "",
              width: 46,
              render: (_v, it) => (
                <Tooltip title="Undo this change">
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    loading={revert.isPending}
                    onClick={() => revert.mutate(it)}
                  />
                </Tooltip>
              ),
            },
          ]}
        />
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => submit.mutate(v)}
          initialValues={{ title: "" }}
        >
          <Form.Item
            name="title"
            label="What is this change about?"
            rules={[{ required: true, message: "Give the change a short title" }]}
          >
            <Input placeholder="e.g. Update staging DNS servers" maxLength={100} />
          </Form.Item>
          <div style={{ display: "flex", gap: 10 }}>
            <Form.Item name="category" label="Change type" initialValue="feature" style={{ flex: 1 }}>
              <Select
                options={[
                  { value: "hotfix", label: "Hotfix (urgent fix)" },
                  { value: "feature", label: "Feature (new capability)" },
                  { value: "bugfix", label: "Bugfix" },
                  { value: "maintenance", label: "Maintenance" },
                  { value: "security", label: "Security" },
                  { value: "other", label: "Other" },
                ]}
              />
            </Form.Item>
            <Form.Item name="reference" label="Reference / CR ID (optional)" style={{ flex: 1 }}>
              <Input placeholder="e.g. JIRA-123, CRQ000042" maxLength={60} />
            </Form.Item>
          </div>
          <Form.Item name="description" label="Why is it needed? (optional)">
            <Input.TextArea
              rows={2}
              placeholder="Shown to the approver, and kept in the Git history"
            />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          On Git this saves your edits to branch <code>configer/cr-{draftQ.data?.draft?.id ?? "…"}</code>
          {" "}and opens a review; nothing goes live until an approver publishes it.
        </Typography.Text>
      </Modal>
    </div>
  );
}
