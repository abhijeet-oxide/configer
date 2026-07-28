import {
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
  Table,
  Tag,
  Tooltip,
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
} from "../icons";
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { api, bindingsOf, type Binding, type Instance, type Parameter, type SkippedFile } from "../api";
import { groupSkipped, manageWarning, originSentence, SKIP_EXPLANATIONS, SKIP_REASONS } from "../skipped";
import { ENV_PRESETS } from "../theme";
import { useUI } from "../store";
import { InlineNotice, Stepper } from "./ui";
import FileExplorer from "./FileExplorer";
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

// Pretty binding: the file (instance templates shown without the {folder}/
// prefix, tagged "per instance"), its line, and its in-file path.
function prettyBinding(b: Binding): { file: string; perInstance: boolean } {
  if (b.file.startsWith(INST_TOKEN)) return { file: b.file.slice(INST_TOKEN.length), perInstance: true };
  return { file: b.file, perInstance: false };
}

// DiscoverySummary is the onboarding "aha": the three numbers that turn a
// messy repository into structured configuration, shown big and up front.
function DiscoverySummary({
  parameters,
  instances,
  formats,
}: {
  parameters: number;
  instances: number;
  formats: string[];
}) {
  const stats = [
    { n: parameters, label: parameters === 1 ? "parameter" : "parameters" },
    { n: instances, label: instances === 1 ? "instance" : "instances" },
    { n: formats.length, label: formats.length === 1 ? "format" : "formats", hint: formats.map((f) => f.toUpperCase()).join(" · ") },
  ];
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-card-lg border border-brand-border bg-brand-soft px-5 py-4">
      <div className="min-w-40">
        <div className="text-[13px] font-semibold text-ink">Configuration discovered</div>
        <div className="text-[12px] text-ink-2">Your existing files, now one structured surface.</div>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        {stats.map((s) => (
          <div key={s.label}>
            <div className="text-2xl font-semibold leading-none text-ink" style={{ fontVariantNumeric: "tabular-nums" }}>
              {s.n}
            </div>
            <div className="mt-1 text-[11px] text-ink-3">
              {s.label}
              {s.hint ? <span className="ml-1 text-ink-2">{s.hint}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// A discovered value rendered compactly for the per-instance preview columns.
// Lists join with commas; objects collapse to JSON; anything long rides in a
// tooltip so the row stays single-line.
function fmtObserved(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => fmtObserved(x)).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function ObservedCell({ p, inst }: { p: Parameter; inst: Instance }) {
  const raw = p.observed?.[inst.name];
  // Global parameters live in a shared file: every instance reads the same
  // value, so fall back to the discovered default for the preview.
  const value = raw !== undefined ? raw : p.scope === "global" ? p.default : undefined;
  const inherited = raw === undefined && value !== undefined;
  if (value === undefined) {
    return <span style={{ color: "var(--text-3)" }}>-</span>;
  }
  const text = fmtObserved(value);
  return (
    <Tooltip title={text.length > 24 ? text : undefined}>
      <span
        className="mono"
        style={{
          fontSize: 12,
          color: inherited ? "var(--text-3)" : "var(--text)",
          fontStyle: inherited ? "italic" : undefined,
          display: "inline-block",
          maxWidth: 140,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          verticalAlign: "bottom",
        }}
        title={inherited ? "Inherited from the shared/base file" : undefined}
      >
        {text}
      </span>
    </Tooltip>
  );
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

// SkippedFiles names the files the scan passed over, what produced each one,
// and offers to manage it anyway.
//
// The default - leave generated files alone - is right for most repositories
// and wrong for some, and the person looking at their own repository is better
// placed to judge than a rule is. So this states the case plainly, including
// what will overwrite their edit, and then lets them decide. Everything
// specific to a tool comes from the server; adding another generator never
// touches this component.
function SkippedFiles({
  skipped,
  managed,
  onManage,
  onStopManaging,
  busy,
}: {
  skipped: SkippedFile[];
  managed: SkippedFile[];
  onManage: (f: SkippedFile) => void;
  onStopManaging: (file: string) => void;
  busy: boolean;
}) {
  if (skipped.length === 0 && managed.length === 0) return null;
  return (
    <div className="rounded-card-lg bg-surface-2 px-4 py-3">
      {managed.length > 0 && (
        <div style={{ marginBottom: skipped.length ? 14 : 0 }}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            {managed.length} file{managed.length === 1 ? "" : "s"} you chose to manage anyway
          </Typography.Text>
          <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
            {managed.map((f) => (
              <li key={f.file} style={{ fontSize: 11, marginBottom: 6 }}>
                <span className="mono" style={{ color: "var(--text-2)" }}>{f.file}</span>{" "}
                <Button type="link" size="small" style={{ paddingInline: 4, fontSize: 11 }}
                  onClick={() => onStopManaging(f.file)} disabled={busy}>
                  leave it alone
                </Button>
                {/* The caution stays with the file for as long as it is
                    managed. It is not a scolding - the user made an informed
                    choice - it is the one fact that choice depends on. */}
                {f.reason === "generated" && (
                  <div style={{ color: "var(--c-pending)", marginTop: 2, maxWidth: 620 }}>
                    {manageWarning(f.origin)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {skipped.length > 0 && (
        <Typography.Text strong style={{ fontSize: 13 }}>
          {skipped.length} file{skipped.length === 1 ? "" : "s"} passed over
        </Typography.Text>
      )}
      {groupSkipped(skipped).map((g) => (
        <div key={g.reason} style={{ marginTop: 10 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {g.files.length} because {SKIP_REASONS[g.reason]}. {SKIP_EXPLANATIONS[g.reason]}
          </Typography.Text>
          <ul style={{ margin: "8px 0 0", paddingInlineStart: 18 }}>
            {g.files.map((f) => (
              <li key={f.file} style={{ marginBottom: 8 }}>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-2)" }}>{f.file}</div>
                {f.origin && (
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2, maxWidth: 620 }}>
                    {originSentence(f.origin)}
                    {f.origin.docs && (
                      <>
                        {" "}
                        <Typography.Link href={f.origin.docs} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
                          Their guidance
                        </Typography.Link>
                      </>
                    )}
                  </div>
                )}
                <Button type="link" size="small" style={{ paddingInline: 0, fontSize: 11 }}
                  onClick={() => onManage(f)} disabled={busy}>
                  Manage it anyway
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
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

  // Files the user chose to manage despite the scan passing them over. They are
  // part of the query key, so choosing one re-proposes with it included rather
  // than patching the result client-side - the server decides what a file
  // yields, here as everywhere.
  // The whole SkippedFile is kept, not just the path: once a file is being
  // managed the server stops reporting it as passed over, and with it would go
  // the one thing the user needs to keep seeing - what will overwrite their
  // edits.
  const [managed, setManaged] = useState<SkippedFile[]>([]);
  const managedFiles = useMemo(() => managed.map((m) => m.file), [managed]);
  const discoverQ = useRepoQuery({
    queryKey: ["discover", ...managedFiles],
    queryFn: () => api.discover(managedFiles),
    staleTime: 60_000,
  });
  const d = discoverQ.data;
  // A list is read as a list wherever it comes from. A scan that found nothing
  // is an ordinary answer - plenty of repositories hold manifests with no
  // configuration to manage - and it must not be able to take the page down.
  const found = useMemo(() => d?.parameters ?? [], [d]);
  const skipped = useMemo(() => d?.skipped ?? [], [d]);

  const insts = useMemo(() => instances ?? d?.instances ?? [], [instances, d]);
  // Distinct configuration formats found across every discovered parameter -
  // the "3 formats" part of the discovery summary.
  const discoveredFormats = useMemo(() => {
    const s = new Set<string>();
    for (const p of found) for (const b of bindingsOf(p)) if (b.format) s.add(b.format);
    return [...s].sort();
  }, [found]);
  const patchInstance = (name: string, patch: Partial<Instance>) =>
    setInstances(insts.map((i) => (i.name === name ? { ...i, ...patch } : i)));

  // Map every parameter to the real files it touches, and the full file set.
  const filesByParam = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of found) m.set(p.id, filesOfParam(p, insts));
    return m;
  }, [found, insts]);
  const allFiles = useMemo(() => {
    const s = new Set<string>();
    for (const files of filesByParam.values()) for (const f of files) s.add(f);
    return [...s].sort();
  }, [filesByParam]);

  // The explorer works with the checked set directly; uncheckedFiles stays
  // the source of truth so a rescan that finds new files keeps them selected.
  const checkedFiles = useMemo(
    () => new Set(allFiles.filter((f) => !uncheckedFiles.has(f))),
    [allFiles, uncheckedFiles],
  );

  // A parameter survives if at least one of its files is still selected.
  const includedByFiles = (p: Parameter): boolean => {
    const files = filesByParam.get(p.id) ?? [];
    if (files.length === 0) return true; // design-phase params have no file
    return files.some((f) => !uncheckedFiles.has(f));
  };
  const fileIncludedParams = useMemo(
    () => found.filter(includedByFiles),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [found, uncheckedFiles, filesByParam],
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
        author: "Local user",
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

  // The scan ran and turned up nothing to manage. That is an answer, not a
  // failure: a repository can hold plenty of YAML - Flux or Argo manifests,
  // rendered output, CRDs - without holding SETTINGS that belong in a grid.
  // Walking someone through four steps over zeros, with Next disabled and no
  // reason given, tells them none of that.
  if (found.length === 0) {
    return (
      <div style={{ paddingTop: 40 }}>
        <StatePanel
          art={<ScanArt />}
          title="Nothing to manage in this repository yet"
          subtitle={
            skipped.length > 0
              ? "Configer read the files and found no settings it can put in a grid. Every configuration file it saw was passed over, for the reasons below - and you can overrule that for any of them."
              : "Configer read the files and found no settings it can put in a grid. It looks for configuration values in YAML, JSON or XML - usually one folder per environment or cluster."
          }
          actions={
            <>
              <Button type="primary" onClick={() => discoverQ.refetch()}>
                Scan again
              </Button>
              <Button onClick={() => setSection("files")}>Browse the files</Button>
              <Button onClick={() => setSection("workspace")}>Back to Applications</Button>
            </>
          }
        />
        {/* The reason IS the answer here: without it the page says "nothing
            found" about a repository the user knows has files in it. */}
        <div style={{ maxWidth: 720, margin: "8px auto 0" }}>
          <SkippedFiles
            skipped={skipped}
            managed={managed}
            onManage={(f) => setManaged((m) => [...m, f])}
            onStopManaging={(f) => setManaged((m) => m.filter((x) => x.file !== f))}
            busy={discoverQ.isFetching}
          />
        </div>
      </div>
    );
  }

  const steps = [
    { label: "Layout", icon: <FileSearchOutlined /> },
    { label: "Instances", icon: <ApartmentOutlined /> },
    { label: "Parameters", icon: <TableOutlined /> },
    { label: "Initialize", icon: <CheckCircleOutlined /> },
  ];

  const canNext =
    step === 0
      ? appName.trim() !== "" && insts.length > 0
      : step === 2
        ? chosenParams.length > 0
        : true;
  // A disabled button with no reason is a dead end. Say which of its conditions
  // is not met, in the words of the step the user is looking at.
  const blockedBecause =
    canNext
      ? ""
      : step === 0
        ? appName.trim() === ""
          ? "Give the application a name to continue."
          : "No instance folders were found, so there is nothing to lay out as columns yet. Configer expects one folder per environment or cluster."
        : step === 2
          ? "Select at least one setting to manage."
          : "";

  // --- tree interactions ---
  const treeNeedle = treeQ.trim().toLowerCase();
  const shownFiles = treeNeedle ? allFiles.filter((f) => f.toLowerCase().includes(treeNeedle)) : allFiles;
  const setAllFiles = (checked: boolean) => setUncheckedFiles(checked ? new Set() : new Set(allFiles));

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

      {/* The "aha": what the scan turned this repository into, stated once and
          up front - messy files become structured, countable configuration. */}
      <DiscoverySummary
        parameters={found.length}
        instances={insts.length}
        formats={discoveredFormats}
      />

      <div className="mb-5 rounded-card-lg bg-surface px-5 py-4 shadow-neu">
        <Stepper current={step} steps={steps} />
      </div>

      {step === 0 && (
        <>
          <InlineNotice className="mb-4">
            Detected layout: <b>{layoutLabels[d.detection.layout] ?? d.detection.layout}</b>
            {d.detection.note ? ` - ${d.detection.note}` : ""}
          </InlineNotice>
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
            <InlineNotice tone="warn">
              No instances were found. Configer looks for one folder per instance (instances/,
              environments/, overlays/, kpt packages) - add such a structure, or connect a different
              branch.
            </InlineNotice>
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
          <InlineNotice tone="neutral" className="mt-3">
            You can create, clone or retire instances any time from the Instances tab - no need to
            get them all here.
          </InlineNotice>
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
                  Files ({checkedFiles.size}/{allFiles.length})
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
                  <FileExplorer
                    files={shownFiles}
                    checked={checkedFiles}
                    onCheck={(next) => {
                      // Only the visible files were toggleable; carry the
                      // hidden ones' state over unchanged.
                      setUncheckedFiles(new Set(allFiles.filter((f) => !next.has(f))));
                    }}
                  />
                )}
              </div>
              <div style={{ padding: "6px 10px", borderTop: "1px solid rgba(127,137,160,0.18)", fontSize: 12, opacity: 0.7 }}>
                {checkedFiles.size} of {allFiles.length} files kept
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
            scroll={{ x: "max-content" }}
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
              // One column per instance, previewing the value Configer read
              // from that instance's real files - the grid, before it exists.
              ...insts.map((inst) => ({
                title: (
                  <Tooltip title={folderOf(inst)}>
                    <span style={{ whiteSpace: "nowrap" }}>{inst.name}</span>
                  </Tooltip>
                ),
                key: `inst-${inst.name}`,
                width: 150,
                render: (_v: unknown, p: Parameter) => <ObservedCell p={p} inst={inst} />,
              })),
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
          {step < 3 &&
            (blockedBecause ? (
              <Tooltip title={blockedBecause}>
                <span style={{ display: "inline-flex" }}>
                  <Button type="primary" disabled>
                    Next
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button type="primary" onClick={() => setStep(step + 1)}>
                Next
              </Button>
            ))}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <SkippedFiles
          skipped={skipped}
          managed={managed}
          onManage={(f) => setManaged((m) => [...m, f])}
          onStopManaging={(f) => setManaged((m) => m.filter((x) => x.file !== f))}
          busy={discoverQ.isFetching}
        />
      </div>

      <Typography.Text type="secondary" style={{ display: "block", marginTop: 16, fontSize: 12 }}>
        {chosenParams.length} settings selected across {insts.length} instances
        {d.sharedFiles?.length ? ` · ${d.sharedFiles.length} shared file(s)` : ""}
      </Typography.Text>
    </div>
  );
}
