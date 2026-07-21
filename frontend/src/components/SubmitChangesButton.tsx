import {
  Badge,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Typography,
  App as AntApp,
} from "antd";
import { PullRequestOutlined, WarningFilled } from "../icons";
import { useRef, useState } from "react";
import type { InputRef } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChangeItem, type Instance } from "../api";
import { useUI } from "../store";
import { ChangeItemsTable } from "./ChangeItemsTable";

// SubmitChangesButton lives in the editor toolbar (where edits happen, not in
// the global header): pending-edit badge, review-before-submit modal with
// per-row undo, change type + reference, and the git-native explanation.

export default function SubmitChangesButton({ instances }: { instances?: Instance[] }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { setSection, selectParam } = useUI();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ title: string; description?: string; reference?: string; category?: string }>();
  const titleRef = useRef<InputRef>(null);

  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const items = draftQ.data?.draft?.items ?? [];
  const pending = items.length;
  const prodTouched = items.some(
    (it) => instances?.find((i) => i.name === it.instance)?.environment === "production",
  );

  const revert = useMutation({
    mutationFn: (it: ChangeItem) =>
      api.revertValue(it.action === "edit-file" ? `file:${it.file}` : it.paramId, it.instance),
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
          ? `Submitted for review as CR-${cr.id}, PR ${cr.prUrl}`
          : `Submitted for review as CR-${cr.id}`,
        6,
      );
      setSection("changes");
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <>
      {/* Pending changes are "pending" everywhere in the product: amber, not red. */}
      <Badge count={pending} size="small" offset={[-4, 0]} color="var(--c-pending)">
        <Button
          size="small"
          type="primary"
          icon={<PullRequestOutlined />}
          disabled={pending === 0}
          onClick={() => setOpen(true)}
        >
          {pending > 0 ? `Review ${pending} change${pending === 1 ? "" : "s"}` : "Review changes"}
        </Button>
      </Badge>

      <Modal
        title={`Review your changes (${pending})`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="Submit for review"
        okButtonProps={{ disabled: pending === 0 }}
        confirmLoading={submit.isPending}
        width={760}
        afterOpenChange={(o) => o && titleRef.current?.focus()}
      >
        {prodTouched && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
              padding: "6px 10px",
              borderRadius: 8,
              fontSize: 12.5,
              background: "var(--c-pending-bg)",
              border: "1px solid var(--c-pending-bd)",
            }}
          >
            <WarningFilled style={{ color: "var(--c-pending)", fontSize: 14, flexShrink: 0 }} />
            <span>
              <span style={{ fontWeight: 600, color: "var(--text)" }}>Touches production.</span>{" "}
              <span style={{ color: "var(--text-2)" }}>Goes live only after an approver publishes.</span>
            </span>
          </div>
        )}
        <div style={{ marginBottom: 14 }}>
          <ChangeItemsTable
            items={items}
            onUndo={(it) => revert.mutate(it)}
            undoLoading={revert.isPending}
            onOpenParam={(v) => {
              selectParam(v);
              setSection("config");
              setOpen(false);
            }}
          />
        </div>
        <Form form={form} layout="vertical" onFinish={(v) => submit.mutate(v)} initialValues={{ title: "" }}>
          <Form.Item
            name="title"
            label="What is this change about?"
            rules={[{ required: true, message: "Give the change a short title" }]}
          >
            <Input ref={titleRef} placeholder="e.g. Update staging DNS servers" maxLength={100} />
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
