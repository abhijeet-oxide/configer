import {
  Button, Table, Tag, Typography, Space, Modal, Form, Input, Select, AutoComplete, Popconfirm,
  Segmented, Tooltip, App as AntApp,
} from "antd";
import {
  PlusOutlined, EditOutlined, CopyOutlined, DeleteOutlined, InboxOutlined, RollbackOutlined,
} from "@ant-design/icons";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Grid, type Instance, type InstanceInput } from "../api";

// InstancesView is the Instances tab: the deployment targets of an application.
// Add, edit, clone, archive and delete instances; every change is a direct,
// attributed commit to .configer/instances.yaml, so a new instance shows up as
// a grid column right away. Archived instances stay in Git but drop out of the
// active configuration grid.

const envColor: Record<string, string> = { production: "red", staging: "orange", development: "green" };
const statusColor: Record<string, string> = { active: "green", archived: "default", draft: "blue", deprecated: "gold" };

function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split(",")) {
    const [k, ...rest] = pair.split("=");
    const key = k.trim();
    if (key) out[key] = rest.join("=").trim();
  }
  return out;
}
function formatLabels(labels?: Record<string, string>): string {
  return Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`).join(", ");
}

interface FormValues {
  name: string;
  environment?: string;
  region?: string;
  softwareVersion?: string;
  status?: string;
  labels?: string;
}

export default function InstancesView({ grid }: { grid: Grid }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const regQ = useQuery({ queryKey: ["instances"], queryFn: api.instanceRegistry });
  const instances = useMemo(() => regQ.data?.instances ?? [], [regQ.data]);
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [modal, setModal] = useState<{ mode: "add" | "edit" | "clone"; instance?: Instance } | null>(null);
  const [form] = Form.useForm<FormValues>();

  const environments = [...new Set(instances.map((i) => i.environment).filter(Boolean))] as string[];

  // Override counts (params set at instance scope) from the active grid.
  const overrideCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const inst of grid.instances) m[inst.name] = 0;
    for (const r of grid.rows) {
      for (const inst of grid.instances) {
        const c = r.cells[inst.name];
        if (c?.set && c.source === "instance") m[inst.name] = (m[inst.name] ?? 0) + 1;
      }
    }
    return m;
  }, [grid]);

  const done = (msg: string) => {
    message.success(msg);
    qc.invalidateQueries({ queryKey: ["instances"] });
    qc.invalidateQueries({ queryKey: ["grid"] });
    qc.invalidateQueries({ queryKey: ["workspace"] });
    qc.invalidateQueries({ queryKey: ["render"] });
  };

  const save = useMutation({
    mutationFn: (v: { mode: "add" | "edit" | "clone"; orig?: string; input: InstanceInput }) =>
      v.mode === "edit" ? api.updateInstance(v.orig!, v.input) : api.addInstance(v.input),
    onSuccess: (_r, v) => {
      setModal(null);
      done(v.mode === "edit" ? "Instance updated" : "Instance created");
    },
    onError: (e: Error) => message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.deleteInstance(name, "demo-user"),
    onSuccess: (r) => done(`Instance "${r.removed}" removed`),
    onError: (e: Error) => message.error(e.message),
  });
  const setStatus = useMutation({
    mutationFn: (p: { name: string; status: string }) => api.updateInstance(p.name, { status: p.status, author: "demo-user" }),
    onSuccess: (_r, p) => done(p.status === "archived" ? "Instance archived" : "Instance activated"),
    onError: (e: Error) => message.error(e.message),
  });

  const openModal = (mode: "add" | "edit" | "clone", instance?: Instance) => {
    setModal({ mode, instance });
    form.setFieldsValue(
      instance
        ? {
            name: mode === "clone" ? `${instance.name}-copy` : instance.name,
            environment: instance.environment,
            region: instance.region,
            softwareVersion: instance.softwareVersion,
            status: instance.status || "active",
            labels: formatLabels(instance.labels),
          }
        : { name: "", status: "active" },
    );
  };

  const submit = (v: FormValues) => {
    const input: InstanceInput = {
      name: v.name,
      environment: v.environment,
      region: v.region,
      softwareVersion: v.softwareVersion,
      status: v.status,
      labels: v.labels ? parseLabels(v.labels) : undefined,
      author: "demo-user",
    };
    if (modal?.mode === "clone") input.cloneFrom = modal.instance?.name;
    save.mutate({ mode: modal!.mode, orig: modal?.instance?.name, input });
  };

  const shown = instances.filter((i) => {
    const st = i.status || "active";
    if (statusFilter === "all") return true;
    if (statusFilter === "archived") return st === "archived";
    return st !== "archived";
  });

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "20px 28px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>Instances</Typography.Title>
          <Typography.Text type="secondary">
            The deployment targets of this application. Each is a column in the configuration grid and
            is stored in <code>.configer/instances.yaml</code>.
          </Typography.Text>
        </div>
        <Space>
          <Segmented
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as typeof statusFilter)}
            options={[
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
              { value: "all", label: "All" },
            ]}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal("add")}>
            Add instance
          </Button>
        </Space>
      </div>

      <Table<Instance>
        rowKey="name"
        size="middle"
        loading={regQ.isLoading}
        dataSource={shown}
        pagination={false}
        locale={{ emptyText: "No instances. Add one to start managing its configuration." }}
        columns={[
          { title: "Instance", dataIndex: "name", render: (n) => <b>{n}</b> },
          {
            title: "Environment",
            dataIndex: "environment",
            render: (e: string) => (e ? <Tag color={envColor[e] ?? "default"}>{e}</Tag> : <span style={{ opacity: 0.4 }}>-</span>),
          },
          { title: "Region", dataIndex: "region", render: (v) => v || <span style={{ opacity: 0.4 }}>-</span> },
          {
            title: "Version",
            dataIndex: "softwareVersion",
            render: (v) => (v ? <span className="mono">{v}</span> : <span style={{ opacity: 0.4 }}>-</span>),
          },
          {
            title: "Status",
            dataIndex: "status",
            render: (s: string) => <Tag color={statusColor[s || "active"] ?? "default"}>{s || "active"}</Tag>,
          },
          {
            title: "Labels",
            dataIndex: "labels",
            render: (labels: Record<string, string>) => (
              <Space size={4} wrap>
                {Object.entries(labels ?? {}).map(([k, v]) => (
                  <Tag key={k} style={{ fontSize: 11 }}>{k}={v}</Tag>
                ))}
              </Space>
            ),
          },
          {
            title: "Overrides",
            render: (_v, i) =>
              i.status === "archived" ? <span style={{ opacity: 0.4 }}>-</span> : <Tag>{overrideCount[i.name] ?? 0}</Tag>,
          },
          {
            title: "Actions",
            width: 200,
            render: (_v, i) => {
              const archived = (i.status || "active") === "archived";
              return (
                <Space size={2}>
                  <Tooltip title="Edit metadata">
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openModal("edit", i)} />
                  </Tooltip>
                  <Tooltip title="Clone this instance (copies its values)">
                    <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => openModal("clone", i)} />
                  </Tooltip>
                  {archived ? (
                    <Tooltip title="Reactivate">
                      <Button size="small" type="text" icon={<RollbackOutlined />} loading={setStatus.isPending}
                        onClick={() => setStatus.mutate({ name: i.name, status: "active" })} />
                    </Tooltip>
                  ) : (
                    <Tooltip title="Archive (removes it from the active grid, keeps it in Git)">
                      <Button size="small" type="text" icon={<InboxOutlined />} loading={setStatus.isPending}
                        onClick={() => setStatus.mutate({ name: i.name, status: "archived" })} />
                    </Tooltip>
                  )}
                  <Popconfirm
                    title={`Delete instance "${i.name}"?`}
                    description="Removes it and its generated files from Git. This cannot be undone from here."
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => remove.mutate(i.name)}
                  >
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              );
            },
          },
        ]}
      />

      <Modal
        open={!!modal}
        title={modal?.mode === "edit" ? `Edit ${modal.instance?.name}` : modal?.mode === "clone" ? `Clone ${modal.instance?.name}` : "Add instance"}
        onCancel={() => setModal(null)}
        onOk={() => form.submit()}
        okText={modal?.mode === "edit" ? "Save" : "Create"}
        confirmLoading={save.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false} style={{ marginTop: 12 }}>
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: "A name is required" }]}
            extra={modal?.mode === "clone" ? "A new instance copying the source's values." : undefined}
          >
            <Input placeholder="e.g. prod-eu-central" disabled={modal?.mode === "edit"} className="mono" />
          </Form.Item>
          <div style={{ display: "flex", gap: 10 }}>
            <Form.Item name="environment" label="Environment" style={{ flex: 1 }}>
              <AutoComplete options={environments.map((e) => ({ value: e }))} placeholder="production" />
            </Form.Item>
            <Form.Item name="region" label="Region" style={{ flex: 1 }}>
              <Input placeholder="eu-central-1" />
            </Form.Item>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Form.Item name="softwareVersion" label="Software version" style={{ flex: 1 }}>
              <Input placeholder="v24.3.1" className="mono" />
            </Form.Item>
            <Form.Item name="status" label="Status" style={{ width: 150 }}>
              <Select
                options={[
                  { value: "active", label: "Active" },
                  { value: "draft", label: "Draft" },
                  { value: "archived", label: "Archived" },
                ]}
              />
            </Form.Item>
          </div>
          <Form.Item name="labels" label="Labels" extra="Comma-separated key=value pairs, e.g. tier=gold, tenant=acme">
            <Input placeholder="tier=gold, tenant=acme" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
