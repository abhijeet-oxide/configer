import {
  Alert,
  Badge,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Table,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
} from "antd";
import { PullRequestOutlined, ArrowRightOutlined, DeleteOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChangeItem, type Instance } from "../api";
import { fmtValue } from "../rules";
import { useUI } from "../store";

// SubmitChangesButton lives in the editor toolbar (where edits happen, not in
// the global header): pending-edit badge, review-before-submit modal with
// per-row undo, change type + reference, and the git-native explanation.

function afterValue(it: ChangeItem & { action?: string }) {
  if (it.action === "exclude") return "∅ removed from this instance";
  if (it.action === "reset") return "(back to inherited value)";
  return fmtValue(it.new);
}

export default function SubmitChangesButton({ instances }: { instances?: Instance[] }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { setSection, selectParam } = useUI();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ title: string; description?: string; reference?: string; category?: string }>();

  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const items = draftQ.data?.draft?.items ?? [];
  const pending = items.length;
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
      setOpen(false);
      form.resetFields();
      qc.invalidateQueries();
      message.success(
        cr.prUrl
          ? `Change request #${cr.id} submitted, PR ${cr.prUrl}`
          : `Change request #${cr.id} submitted on branch ${cr.branch}`,
        6,
      );
      setSection("approvals");
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <>
      <Badge count={pending} size="small" offset={[-4, 0]}>
        <Button
          size="small"
          type="primary"
          icon={<PullRequestOutlined />}
          disabled={pending === 0}
          onClick={() => setOpen(true)}
        >
          Create Change Request
        </Button>
      </Badge>

      <Modal
        title={`Review your changes (${pending})`}
        open={open}
        onCancel={() => setOpen(false)}
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
                    selectParam(v);
                    setSection("config");
                    setOpen(false);
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
        <Form form={form} layout="vertical" onFinish={(v) => submit.mutate(v)} initialValues={{ title: "" }}>
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
            <Input.TextArea rows={2} placeholder="Shown to the approver, and kept in the Git history" />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          On Git this saves your edits to branch <code>configer/cr-{draftQ.data?.draft?.id ?? "…"}</code>
          {" "}and opens a review; nothing goes live until an approver publishes it.
        </Typography.Text>
      </Modal>
    </>
  );
}
