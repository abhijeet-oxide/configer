import { Button, Tag, Typography, Space, Modal, Form, Input, Select, AutoComplete, Popconfirm, Segmented, Tooltip, Dropdown, App as AntApp } from "antd";
// The working-surface table: resizable, reorderable, pinnable columns whose
// layout each person keeps. See `tablekit/README.md` for which tables get it.
import { Table as DataTable } from "../tablekit";
import {
  PlusOutlined, EditOutlined, CopyOutlined, DeleteOutlined, InboxOutlined, RollbackOutlined, SwapOutlined, DownloadOutlined, MoreOutlined,
} from "../icons";
import { useCallback, useMemo, useRef, useState } from "react";
import type { InputRef } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { api, type Grid, type Instance, type InstanceInput } from "../api";
import { useUI } from "../store";
import { canonicalEnv, envOptions } from "../theme";
import { TableSkeleton } from "./Skeletons";
import EnvTag from "./EnvTag";
import InstanceTopology from "./InstanceTopology";
import InstancesGeography from "./InstancesGeography";
import { EmptyState } from "./ui";
import { useIdentity } from "../identity";
import { overflowActions, primaryActions, type InstanceAction } from "./instanceActions";

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
  description?: string;
  environment?: string;
  region?: string;
  /** Which site and zone this instance is at. They are not decoration: a
   *  parameter scoped to a site is edited ONCE for that site, and the instances
   *  it reaches are exactly the ones carrying this value. Leave it blank and
   *  the instance belongs to no site group - it is never swept into one. */
  site?: string;
  zone?: string;
  softwareVersion?: string;
  versionName?: string;
  status?: string;
  /** copy configuration values from this instance ("" = start empty) */
  baseInstance?: string;
  labels?: string;
}

// The row of things you can do to an instance: the everyday ones as labelled
// buttons, the rest behind three dots.
//
// It is one component because it is drawn in three places - the table, the
// dossier the topology opens, and the dossier the map opens - and three
// hand-built copies of "compare, edit, then a menu" is how one of them ends up
// missing the archive action next year.
export function InstanceActionBar({
  actions,
  size = "small",
  block = false,
}: {
  actions: InstanceAction[];
  size?: "small" | "middle";
  /** the dossier gives them room to be full-width buttons */
  block?: boolean;
}) {
  const primary = primaryActions(actions);
  const more = overflowActions(actions);
  if (actions.length === 0) return null;
  return (
    <Space size={4} wrap={block}>
      {primary.map((a) => {
        const btn = (
          <Button
            key={a.key}
            size={size}
            icon={a.icon}
            danger={a.danger}
            disabled={a.disabled}
            loading={a.loading}
            onClick={a.confirm ? undefined : a.run}
          >
            {a.label}
          </Button>
        );
        return a.confirm ? (
          <Popconfirm
            key={a.key}
            title={a.confirm.title}
            description={a.confirm.description}
            okText={a.confirm.okText}
            okButtonProps={{ danger: a.danger }}
            onConfirm={a.run}
          >
            {btn}
          </Popconfirm>
        ) : a.hint ? (
          <Tooltip key={a.key} title={a.hint}>
            {btn}
          </Tooltip>
        ) : (
          btn
        );
      })}
      {more.length > 0 && (
        <InstanceOverflow actions={more} size={size} />
      )}
    </Space>
  );
}

// The three-dot menu. Its own component because a confirm inside a menu item
// has to survive the menu closing under it: the item sets `pending`, the menu
// shuts, and the confirmation is asked in a modal that outlives it.
function InstanceOverflow({ actions, size }: { actions: InstanceAction[]; size: "small" | "middle" }) {
  const [pending, setPending] = useState<InstanceAction | null>(null);
  return (
    <>
      <Dropdown
        trigger={["click"]}
        menu={{
          items: actions.map((a) => ({
            key: a.key,
            icon: a.icon,
            label: a.label,
            danger: a.danger,
            disabled: a.disabled,
          })),
          onClick: ({ key }) => {
            const a = actions.find((x) => x.key === key);
            if (!a) return;
            if (a.confirm) setPending(a);
            else a.run();
          },
        }}
      >
        <Button size={size} icon={<MoreOutlined />} aria-label="More actions" title="More actions" />
      </Dropdown>
      <Modal
        open={!!pending}
        title={pending?.confirm?.title}
        okText={pending?.confirm?.okText}
        okButtonProps={{ danger: pending?.danger }}
        onOk={() => {
          pending?.run();
          setPending(null);
        }}
        onCancel={() => setPending(null)}
        destroyOnHidden
      >
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          {pending?.confirm?.description}
        </Typography.Paragraph>
      </Modal>
    </>
  );
}

export default function InstancesView({ grid }: { grid: Grid }) {
  const { message, notification } = AntApp.useApp();
  // Adding, editing, cloning, archiving and retiring an instance all stage
  // changes. A viewer sees the estate and can compare, nothing more.
  const { canEdit } = useIdentity();
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
  const regQ = useRepoQuery({ queryKey: ["instances"], queryFn: api.instanceRegistry });
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
  const [view, setView] = useState<"table" | "topology" | "geography">("table");
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
    mutationFn: (name: string) => api.deleteInstance(name, "Local user"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["draft"] });
      done("Instance retirement staged in your draft: submit the changes to send it for review");
    },
    onError: (e: Error) => message.error(e.message),
  });
  const setStatus = useMutation({
    mutationFn: (p: { name: string; status: string }) => api.updateInstance(p.name, { status: p.status, author: "Local user" }),
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
            // A copy is a DIFFERENT instance, so it does not inherit a
            // sentence written about the one it came from.
            description: mode === "clone" ? "" : instance.description,
            environment: instance.environment,
            region: instance.region,
            site: instance.site,
            zone: instance.zone,
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
    // The picker is free text, so the same environment arrives spelled several
    // ways; what gets WRITTEN is the one spelling, or the estate ends up with
    // "lab" and "Lab" as two environments.
    const environment = canonicalEnv(v.environment);
    if (modal?.mode === "edit") {
      // Send ONLY what actually changed: an untouched field must not turn
      // into a registry write (and a spurious line in the Git diff).
      const orig = modal.instance!;
      const input: InstanceInput = { name: v.name, author: "Local user" };
      const diff = (a?: string, b?: string) => (a ?? "") !== (b ?? "");
      if (diff(environment, orig.environment)) input.environment = environment ?? "";
      if (diff(v.description, orig.description)) input.description = v.description ?? "";
      if (diff(v.region, orig.region)) input.region = v.region ?? "";
      if (diff(v.site, orig.site)) input.site = v.site ?? "";
      if (diff(v.zone, orig.zone)) input.zone = v.zone ?? "";
      if (diff(v.softwareVersion, orig.softwareVersion)) input.softwareVersion = v.softwareVersion ?? "";
      if (diff(v.versionName, orig.versionName)) input.versionName = v.versionName ?? "";
      if (diff(v.status, orig.status || "active")) input.status = v.status;
      if (diff(v.labels, formatLabels(orig.labels))) input.labels = parseLabels(v.labels ?? "");
      save.mutate({ mode: "edit", orig: orig.name, input });
      return;
    }
    const input: InstanceInput = {
      name: v.name,
      description: v.description,
      environment,
      region: v.region,
      site: v.site,
      zone: v.zone,
      softwareVersion: v.softwareVersion,
      versionName: v.versionName,
      status: v.status,
      labels: v.labels ? parseLabels(v.labels) : undefined,
      author: "Local user",
    };
    if (v.baseInstance) input.cloneFrom = v.baseInstance;
    save.mutate({ mode: modal!.mode, orig: modal?.instance?.name, input });
  };

  // Everything that can be done to one instance, built once. The table draws
  // it as a row of buttons, the dossier draws it as a column of them, and
  // neither of them decides what is on the list.
  const actionsFor = useCallback(
    (i: Instance): InstanceAction[] => {
      const archived = (i.status || "active") === "archived";
      const list: InstanceAction[] = [
        {
          key: "compare",
          label: "Compare",
          icon: <SwapOutlined />,
          hint: "Compare this instance with another",
          primary: true,
          run: () => compareFrom(i.name),
        },
      ];
      if (!canEdit) return list;
      return [
        ...list,
        {
          key: "edit",
          label: "Edit info",
          icon: <EditOutlined />,
          hint: "Environment, region, version, labels",
          primary: true,
          run: () => openModal("edit", i),
        },
        {
          key: "clone",
          label: "Clone instance",
          icon: <CopyOutlined />,
          hint: "Create a new instance from this one's configuration",
          run: () => openModal("clone", i),
        },
        {
          key: "copy",
          label: "Copy values in from…",
          icon: <DownloadOutlined />,
          hint: "Stage every value that differs from another instance",
          run: () => setCopyInto({ target: i.name }),
        },
        archived
          ? {
              key: "activate",
              label: "Reactivate",
              icon: <RollbackOutlined />,
              loading: setStatus.isPending,
              run: () => setStatus.mutate({ name: i.name, status: "active" }),
            }
          : {
              key: "archive",
              label: "Archive",
              icon: <InboxOutlined />,
              hint: "Removes it from the active grid, keeps it in Git",
              loading: setStatus.isPending,
              run: () => setStatus.mutate({ name: i.name, status: "archived" }),
            },
        {
          key: "retire",
          label: "Retire instance",
          icon: <DeleteOutlined />,
          danger: true,
          confirm: {
            title: `Retire instance "${i.name}"?`,
            description:
              "Stages the removal of its folder and registry entry into your draft; nothing happens on Git until the change is submitted and approved.",
            okText: "Stage retirement",
          },
          run: () => remove.mutate(i.name),
        },
      ];
    },
    // openModal and compareFrom are recreated each render but close over stable
    // state; the mutations are what really change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canEdit, setStatus.isPending, remove, setCopyInto],
  );

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
              { value: "geography", label: "Geography" },
            ]}
          />
          {/* Which instances are in scope is the same question in every view,
              so it is asked once. Hiding it outside the table left the other
              views quietly showing archived instances with no way to say so. */}
          <Segmented
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as typeof statusFilter)}
            options={[
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
              { value: "all", label: "All" },
            ]}
          />
          {canEdit && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal("add")}>
              Add instance
            </Button>
          )}
        </Space>
      </div>

      {view === "topology" ? (
        <InstanceTopology grid={grid} instances={shown} actionsFor={actionsFor} />
      ) : view === "geography" ? (
        <InstancesGeography grid={grid} instances={shown} actionsFor={actionsFor} />
      ) : (
      <DataTable<Instance>
        tableEnhancedKey="instances"
        allow_export
        show_column_visibility
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
          {
            title: "Instance",
            dataIndex: "name",
            render: (n: string, i) => (
              // The name identifies it; the description says what it IS. Two
              // lines in one column, because they answer the same question and
              // a column of its own would push everything else off the screen.
              <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.3 }}>
                <b>{n}</b>
                {i.description && (
                  <span style={{ fontSize: 11, color: "var(--text-3)" }}>{i.description}</span>
                )}
              </span>
            ),
          },
          {
            title: "Environment",
            dataIndex: "environment",
            render: (e: string) => (e ? <EnvTag env={e} /> : <span style={{ opacity: 0.4 }}>-</span>),
          },
          { title: "Region", dataIndex: "region", render: (v) => v || <span style={{ opacity: 0.4 }}>-</span> },
          // Site and zone are columns because they are what a group-scoped
          // parameter is edited by: "which instances does one value reach" is
          // answered here, and an estate where nobody filled them in is an
          // estate where those scopes silently reach nothing.
          {
            title: "Site",
            dataIndex: "site",
            render: (v: string) => v || <span style={{ opacity: 0.4 }}>-</span>,
          },
          {
            title: "Zone",
            dataIndex: "zone",
            render: (v: string) => v || <span style={{ opacity: 0.4 }}>-</span>,
          },
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
            // Wide enough for two labelled buttons and the overflow. Six
            // icon-only buttons fitted in less, and cost the reader a guess per
            // button about which glyph meant archive.
            width: 250,
            render: (_v, i) => <InstanceActionBar actions={actionsFor(i)} />,
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
          <Form.Item
            name="description"
            label="Description"
            tooltip="What this instance is for, in your own words - the site it serves, or what makes it different from its neighbours"
          >
            <Input placeholder="e.g. Primary session border controller for the Warrenville site" />
          </Form.Item>
          <div style={{ display: "flex", gap: 10 }}>
            <Form.Item name="environment" label="Environment" style={{ flex: 1 }}>
              <AutoComplete
                options={envOptions(environments).map((e) => ({ value: e }))}
                filterOption={(input, option) =>
                  (option?.value as string).toLowerCase().includes(input.toLowerCase())
                }
                placeholder="Development"
              />
            </Form.Item>
            <Form.Item
              name="region"
              label="Region"
              tooltip="Filled in from the instance name when a rule recognizes it; edit it freely"
              style={{ flex: 1 }}
            >
              <Input placeholder="eu-central-1" />
            </Form.Item>
          </div>
          {/* WHERE IT IS, in the estate's own terms. These two fields are what
              a site- or zone-scoped parameter is edited BY: set them, and one
              value can be given to every system at a site instead of typed into
              four cells and hoped over. An instance left blank here belongs to
              no group of that kind, and a group edit never reaches it. */}
          <div style={{ display: "flex", gap: 10 }}>
            <Form.Item
              name="site"
              label="Site"
              tooltip="The place this system is at. A site-scoped parameter is given one value per site, and it reaches every instance sharing this name."
              style={{ flex: 1 }}
            >
              <AutoComplete
                options={[...new Set(instances.map((i) => i.site).filter(Boolean))].map((sv) => ({ value: sv as string }))}
                placeholder="e.g. dallas"
              />
            </Form.Item>
            <Form.Item
              name="zone"
              label="Zone"
              tooltip="The wider grouping this system sits in. A zone-scoped parameter is given one value per zone."
              style={{ flex: 1 }}
            >
              <AutoComplete
                options={[...new Set(instances.map((i) => i.zone).filter(Boolean))].map((zv) => ({ value: zv as string }))}
                placeholder="e.g. central"
              />
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
