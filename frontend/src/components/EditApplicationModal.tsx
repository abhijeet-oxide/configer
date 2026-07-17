import { Button, Form, Input, Modal, Space, Typography, App as AntApp } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

// EditApplicationModal edits the application's identity - display name,
// description, and free-form metadata (owner, team, ticket queue, anything) -
// and stores it in Git (.configer/application.yaml) as an attributed commit.
// The workspace display name is kept in sync so cards and breadcrumbs follow.

interface FormValues {
  name: string;
  description?: string;
  metadata: { key: string; value: string }[];
}

export default function EditApplicationModal({
  open,
  repoId,
  onClose,
}: {
  open: boolean;
  /** workspace entry to keep the display name in sync with */
  repoId: string;
  onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();

  // The modal always edits the ACTIVE repository (callers switch first).
  const appQ = useQuery({ queryKey: ["application", repoId], queryFn: api.application, enabled: open });

  useEffect(() => {
    if (!open || !appQ.data) return;
    form.setFieldsValue({
      name: appQ.data.name,
      description: appQ.data.description ?? "",
      metadata: Object.entries(appQ.data.metadata ?? {}).map(([key, value]) => ({ key, value })),
    });
  }, [open, appQ.data, form]);

  const save = useMutation({
    mutationFn: async (v: FormValues) => {
      const metadata: Record<string, string> = {};
      for (const { key, value } of v.metadata ?? []) {
        if (key?.trim() && value?.trim()) metadata[key.trim()] = value.trim();
      }
      const updated = await api.updateApplication({
        name: v.name.trim(),
        description: v.description?.trim() ?? "",
        metadata,
      });
      // Keep the workspace display name in step with the Git-stored name so
      // the card, breadcrumb and side panel all say the same thing.
      await api.renameRepo(repoId, updated.name);
      return updated;
    },
    onSuccess: () => {
      message.success("Application details saved to Git.");
      qc.invalidateQueries({ queryKey: ["application"] });
      qc.invalidateQueries({ queryKey: ["workspace"] });
      qc.invalidateQueries({ queryKey: ["meta"] });
      qc.invalidateQueries({ queryKey: ["grid"] });
      onClose();
    },
    onError: (e: Error) => message.error(e.message, 6),
  });

  return (
    <Modal
      title="Edit application details"
      open={open}
      onCancel={onClose}
      okText="Save to Git"
      confirmLoading={save.isPending}
      onOk={() => form.validateFields().then((v) => save.mutate(v))}
      destroyOnClose
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 4, fontSize: 12 }}>
        These details live in the repository itself (<code>.configer/application.yaml</code>) and are
        committed with your name, so the whole team sees the same description everywhere.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark={false} disabled={appQ.isLoading}>
        <Form.Item
          name="name"
          label="Name"
          rules={[{ required: true, whitespace: true, message: "Give the application a name" }]}
        >
          <Input maxLength={80} placeholder="e.g. Network Platform" />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input.TextArea
            rows={3}
            maxLength={500}
            showCount
            placeholder="What this application configures, who owns it, anything the team should know."
          />
        </Form.Item>
        <Form.Item label="Metadata" style={{ marginBottom: 0 }}>
          <Form.List name="metadata">
            {(fields, { add, remove }) => (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {fields.map(({ key, name }) => (
                  <Space.Compact key={key} style={{ width: "100%" }}>
                    <Form.Item name={[name, "key"]} noStyle>
                      <Input placeholder="key (e.g. owner)" style={{ width: "38%" }} />
                    </Form.Item>
                    <Form.Item name={[name, "value"]} noStyle>
                      <Input placeholder="value (e.g. platform-team)" />
                    </Form.Item>
                    <Button icon={<DeleteOutlined />} onClick={() => remove(name)} aria-label="Remove entry" />
                  </Space.Compact>
                ))}
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => add({ key: "", value: "" })}
                  style={{ alignSelf: "flex-start" }}
                >
                  Add metadata
                </Button>
              </div>
            )}
          </Form.List>
        </Form.Item>
      </Form>
    </Modal>
  );
}
