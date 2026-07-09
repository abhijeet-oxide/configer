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
} from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useUI } from "../store";
import { brands, type BrandKey } from "../theme";

// Application header: breadcrumb context, git-liveness indicator, the global
// parameter search (⌘K), theme controls, and the Create Change Request flow.
export default function TopBar({ project }: { project?: string }) {
  const { mode, setMode, brand, setBrand, search, setSearch, setSection } = useUI();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const searchRef = useRef<InputRef>(null);
  const [crOpen, setCrOpen] = useState(false);
  const [form] = Form.useForm<{ title: string; description?: string }>();

  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus, refetchInterval: 20_000 });
  const pending = draftQ.data?.draft?.items?.length ?? 0;

  const submit = useMutation({
    mutationFn: (v: { title: string; description?: string }) =>
      api.submitChange(draftQ.data!.draft!.id, { ...v, author: "demo-user" }),
    onSuccess: (cr) => {
      setCrOpen(false);
      form.resetFields();
      qc.invalidateQueries();
      message.success(
        cr.prUrl
          ? `Change request #${cr.id} submitted — PR ${cr.prUrl}`
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
          { title: "Repositories" },
          { title: <b>{project || "…"}</b> },
          { title: st?.branch || "main" },
        ]}
      />
      {st && (
        <Tooltip
          title={
            st.remote
              ? `Synced with ${st.remote}${st.syncError ? ` — ${st.syncError}` : ""}. External Git commits are picked up automatically.`
              : "Local repository (no remote configured)"
          }
        >
          <Tag
            icon={st.syncError ? <CloudServerOutlined /> : <SyncOutlined spin={statusQ.isFetching} />}
            color={st.syncError ? "warning" : st.behind > 0 ? "processing" : "success"}
            style={{ marginInlineEnd: 0 }}
          >
            {st.remote ? (st.behind > 0 ? `${st.behind} behind` : "git: live") : "git: local"}
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
        <Tooltip title="Help"><Button size="small" type="text" icon={<QuestionCircleOutlined />} /></Tooltip>
        <Badge count={pending} size="small">
          <Button size="small" type="text" icon={<BellOutlined />} />
        </Badge>
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
        title={`Create change request (${pending} pending change${pending === 1 ? "" : "s"})`}
        open={crOpen}
        onCancel={() => setCrOpen(false)}
        onOk={() => form.submit()}
        okText="Submit for review"
        confirmLoading={submit.isPending}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => submit.mutate(v)}
          initialValues={{ title: "" }}
        >
          <Form.Item
            name="title"
            label="Title"
            rules={[{ required: true, message: "Give the change request a title" }]}
          >
            <Input placeholder="e.g. Update staging DNS servers" maxLength={100} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea
              rows={3}
              placeholder="Why is this change needed? (appears in the commit and pull request)"
            />
          </Form.Item>
        </Form>
        <span style={{ fontSize: 12, opacity: 0.65 }}>
          Submitting creates branch <code>configer/cr-{draftQ.data?.draft?.id ?? "…"}</code>, commits the
          overlay + regenerated artifacts, pushes, and opens a pull request when a provider is configured.
        </span>
      </Modal>
    </div>
  );
}
