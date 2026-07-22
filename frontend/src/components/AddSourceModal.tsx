import { Modal, Form, Input, Card, Typography, Tag, Space, App as AntApp } from "antd";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SourcePlugin } from "../api";
import { sourceIcon, sourceHex } from "./sourceVisual";

// AddSourceModal defines a new external source in two steps: pick a source
// plugin (the registered providers, shown as cards), then fill the plugin's own
// config fields (rendered dynamically from its Fields()). Credential fields are
// resolved from the server environment, so they show as a note, never an input.
export default function AddSourceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [picked, setPicked] = useState<SourcePlugin | null>(null);

  const pluginsQ = useQuery({ queryKey: ["source-plugins"], queryFn: api.sourcePlugins, enabled: open });

  const create = useMutation({
    mutationFn: (v: { name: string; config: Record<string, string> }) =>
      api.addSource({ name: v.name, kind: picked!.id, secret: picked!.category === "Secret store", config: v.config }),
    onSuccess: () => {
      message.success("Source added");
      qc.invalidateQueries();
      close();
    },
    onError: (e: unknown) => message.error(e instanceof Error ? e.message : "Could not add the source"),
  });

  function close() {
    setPicked(null);
    form.resetFields();
    onClose();
  }

  async function submit() {
    const vals = await form.validateFields();
    const config: Record<string, string> = {};
    for (const f of picked!.fields) {
      if (f.secret) continue; // credentials never leave the environment
      const v = vals[f.key];
      if (v != null && String(v).trim() !== "") config[f.key] = String(v).trim();
    }
    create.mutate({ name: vals.__name, config });
  }

  return (
    <Modal
      title={picked ? `Add ${picked.name} source` : "Add a source"}
      open={open}
      onCancel={picked ? () => setPicked(null) : close}
      onOk={picked ? submit : undefined}
      okText="Add source"
      okButtonProps={{ style: { display: picked ? undefined : "none" }, loading: create.isPending }}
      cancelText={picked ? "Back" : "Cancel"}
      width={560}
      destroyOnClose
    >
      {!picked ? (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Choose where the values come from. Each source is a plugin; more can be added over time.
          </Typography.Paragraph>
          {(pluginsQ.data ?? []).map((p) => {
            const hex = sourceHex(p.color);
            return (
              <Card key={p.id} size="small" hoverable onClick={() => setPicked(p)} style={{ cursor: "pointer" }}>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <span
                    style={{
                      display: "inline-flex",
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 18,
                      color: hex,
                      background: `color-mix(in srgb, ${hex} 14%, transparent)`,
                    }}
                  >
                    {sourceIcon(p.icon)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {p.name} {p.category && <Tag color={p.color}>{p.category}</Tag>}
                    </div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {p.description}
                    </Typography.Text>
                  </div>
                </div>
              </Card>
            );
          })}
        </Space>
      ) : (
        <Form form={form} layout="vertical">
          <Form.Item name="__name" label="Name" rules={[{ required: true, message: "Give this source a name" }]}>
            <Input placeholder="e.g. Platform defaults" />
          </Form.Item>
          {picked.fields.map((f) =>
            f.secret ? (
              <Form.Item key={f.key} label={f.label}>
                <Input disabled placeholder="Resolved from the server environment" />
                {f.help && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {f.help}
                  </Typography.Text>
                )}
              </Form.Item>
            ) : (
              <Form.Item
                key={f.key}
                name={f.key}
                label={f.label}
                rules={f.required ? [{ required: true, message: `${f.label} is required` }] : []}
                extra={f.help}
              >
                <Input placeholder={f.help} />
              </Form.Item>
            ),
          )}
        </Form>
      )}
    </Modal>
  );
}
