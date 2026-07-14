import {
  Alert,
  App as AntApp,
  Button,
  Form,
  Input,
  Result,
  Select,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  ApartmentOutlined,
  CheckCircleOutlined,
  FileSearchOutlined,
  RocketOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bindingsOf, type Instance, type Parameter } from "../api";
import { useUI } from "../store";
import { TableSkeleton } from "./Skeletons";

// OnboardingWizard turns a freshly connected repository into a managed
// application in four steps: detect the layout, confirm the instances found
// in the folder structure, review the deduplicated parameters, and initialize
// — ONE commit that adds .configer/ metadata. Values never move: they stay in
// the repository's own files, exactly where they already live.

const envOptions = ["production", "staging", "development"].map((e) => ({ value: e, label: e }));

const layoutLabels: Record<string, string> = {
  kpt: "kpt / KRM packages",
  kustomize: "Kustomize (base + overlays)",
  "plain-folders": "Per-instance folders",
};

export default function OnboardingWizard({ projectName }: { projectName: string }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const setSection = useUI((s) => s.setSection);
  const [step, setStep] = useState(0);
  const [appName, setAppName] = useState(projectName);
  const [description, setDescription] = useState("");
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [deselected, setDeselected] = useState<Set<string>>(new Set());

  const discoverQ = useQuery({ queryKey: ["discover"], queryFn: api.discover, staleTime: 60_000 });
  const d = discoverQ.data;

  // The instances table edits a local copy seeded from discovery.
  const insts = instances ?? d?.instances ?? [];
  const patchInstance = (name: string, patch: Partial<Instance>) =>
    setInstances(insts.map((i) => (i.name === name ? { ...i, ...patch } : i)));

  const chosenParams = useMemo(
    () => (d?.parameters ?? []).filter((p) => !deselected.has(p.id)),
    [d, deselected],
  );

  const init = useMutation({
    mutationFn: () =>
      api.initApp({
        name: appName.trim(),
        description: description.trim() || undefined,
        layout: d?.detection.layout,
        instances: insts,
        parameters: chosenParams,
        author: "demo-user",
      }),
    onSuccess: (r) => {
      message.success(
        `${appName} initialized: ${r.parameters} parameters across ${r.instances} instances, in one Git commit.`,
        6,
      );
      qc.invalidateQueries();
      setSection("config");
    },
    onError: (e: Error) => message.error(e.message),
  });

  if (discoverQ.isLoading) return <TableSkeleton />;
  if (discoverQ.isError || !d) {
    return (
      <Result
        status="warning"
        title="Could not scan the repository"
        subTitle={(discoverQ.error as Error | undefined)?.message}
        extra={<Button onClick={() => discoverQ.refetch()}>Try again</Button>}
      />
    );
  }

  const steps = [
    { title: "Layout", icon: <FileSearchOutlined /> },
    { title: "Instances", icon: <ApartmentOutlined /> },
    { title: "Parameters", icon: <TableOutlined /> },
    { title: "Initialize", icon: <RocketOutlined /> },
  ];

  const canNext =
    step === 0 ? appName.trim() !== "" && insts.length > 0 : step === 2 ? chosenParams.length > 0 : true;

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "20px 24px", maxWidth: 980, margin: "0 auto" }}>
      <Typography.Title level={4} style={{ marginBottom: 4 }}>
        Set up {projectName}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        Configer scanned the repository and proposes how to manage it. Nothing is written until the
        final step, which makes one reviewable Git commit adding metadata under{" "}
        <span className="mono">.configer/</span>. Your configuration files stay exactly where they are.
      </Typography.Paragraph>
      <Steps size="small" current={step} items={steps} style={{ marginBottom: 20 }} />

      {step === 0 && (
        <>
          <Alert
            type="info"
            showIcon
            message={`Detected layout: ${layoutLabels[d.detection.layout] ?? d.detection.layout}`}
            description={d.detection.note}
            style={{ marginBottom: 16 }}
          />
          <Form layout="vertical" style={{ maxWidth: 480 }}>
            <Form.Item label="Application name" required>
              <Input value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="e.g. telco-platform" />
            </Form.Item>
            <Form.Item label="Description">
              <Input.TextArea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this application configure?"
              />
            </Form.Item>
          </Form>
          {insts.length === 0 && (
            <Alert
              type="warning"
              showIcon
              message="No instances were found"
              description="Configer looks for one folder per instance (instances/, environments/, overlays/, kpt packages). Add such a structure to the repository, or connect a different branch."
            />
          )}
        </>
      )}

      {step === 1 && (
        <>
          <Typography.Paragraph type="secondary">
            Each folder below becomes one instance — a column in the parameter grid. Adjust the
            metadata; it lands in <span className="mono">.configer/instances.yaml</span>.
          </Typography.Paragraph>
          <Table<Instance>
            size="small"
            rowKey="name"
            dataSource={insts}
            pagination={false}
            columns={[
              { title: "Instance", dataIndex: "name", render: (v) => <b>{v}</b> },
              {
                title: "Folder",
                dataIndex: "folder",
                render: (v) => <span className="mono" style={{ fontSize: 12 }}>{v}</span>,
              },
              {
                title: "Environment",
                width: 170,
                render: (_v, i) => (
                  <Select
                    size="small"
                    style={{ width: 150 }}
                    allowClear
                    placeholder="unset"
                    value={i.environment || undefined}
                    options={envOptions}
                    onChange={(v) => patchInstance(i.name, { environment: v })}
                  />
                ),
              },
              {
                title: "Software version",
                width: 170,
                render: (_v, i) => (
                  <Input
                    size="small"
                    className="mono"
                    placeholder="e.g. v24.3.1"
                    value={i.softwareVersion}
                    onChange={(e) => patchInstance(i.name, { softwareVersion: e.target.value })}
                  />
                ),
              },
            ]}
          />
        </>
      )}

      {step === 2 && (
        <>
          <Typography.Paragraph type="secondary">
            One row per <i>logical</i> setting: a value repeated across files or instances was
            deduplicated into a single parameter — editing it later updates every mapped location.
            Untick anything Configer should not manage.
          </Typography.Paragraph>
          <Table<Parameter>
            size="small"
            rowKey="id"
            dataSource={d.parameters}
            pagination={d.parameters.length > 15 ? { pageSize: 15, size: "small" } : false}
            rowSelection={{
              selectedRowKeys: d.parameters.filter((p) => !deselected.has(p.id)).map((p) => p.id),
              onChange: (keys) => {
                const keep = new Set(keys as string[]);
                setDeselected(new Set(d.parameters.filter((p) => !keep.has(p.id)).map((p) => p.id)));
              },
            }}
            columns={[
              {
                title: "Setting",
                render: (_v, p) => (
                  <span>
                    <span className="mono">{p.name}</span>
                    {p.secret && <Tag color="gold" style={{ marginInlineStart: 6 }}>secret</Tag>}
                  </span>
                ),
              },
              { title: "Category", dataIndex: "category", width: 130 },
              {
                title: "Type",
                width: 90,
                render: (_v, p) => <Tag color="geekblue">{p.type}</Tag>,
              },
              {
                title: "Scope",
                width: 110,
                render: (_v, p) =>
                  p.scope === "global" ? (
                    <Tooltip title="Lives in a shared file: one edit applies to every instance">
                      <Tag color="purple">global</Tag>
                    </Tooltip>
                  ) : (
                    <Tag>instance</Tag>
                  ),
              },
              {
                title: "Locations",
                width: 110,
                render: (_v, p) => {
                  const bs = bindingsOf(p);
                  return bs.length > 1 ? (
                    <Tooltip title={bs.map((b) => `${b.file} · ${b.path}`).join("\n")}>
                      <Tag color="blue">{bs.length} files</Tag>
                    </Tooltip>
                  ) : (
                    <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>{bs[0]?.file}</span>
                  );
                },
              },
              {
                title: "Validation",
                width: 110,
                render: (_v, p) =>
                  p.validation?.schemaRef ? (
                    <Tooltip title={`From ${p.validation.schemaRef}`}>
                      <Tag color="green" icon={<CheckCircleOutlined />}>schema</Tag>
                    </Tooltip>
                  ) : p.validation && Object.keys(p.validation).length > 0 ? (
                    <Tag>rules</Tag>
                  ) : null,
              },
            ]}
          />
        </>
      )}

      {step === 3 && (
        <Result
          icon={<RocketOutlined />}
          title={`Initialize ${appName}`}
          subTitle={
            <div style={{ maxWidth: 560, margin: "0 auto", textAlign: "left" }}>
              <Typography.Paragraph>
                This makes <b>one Git commit</b> adding metadata under <span className="mono">.configer/</span>:
              </Typography.Paragraph>
              <ul style={{ textAlign: "left" }}>
                <li>
                  <span className="mono">application.yaml</span> — {appName} ·{" "}
                  {layoutLabels[d.detection.layout] ?? d.detection.layout}
                </li>
                <li>
                  <span className="mono">instances.yaml</span> — {insts.length} instances
                </li>
                <li>
                  <span className="mono">parameters.yaml</span> — {chosenParams.length} parameters
                  (descriptions, types, validation, file mappings)
                </li>
              </ul>
              <Typography.Paragraph type="secondary">
                No configuration file changes. Anyone else opening this repository sees the same
                application — it is initialized once, for everyone, in Git.
              </Typography.Paragraph>
            </div>
          }
          extra={
            <Button type="primary" size="large" icon={<RocketOutlined />} loading={init.isPending} onClick={() => init.mutate()}>
              Initialize application
            </Button>
          }
        />
      )}

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>
        <Button disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </Button>
        {step < 3 && (
          <Button type="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            Next
          </Button>
        )}
      </div>

      <Typography.Text type="secondary" style={{ display: "block", marginTop: 16, fontSize: 12 }}>
        {d.parameters.length} settings found across {insts.length} instances
        {d.sharedFiles?.length ? ` · ${d.sharedFiles.length} shared file(s)` : ""}
      </Typography.Text>
    </div>
  );
}
