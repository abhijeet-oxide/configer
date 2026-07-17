import {
  Alert,
  App as AntApp,
  AutoComplete,
  Badge,
  Button,
  Empty,
  Form,
  Input,
  Popover,
  Result,
  Space,
  Steps,
  Table,
  Tag,
  Tooltip,
  Tree,
  Typography,
} from "antd";
import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CloudUploadOutlined,
  FileSearchOutlined,
  LeftOutlined,
  PartitionOutlined,
  RightOutlined,
  SearchOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bindingsOf, type Binding, type Instance, type Parameter } from "../api";
import { ENV_PRESETS } from "../theme";
import { useUI } from "../store";
import { fileIcon, folderIcon } from "./fileIcons";
import InitProgress from "./InitProgress";
import { OfflineArt, ScanArt, StatePanel, SuccessArt } from "./illustrations";

// OnboardingWizard turns a freshly connected repository into a managed
// application: detect the layout, confirm the instances, CHOOSE WHICH FILES to
// manage (a checkbox tree of the real folder structure), review the
// deduplicated parameters, and initialize - ONE commit that adds .configer/
// metadata. Values never move: they stay in the repository's own files.

const layoutLabels: Record<string, string> = {
  kpt: "kpt / KRM packages",
  kustomize: "Kustomize (base + overlays)",
  "plain-folders": "Per-instance folders",
};

// --- file helpers -----------------------------------------------------------

const INST_TOKEN = "{folder}/";

function folderOf(i: Instance): string {
  return i.folder || `instances/${i.name}`;
}

// The real repository files a binding touches: a shared binding is one literal
// file; an instance-template binding ({folder}/…) expands to each instance.
function filesOfBinding(b: Binding, insts: Instance[]): string[] {
  if (b.file.includes("{folder}") || b.file.includes("{instance}")) {
    return insts.map((i) =>
      b.file.replace(/\{folder\}/g, folderOf(i)).replace(/\{instance\}/g, i.name),
    );
  }
  return [b.file];
}

function filesOfParam(p: Parameter, insts: Instance[]): string[] {
  const set = new Set<string>();
  for (const b of bindingsOf(p)) for (const f of filesOfBinding(b, insts)) set.add(f);
  return [...set];
}

interface FileNode {
  key: string;
  title: string;
  isLeaf?: boolean;
  children?: FileNode[];
}

// Build a folder/file tree from a flat list of repo-relative paths.
function buildFileTree(files: string[]): { nodes: FileNode[]; fileKeys: string[]; folderKeys: string[] } {
  const root: FileNode[] = [];
  const fileKeys: string[] = [];
  const folderKeys = new Set<string>();
  for (const f of [...files].sort()) {
    const parts = f.split("/");
    let level = root;
    let prefix = "";
    parts.forEach((part, idx) => {
      prefix = prefix ? `${prefix}/${part}` : part;
      const isLeaf = idx === parts.length - 1;
      let node = level.find((n) => n.key === prefix);
      if (!node) {
        node = isLeaf ? { key: prefix, title: part, isLeaf: true } : { key: prefix, title: part, children: [] };
        level.push(node);
      }
      if (isLeaf) fileKeys.push(prefix);
      else {
        folderKeys.add(prefix);
        level = node.children!;
      }
    });
  }
  return { nodes: root, fileKeys, folderKeys: [...folderKeys] };
}

function pruneTree(nodes: FileNode[], q: string): FileNode[] {
  if (!q) return nodes;
  const out: FileNode[] = [];
  for (const n of nodes) {
    if (n.key.toLowerCase().includes(q)) {
      out.push(n); // a matching folder keeps its whole subtree
      continue;
    }
    if (n.isLeaf) continue;
    const kids = pruneTree(n.children ?? [], q);
    if (kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

// Pretty binding: the file (instance templates shown without the {folder}/
// prefix, tagged "per instance"), its line, and its in-file path.
function prettyBinding(b: Binding): { file: string; perInstance: boolean } {
  if (b.file.startsWith(INST_TOKEN)) return { file: b.file.slice(INST_TOKEN.length), perInstance: true };
  return { file: b.file, perInstance: false };
}

function LocationsCell({ p }: { p: Parameter }) {
  const bs = bindingsOf(p);
  if (bs.length === 0) return <Tag color="purple">design</Tag>;
  const content = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 360 }}>
      {bs.map((b, i) => {
        const pb = prettyBinding(b);
        const dir = pb.file.includes("/") ? pb.file.slice(0, pb.file.lastIndexOf("/") + 1) : "";
        const base = pb.file.slice(dir.length);
        return (
          <div key={i} style={{ fontSize: 12 }}>
            <div style={{ overflowWrap: "anywhere" }}>
              <span className="mono" style={{ opacity: 0.55 }}>{dir}</span>
              <span className="mono" style={{ fontWeight: 600 }}>{base}</span>
              {b.line ? <span className="mono" style={{ color: "var(--c-review)" }}>:{b.line}</span> : null}
              {pb.perInstance && (
                <Tag style={{ marginInlineStart: 6, fontSize: 10 }}>per instance</Tag>
              )}
            </div>
            <div className="mono" style={{ fontSize: 11, opacity: 0.6, overflowWrap: "anywhere" }}>{b.path}</div>
          </div>
        );
      })}
    </div>
  );
  const first = prettyBinding(bs[0]);
  const firstBase = first.file.slice(first.file.lastIndexOf("/") + 1);
  return (
    <Popover title="Where this value lives" content={content} placement="left">
      <span style={{ cursor: "pointer" }}>
        {bs.length > 1 ? (
          <Tag color="blue">{bs.length} files</Tag>
        ) : (
          <span className="mono" style={{ fontSize: 11, opacity: 0.8 }}>
            {firstBase}
            {bs[0].line ? <span style={{ color: "var(--c-review)" }}>:{bs[0].line}</span> : null}
          </span>
        )}
      </span>
    </Popover>
  );
}

export default function OnboardingWizard({ projectName }: { projectName: string }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const setSection = useUI((s) => s.setSection);
  const [step, setStep] = useState(0);
  const [appName, setAppName] = useState(projectName);
  const [description, setDescription] = useState("");
  const [instances, setInstances] = useState<Instance[] | null>(null);
  // Files unchecked in the tree; a parameter with all its files unchecked is
  // dropped. Manually unticked parameters (finer control) live in deselected.
  const [uncheckedFiles, setUncheckedFiles] = useState<Set<string>>(new Set());
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [treeQ, setTreeQ] = useState("");
  const [paramQ, setParamQ] = useState("");
  const [treeCollapsed, setTreeCollapsed] = useState(false);

  const discoverQ = useQuery({ queryKey: ["discover"], queryFn: api.discover, staleTime: 60_000 });
  const d = discoverQ.data;

  const insts = useMemo(() => instances ?? d?.instances ?? [], [instances, d]);
  const patchInstance = (name: string, patch: Partial<Instance>) =>
    setInstances(insts.map((i) => (i.name === name ? { ...i, ...patch } : i)));

  // Map every parameter to the real files it touches, and the full file set.
  const filesByParam = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of d?.parameters ?? []) m.set(p.id, filesOfParam(p, insts));
    return m;
  }, [d, insts]);
  const allFiles = useMemo(() => {
    const s = new Set<string>();
    for (const files of filesByParam.values()) for (const f of files) s.add(f);
    return [...s];
  }, [filesByParam]);
  const { nodes: treeNodes, fileKeys, folderKeys } = useMemo(() => buildFileTree(allFiles), [allFiles]);

  // Ant Tree wants the fully-checked keys: every still-selected file, plus a
  // folder only when ALL of its descendant files are selected (a partially
  // selected folder is left out so the tree renders it indeterminate).
  const checkedKeys = useMemo(() => {
    const files = fileKeys.filter((k) => !uncheckedFiles.has(k));
    const folders = folderKeys.filter((fk) => {
      const kids = fileKeys.filter((f) => f.startsWith(fk + "/"));
      return kids.length > 0 && kids.every((f) => !uncheckedFiles.has(f));
    });
    return [...files, ...folders];
  }, [fileKeys, folderKeys, uncheckedFiles]);

  // A parameter survives if at least one of its files is still selected.
  const includedByFiles = (p: Parameter): boolean => {
    const files = filesByParam.get(p.id) ?? [];
    if (files.length === 0) return true; // design-phase params have no file
    return files.some((f) => !uncheckedFiles.has(f));
  };
  const fileIncludedParams = useMemo(
    () => (d?.parameters ?? []).filter(includedByFiles),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d, uncheckedFiles, filesByParam],
  );
  const chosenParams = useMemo(
    () => fileIncludedParams.filter((p) => !deselected.has(p.id)),
    [fileIncludedParams, deselected],
  );

  const shownParams = useMemo(() => {
    const q = paramQ.trim().toLowerCase();
    if (!q) return fileIncludedParams;
    return fileIncludedParams.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.category ?? "").toLowerCase().includes(q) ||
        bindingsOf(p).some((b) => b.file.toLowerCase().includes(q) || b.path.toLowerCase().includes(q)),
    );
  }, [fileIncludedParams, paramQ]);

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
      // Let the completion state (100% + check) land before switching views.
      setTimeout(() => {
        qc.invalidateQueries();
        setSection("config");
      }, 850);
    },
    onError: (e: Error) => message.error(e.message),
  });

  if (discoverQ.isLoading) {
    return (
      <div style={{ paddingTop: 32 }}>
        <StatePanel
          art={<ScanArt />}
          title="Scanning the repository…"
          subtitle="Detecting the layout, instances and settings. This only reads your files."
        />
      </div>
    );
  }
  if (discoverQ.isError || !d) {
    return (
      <div style={{ paddingTop: 40 }}>
        <StatePanel
          art={<OfflineArt />}
          title="Couldn't scan the repository"
          subtitle={(discoverQ.error as Error | undefined)?.message ?? "The scan didn't complete."}
          actions={
            <>
              <Button type="primary" onClick={() => discoverQ.refetch()}>Try again</Button>
              <Button onClick={() => setSection("workspace")}>Back to Applications</Button>
            </>
          }
        />
      </div>
    );
  }

  const steps = [
    { title: "Layout", icon: <FileSearchOutlined /> },
    { title: "Instances", icon: <ApartmentOutlined /> },
    { title: "Files & parameters", icon: <TableOutlined /> },
    { title: "Initialize", icon: <CheckCircleOutlined /> },
  ];

  const canNext =
    step === 0
      ? appName.trim() !== "" && insts.length > 0
      : step === 2
        ? chosenParams.length > 0
        : true;

  // --- tree interactions ---
  const treeData = pruneTree(treeNodes, treeQ.trim().toLowerCase());
  const setAllFiles = (checked: boolean) => setUncheckedFiles(checked ? new Set() : new Set(fileKeys));

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "16px 24px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <Typography.Title level={4} style={{ marginBottom: 4 }}>
          Set up {projectName}
        </Typography.Title>
        <Button icon={<ArrowLeftOutlined />} onClick={() => setSection("workspace")}>
          Back to Applications
        </Button>
      </div>
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
            Each folder below becomes one instance - a column in the parameter grid. Set the
            environment (pick a suggestion or type your own) and version; it lands in{" "}
            <span className="mono">.configer/instances.yaml</span>.
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
                width: 190,
                render: (_v, i) => (
                  <AutoComplete
                    size="small"
                    style={{ width: 170 }}
                    allowClear
                    placeholder="e.g. Development"
                    value={i.environment || undefined}
                    options={ENV_PRESETS.map((e) => ({ value: e }))}
                    filterOption={(input, option) =>
                      (option?.value as string).toLowerCase().includes(input.toLowerCase())
                    }
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
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message="You can add more instances any time"
            description="Once the application is set up, create, clone or retire instances from the Instances tab (Manage instances) - no need to get them all here."
          />
        </>
      )}

      {step === 2 && (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          {/* Left: the file tree, collapsible to a thin rail. Unticking a file
              or folder removes its settings from the table on the right. */}
          {treeCollapsed ? (
            <Tooltip title="Show files" placement="right">
              <div
                onClick={() => setTreeCollapsed(false)}
                className="panel-rail"
                style={{
                  width: 30, flexShrink: 0, cursor: "pointer", alignSelf: "stretch",
                  border: "1px solid rgba(127,137,160,0.28)", borderRadius: 10,
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 8, paddingTop: 10,
                }}
              >
                <RightOutlined style={{ fontSize: 11, opacity: 0.7 }} />
                <span style={{ writingMode: "vertical-rl", fontSize: 12, opacity: 0.7 }}>
                  Files ({fileKeys.length - uncheckedFiles.size}/{fileKeys.length})
                </span>
              </div>
            </Tooltip>
          ) : (
            <div style={{ width: 320, flexShrink: 0, border: "1px solid rgba(127,137,160,0.28)", borderRadius: 10, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: "1px solid rgba(127,137,160,0.18)" }}>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  <PartitionOutlined style={{ marginInlineEnd: 6 }} />
                  Files to manage
                </Typography.Text>
                <Tooltip title="Collapse">
                  <Button size="small" type="text" icon={<LeftOutlined />} onClick={() => setTreeCollapsed(true)} />
                </Tooltip>
              </div>
              <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
                <Input
                  allowClear
                  size="small"
                  prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
                  placeholder="Filter files"
                  value={treeQ}
                  onChange={(e) => setTreeQ(e.target.value)}
                />
                <Space size={6}>
                  <Button size="small" onClick={() => setAllFiles(true)}>Select all</Button>
                  <Button size="small" onClick={() => setAllFiles(false)}>Clear</Button>
                </Space>
              </div>
              <div style={{ padding: "0 8px 8px", maxHeight: 420, overflow: "auto", flex: 1 }}>
                {allFiles.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No files detected." />
                ) : (
                  <Tree
                    className="compact-tree"
                    checkable
                    selectable={false}
                    defaultExpandAll
                    treeData={treeData}
                    checkedKeys={checkedKeys}
                    {...(treeQ ? { expandedKeys: folderKeys, autoExpandParent: true } : {})}
                    showIcon
                    icon={(node) => {
                      const n = node as unknown as FileNode;
                      return n.isLeaf ? fileIcon(n.title) : folderIcon();
                    }}
                    onCheck={(checked) => {
                      const set = new Set(checked as React.Key[]);
                      setUncheckedFiles(new Set(fileKeys.filter((k) => !set.has(k))));
                    }}
                  />
                )}
              </div>
              <div style={{ padding: "6px 10px", borderTop: "1px solid rgba(127,137,160,0.18)", fontSize: 12, opacity: 0.7 }}>
                {fileKeys.length - uncheckedFiles.size} of {fileKeys.length} files kept
              </div>
            </div>
          )}

          {/* Right: the deduplicated parameters from the selected files. */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              One row per <i>logical</i> setting from the selected files: a value repeated across
              files or instances is deduplicated into one parameter (the{" "}
              <Tag color="blue" style={{ marginInline: 2 }}>N files</Tag> badge shows how many
              locations it maps to). Untick anything Configer should not manage.
            </Typography.Paragraph>
            <Space style={{ marginBottom: 10 }} wrap>
              <Input
                allowClear
                size="small"
                prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
                placeholder="Search settings, files, paths"
                value={paramQ}
                onChange={(e) => setParamQ(e.target.value)}
                style={{ width: 280 }}
              />
              <Button size="small" onClick={() => setDeselected(new Set())}>Select all</Button>
              <Button
                size="small"
                onClick={() => setDeselected(new Set(fileIncludedParams.map((p) => p.id)))}
              >
                Select none
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {chosenParams.length} of {fileIncludedParams.length} selected
              </Typography.Text>
            </Space>
            <Table<Parameter>
            size="small"
            rowKey="id"
            dataSource={shownParams}
            pagination={shownParams.length > 15 ? { pageSize: 15, size: "small" } : false}
            rowSelection={{
              selectedRowKeys: shownParams.filter((p) => !deselected.has(p.id)).map((p) => p.id),
              onChange: (keys) => {
                const keep = new Set(keys as string[]);
                // Only toggle the rows currently in view; leave others as-is.
                setDeselected((prev) => {
                  const next = new Set(prev);
                  for (const p of shownParams) {
                    if (keep.has(p.id)) next.delete(p.id);
                    else next.add(p.id);
                  }
                  return next;
                });
              },
            }}
            columns={[
              {
                title: "Setting",
                render: (_v, p) => {
                  const n = bindingsOf(p).length;
                  return (
                    <Space size={6}>
                      <span className="mono">{p.name}</span>
                      {n > 1 && <Badge count={n} color="var(--c-review)" title={`${n} locations`} />}
                      {p.secret && <Tag color="gold">secret</Tag>}
                    </Space>
                  );
                },
              },
              { title: "Category", dataIndex: "category", width: 130 },
              { title: "Type", width: 90, render: (_v, p) => <Tag color="geekblue">{p.type}</Tag> },
              {
                title: "Scope",
                width: 100,
                render: (_v, p) =>
                  p.scope === "global" ? (
                    <Tooltip title="Lives in a shared file: one edit applies to every instance">
                      <Tag color="purple">global</Tag>
                    </Tooltip>
                  ) : (
                    <Tag>instance</Tag>
                  ),
              },
              { title: "Locations", width: 130, render: (_v, p) => <LocationsCell p={p} /> },
              {
                title: "Validation",
                width: 100,
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
          </div>
        </div>
      )}

      {step === 3 &&
        (init.isSuccess ? (
          // A warm, illustrated completion before the editor opens.
          <div style={{ paddingTop: 24 }}>
            <StatePanel
              art={<SuccessArt />}
              title={`${appName} is ready`}
              subtitle={`${chosenParams.length} parameter${chosenParams.length === 1 ? "" : "s"} across ${insts.length} instance${insts.length === 1 ? "" : "s"}, initialized in one Git commit. Opening the editor…`}
            />
          </div>
        ) : init.isPending ? (
          // The mature, contextual progress experience while the commit runs.
          <div style={{ maxWidth: 480, margin: "24px auto 0", textAlign: "center" }}>
            <Typography.Title level={5} style={{ marginBottom: 18 }}>
              Setting up {appName}…
            </Typography.Title>
            <InitProgress
              instances={insts.length}
              params={chosenParams.length}
              running
              done={false}
            />
          </div>
        ) : (
          <Result
            icon={<CloudUploadOutlined style={{ color: "var(--ant-color-primary, #2f6bff)" }} />}
            title={`Initialize ${appName}`}
            subTitle={
              <div style={{ maxWidth: 560, margin: "0 auto", textAlign: "left" }}>
                <Typography.Paragraph>
                  This makes <b>one Git commit</b> adding metadata under <span className="mono">.configer/</span>:
                </Typography.Paragraph>
                <ul style={{ textAlign: "left" }}>
                  <li>
                    <span className="mono">application.yaml</span> - {appName} ·{" "}
                    {layoutLabels[d.detection.layout] ?? d.detection.layout}
                  </li>
                  <li>
                    <span className="mono">instances.yaml</span> - {insts.length} instances
                  </li>
                  <li>
                    <span className="mono">parameters.yaml</span> - {chosenParams.length} parameters
                    (descriptions, types, validation, file mappings)
                  </li>
                </ul>
                <Typography.Paragraph type="secondary">
                  No configuration file changes. Anyone else opening this repository sees the same
                  application - it is initialized once, for everyone, in Git.
                </Typography.Paragraph>
              </div>
            }
            extra={
              <Button type="primary" size="large" icon={<CloudUploadOutlined />} onClick={() => init.mutate()}>
                Initialize application
              </Button>
            }
          />
        ))}

      {/* The nav is hidden once initialization is under way, so the progress
          view owns the screen. */}
      {!(step === 3 && (init.isPending || init.isSuccess)) && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>
          <Button onClick={() => (step === 0 ? setSection("workspace") : setStep(step - 1))}>
            {step === 0 ? "Cancel" : "Back"}
          </Button>
          {step < 3 && (
            <Button type="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
              Next
            </Button>
          )}
        </div>
      )}

      <Typography.Text type="secondary" style={{ display: "block", marginTop: 16, fontSize: 12 }}>
        {chosenParams.length} settings selected across {insts.length} instances
        {d.sharedFiles?.length ? ` · ${d.sharedFiles.length} shared file(s)` : ""}
      </Typography.Text>
    </div>
  );
}
