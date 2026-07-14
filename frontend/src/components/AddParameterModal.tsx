import { Modal, Form, Input, Select, Switch, Radio, Typography, App as AntApp, type InputRef } from "antd";
import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Grid } from "../api";

// AddParameterModal creates a new catalog parameter from the GUI. Two modes:
// attach to a source file right away, or create it in the DESIGN PHASE (no
// file yet, e.g. the vendor's configuration hasn't arrived); design
// parameters carry values and reviews like any other and are attached to a
// real file later from the details panel.
const types = ["string", "integer", "number", "boolean", "enum", "ipv4", "cidr", "list"];
const itemTypes = ["string", "integer", "number", "ipv4", "cidr"];
const scopes = ["instance", "zone", "site", "environment", "global"];

interface FormValues {
  name: string;
  displayName?: string;
  description?: string;
  category: string;
  type: string;
  itemType?: string;
  scope: string;
  secret?: boolean;
  mode: "attach" | "design";
  file?: string;
  path?: string;
}

export default function AddParameterModal({
  open,
  onClose,
  grid,
}: {
  open: boolean;
  onClose: () => void;
  grid: Grid;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const nameRef = useRef<InputRef>(null);
  const type = Form.useWatch("type", form);
  const mode = Form.useWatch("mode", form);

  const files = [...new Set(grid.rows.map((r) => r.param.source.file).filter(Boolean))];
  const categories = [...new Set(grid.rows.map((r) => r.param.category))];

  const create = useMutation({
    mutationFn: (v: FormValues) =>
      api.addParameter(
        {
          name: v.name,
          displayName: v.displayName,
          description: v.description,
          category: v.category,
          type: v.type,
          itemType: v.type === "list" ? v.itemType || "string" : undefined,
          scope: v.scope as never,
          secret: !!v.secret,
          source:
            v.mode === "design" || !v.file
              ? undefined
              : {
                  file: v.file,
                  // default path: dotted name under root for yaml/json
                  path: v.path || (v.file.endsWith(".xml") ? "" : `$.${v.name}`),
                  format: v.file.endsWith(".xml") ? "xml" : v.file.endsWith(".json") ? "json" : "yaml",
                },
        },
        "demo-user",
      ),
    onSuccess: (p) => {
      message.success(
        p.source?.file
          ? `Parameter ${p.name} added to the catalog`
          : `Parameter ${p.name} added in the design phase. Set its values now; attach it to a file from the details panel when the configuration arrives.`,
        6,
      );
      form.resetFields();
      onClose();
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Modal
      title="Add parameter"
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Add to catalog"
      confirmLoading={create.isPending}
      afterOpenChange={(o) => o && nameRef.current?.focus()}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => create.mutate(v)}
        initialValues={{ type: "string", scope: "instance", category: categories[0], file: files[0], mode: "attach" }}
      >
        <Form.Item
          name="name"
          label="Parameter name (dotted path style)"
          rules={[
            { required: true, message: "Required" },
            { pattern: /^[a-zA-Z0-9_.[\]-]+$/, message: "Letters, digits, dots, dashes" },
          ]}
        >
          <Input ref={nameRef} placeholder="network.ntp.servers" className="mono" />
        </Form.Item>
        <Form.Item name="displayName" label="Display name">
          <Input placeholder="NTP servers" />
        </Form.Item>
        <Form.Item name="description" label="Description (used by validation docs and AI assist)">
          <Input.TextArea rows={2} placeholder="What does this parameter control?" />
        </Form.Item>
        <Form.Item name="category" label="Category" rules={[{ required: true }]}>
          <Select
            showSearch
            options={categories.map((c) => ({ value: c, label: c }))}
            popupMatchSelectWidth={false}
          />
        </Form.Item>
        <Form.Item name="type" label="Data type" rules={[{ required: true }]}>
          <Select options={types.map((t) => ({ value: t, label: t }))} />
        </Form.Item>
        {type === "list" && (
          <Form.Item name="itemType" label="List element type" initialValue="string">
            <Select options={itemTypes.map((t) => ({ value: t, label: t }))} />
          </Form.Item>
        )}
        <Form.Item name="scope" label="Scope" rules={[{ required: true }]}>
          <Select options={scopes.map((s) => ({ value: s, label: s }))} />
        </Form.Item>
        <Form.Item name="secret" label="Secret" valuePropName="checked">
          <Switch size="small" />
        </Form.Item>
        <Form.Item name="mode" label="Where does it live?">
          <Radio.Group>
            <Radio.Button value="attach">Attach to a file now</Radio.Button>
            <Radio.Button value="design">Design phase (no file yet)</Radio.Button>
          </Radio.Group>
        </Form.Item>
        {mode === "design" ? (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: -6 }}>
            The configuration file hasn't arrived yet. The parameter behaves normally: set
            values per instance, validate, review; nothing renders until you attach it to a
            real file later (details panel, one click per setting).
          </Typography.Paragraph>
        ) : (
          <>
            <Form.Item name="file" label="Source file" rules={[{ required: true, message: "Pick a file, or switch to design phase" }]}>
              <Select showSearch options={files.map((f) => ({ value: f, label: f }))} />
            </Form.Item>
            <Form.Item
              name="path"
              label="Path in file (blank = derived from name; XPath required for XML)"
            >
              <Input placeholder="$.network.ntp.servers or /network/ntp/server" className="mono" />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
}
