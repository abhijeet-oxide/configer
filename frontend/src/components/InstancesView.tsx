import {
  Button, Table, Tag, Typography, Space, Modal, Form, Input, Select, AutoComplete, Popconfirm,
  Segmented, Tooltip, App as AntApp,
} from "antd";
import {
  PlusOutlined, EditOutlined, CopyOutlined, DeleteOutlined, InboxOutlined, RollbackOutlined, SwapOutlined, DownloadOutlined,
} from "../icons";
import { useMemo, useRef, useState } from "react";
import type { InputRef } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Grid, type Instance, type InstanceInput } from "../api";
import { useUI } from "../store";
import { ENV_PRESETS } from "../theme";
import { TableSkeleton } from "./Skeletons";
import EnvTag from "./EnvTag";
import InstanceTopology from "./InstanceTopology";
import { EmptyState } from "./ui";

// InstancesView is the Instances tab: the deployment targets of an application.
// Creating, cloning or deleting an instance is a STRUCTURAL change: it stages
// into the draft change request, and submitting produces a branch where the
// instance folder is scaffolded (or removed) following the repository's own
// layout convention, reviewable like any other change. Metadata edits
// (version, region, labels, archive) commit directly with attribution.

// Status colors carry meaning (green = active, gold = deprecated, etc.); red is
// reserved for errors/destructive actions only. Environment identity colors come
// from the shared envHex source of truth (production indigo, not danger-red).
const statusColor: Record<string, string> = { active: "green", archived: "default", draft: "orange", deprecated: "gold" };

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
  versionName?: string;
  status?: string;
  /** copy configuration values from this instance ("" = start empty) */
  baseInstance?: string;
  labels?: string;
}

export default function InstancesView({ grid }: { grid: Grid }) {
  const { message, notification } = AntApp.useApp();
  const qc = useQueryClient();
  const { setCompare, setSection, setFileFocus } = useUI();

  // Take the user straight to the new instance's staged folder in Files, so a
  // structural add reads as what it is - new files appearing in the repository.
  const viewStagedFolder = (name: string) => {
    setFileFocus({ instance: name, path: "" });
    setSection("files");
  };

  // Compare from context: seed this instance as the left side (and the nearest
  // other instance as the right) and open Compare already configured, so a
  // comparison starts from intent instead of an empty two-by-two picker.
  const compareFrom = (name: string) => {
    const other = grid.instances.find((i) => i.name !== name)?.name ?? name;
    setCompare(name, other);
    setSection("compare");
  };
  const regQ = useQuery({ queryKey: ["instances"], queryFn: api.instanceRegistry });
  // The committed registry plus any instance staged in the current draft: a
  // freshly added instance lives in the grid with status "draft" before it is
  // written to the registry, so without this it would show as a column in
  // Parameters yet be missing from this list. Draft entries are appended (and
  // are never in the registry, so no duplicates).
  const instances = useMemo(() => {
    const reg = regQ.data?.instances ?? [];
    const names = new Set(reg.map((i) => i.name));
    const draftAdds = grid.instances.filter((i) => i.status === "draft" && !names.has(i.name));
    return [...reg, ...draftAdds];
  }, [regQ.data, grid.instances]);
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [view, setView] = useState<"table" | "topology">("table");
  const [modal, setModal] = useState<{ mode: "add" | "edit" | "clone"; instance?: Instance } | null>(null);
  const [copyInto, setCopyInto] = useState<{ target: string; source?: string } | null>(null);
  const [form] = Form.useForm<FormValues>();
  const nameRef = useRef<InputRef>(null);

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
    qc.invalidateQueries({ queryKey: ["draft"] });
  };

  const save = useMutation({
    mutationFn: async (v: { mode: "add" | "edit" | "clone"; orig?: string; input: InstanceInput }) => {
      if (v.mode === "edit") await api.updateInstance(v.orig!, v.input);
      else await api.addInstance(v.input);
    },
    onSuccess: (_r, v) => {
      setModal(null);
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["files-draft"] });
      if (v.mode === "edit") {
        done("Instance change staged in your draft: submit to send it for review");
        return;
      }
      // A new instance is a new folder in the repository. Refresh the estate,
      // then point the user straight at those staged files.
      done("New instance staged in your draft");
      const name = v.input.name;
      if (name)
        notification.success({
          message: `Instance "${name}" staged`,
          description: "Its folder will be created in the repository when you submit. You can preview the new files now.",
          btn: (
            <Button type="primary" size="small" onClick={() => viewStagedFolder(name)}>
              View files
            </Button>
          ),
          duration: 8,
        });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.deleteInstance(name, "demo-user"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["draft"] });
      done("Instance retirement staged in your draft: submit the changes to send it for review");
    },
    onError: (e: Error) => message.error(e.message),
  });
  const setStatus = useMutation({
    mutationFn: (p: { name: string; status: string }) => api.updateInstance(p.name, { status: p.status, author: "demo-user" }),
    onSuccess: (_r, p) => done(p.status === "archived" ? "Archive staged in your draft: submit to apply" : "Activation staged in your draft: submit to apply"),
    onError: (e: Error) => message.error(e.message),
  });

  const copyValues = useMutation({
    mutationFn: (p: { target: string; source: string }) => api.copyInstanceFrom(p.target, p.source),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
      setCopyInto(null);
      if (res.staged === 0) {
        message.info(`Nothing to copy: values already match ${res.source}`);
      } else {
        message.success(`Staged ${res.staged} value${res.staged === 1 ? "" : "s"} copied from ${res.source}`);
      }
    },
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
            versionName: instance.versionName,
            status: instance.status || "active",
            baseInstance: mode === "clone" ? instance.name : "",
            labels: formatLabels(instance.labels),
          }
        : { name: "", status: "active", baseInstance: "" },
    );
  };

  const submit = (v: FormValues) => {
    if (modal?.mode === "edit") {
      // Send ONLY what actually changed: an untouched field must not turn
      // into a registry write (and a spurious line in the Git diff).
      const orig = modal.instance!;
      const input: InstanceInput = { name: v.name, author: "demo-user" };
      const diff = (a?: string, b?: string) => (a ?? "") !== (b ?? "");
      if (diff(v.environment, orig.environment)) input.environment = v.environment ?? "";
      if (diff(v.region, orig.region)) input.region = v.region ?? "";
      if (diff(v.softwareVersion, orig.softwareVersion)) input.softwareVersion = v.softwareVersion ?? "";
      if (diff(v.versionName, orig.versionName)) input.versionName = v.versionName ?? "";
      if (diff(v.status, orig.status || "active")) input.status = v.status;
      if (diff(v.labels, formatLabels(orig.labels))) input.labels = parseLabels(v.labels ?? "");
      save.mutate({ mode: "edit", orig: orig.name, input });
      return;
    }
    const input: InstanceInput = {
      name: v.name,
      environment: v.environment,
      region: v.region,
      softwareVersion: v.softwareVersion,
      versionName: v.versionName,
      status: v.status,
      labels: v.labels ? parseLabels(v.labels) : undefined,
      author: "demo-user",
    };
    if (v.baseInstance) input.cloneFrom = v.baseInstance;
    save.mutate({ mode: modal!.mode, orig: modal?.instance?.name, input });
  };

  const shown = instances.filter((i) => {
    const st = i.status || "active";
    if (statusFilter === "all") return true;
    if (statusFilter === "archived") return st === "archived";
    return st !== "archived";
  });

  // Same loading language as every other page: a full-page skeleton in the
  // shape of the table, never a spinner overlay.
  if (regQ.isLoading) return <TableSkeleton />;

  return (
    <div className="view-pad" style={{ height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>Instances</Typography.Title>
          <Typography.Text type="secondary">
            The deployment targets for this application. Each appears as a column in the
            configuration editor.
          </Typography.Text>
        </div>
        <Space wrap>
          <Segmented
            value={view}
            onChange={(v) => setView(v as typeof view)}
            options={[
              { value: "table", label: "Table" },
              { value: "topology", label: "Topology" },
            ]}
          />
          {view === "table" && (
            <Segmented
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as typeof statusFilter)}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
                { value: "all", label: "All" },
              ]}
            />
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal("add")}>
            Add instance
          </Button>
        </Space>
      </div>

      {view === "topology" ? (
        <InstanceTopology grid={grid} />
      ) : (
      <Table<Instance>
        rowKey="name"
        size="middle"
        dataSource={shown}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{
          emptyText: (
            <EmptyState
              icon={<PlusOutlined />}
              title={statusFilter === "active" ? "No instances yet" : "None here"}
              hint={
                statusFilter === "active"
                  ? "Add an instance (a deployment target) to start managing its configuration."
                  : "No instances match this filter."
              }
              actionLabel={statusFilter === "active" ? "Add instance" : undefined}
              onAction={statusFilter === "active" ? () => openModal("add") : undefined}
            />
          ),
        }}
        columns={[
          { title: "Instance", dataIndex: "name", render: (n) => <b>{n}</b> },
          {
            title: "Environment",
            dataIndex: "environment",
            render: (e: string) => (e ? <EnvTag env={e} /> : <span style={{ opacity: 0.4 }}>-</span>),
          },
          { title: "Region", dataIndex: "region", render: (v) => v || <span style={{ opacity: 0.4 }}>-</span> },
          {
            title: "Version",
            dataIndex: "softwareVersion",
            render: (_v, i) => {
              const id = i.softwareVersion;
              if (!id) return <span style={{ opacity: 0.4 }}>-</span>;
              const name = i.versionName || id;
              return (
                <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.25 }}>
                  <span>{name}</span>
                  {i.versionName && i.versionName !== id && (
                    <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{id}</span>
                  )}
                </span>
              );
            },
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
                  <Tooltip title="Compare this instance with another">
                    <Button size="small" type="text" icon={<SwapOutlined />} onClick={() => compareFrom(i.name)} />
                  </Tooltip>
                  <Tooltip title="Edit metadata">
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openModal("edit", i)} />
                  </Tooltip>
                  <Tooltip title="Clone this instance (copies its values)">
                    <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => openModal("clone", i)} />
                  </Tooltip>
                  <Tooltip title="Copy values into this instance from another">
                    <Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => setCopyInto({ target: i.name })} />
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
                    title={`Retire instance "${i.name}"?`}
                    description="Stages the removal of its folder and registry entry into your draft; nothing happens on Git until the change is submitted and approved."
                    okText="Stage retirement"
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
      )}

      <Modal
        open={!!modal}
        title={modal?.mode === "edit" ? `Edit ${modal.instance?.name}` : modal?.mode === "clone" ? `Clone ${modal.instance?.name}` : "Add instance"}
        onCancel={() => setModal(null)}
        onOk={() => form.submit()}
        okText="Stage in draft"
        confirmLoading={save.isPending}
        destroyOnHidden
        afterOpenChange={(open) => {
          // Focus lands in the first empty input the moment the modal is up.
          if (open && modal?.mode !== "edit") nameRef.current?.focus();
        }}
      >
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false} style={{ marginTop: 12 }}>
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: "A name is required" }]}
          >
            <Input
              ref={nameRef}
              placeholder="e.g. prod-eu-central"
              disabled={modal?.mode === "edit"}
              className="mono"
            />
          </Form.Item>
          <div style={{ display: "flex", gap: 10 }}>
            <Form.Item name="environment" label="Environment" style={{ flex: 1 }}>
              <AutoComplete
                options={[...new Set([...ENV_PRESETS, ...environments])].map((e) => ({ value: e }))}
                filterOption={(input, option) =>
                  (option?.value as string).toLowerCase().includes(input.toLowerCase())
                }
                placeholder="Development"
              />
            </Form.Item>
            <Form.Item name="region" label="Region" style={{ flex: 1 }}>
              <Input placeholder="eu-central-1" />
            </Form.Item>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Form.Item name="softwareVersion" label="Version" style={{ flex: 1 }} tooltip="The version identifier, e.g. v24.3.1">
              <Input placeholder="v24.3.1" className="mono" />
            </Form.Item>
            <Form.Item name="versionName" label="Version name" style={{ flex: 1 }} tooltip="Optional friendly name for this release; defaults to the version above">
              <Input placeholder="same as version" />
            </Form.Item>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
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
          {modal?.mode !== "edit" && (
            <Form.Item
              name="baseInstance"
              label="Base instance"
              extra="The new instance's folder starts as a copy of the base instance's configuration files. Empty starts with no values; every parameter reads its default until you set it."
            >
              <Select
                options={[
                  { value: "", label: "Empty (no values copied)" },
                  ...instances
                    .filter((i) => (i.status || "active") !== "archived")
                    .map((i) => ({ value: i.name, label: `Copy from ${i.name}` })),
                ]}
              />
            </Form.Item>
          )}
          <Form.Item name="labels" label="Labels" extra="Comma-separated key=value pairs, e.g. tier=gold, tenant=acme">
            <Input placeholder="tier=gold, tenant=acme" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!copyInto}
        title={copyInto ? `Copy values into ${copyInto.target}` : "Copy values"}
        onCancel={() => setCopyInto(null)}
        okText="Stage in draft"
        okButtonProps={{ disabled: !copyInto?.source, loading: copyValues.isPending }}
        onOk={() => copyInto?.source && copyValues.mutate({ target: copyInto.target, source: copyInto.source })}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          Copy every parameter value that differs from another instance into{" "}
          <span className="mono">{copyInto?.target}</span>. Each becomes a pending change you
          review before publishing; matching values are left alone.
        </Typography.Paragraph>
        <Select
          style={{ width: "100%" }}
          placeholder="Copy values from…"
          value={copyInto?.source}
          onChange={(v) => setCopyInto((c) => (c ? { ...c, source: v } : c))}
          options={instances
            .filter((i) => i.name !== copyInto?.target && (i.status || "active") !== "archived")
            .map((i) => ({ value: i.name, label: i.name }))}
        />
      </Modal>
    </div>
  );
}
