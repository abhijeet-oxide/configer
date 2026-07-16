import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Result,
  Select,
  Space,
  Statistic,
  Steps,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
} from "antd";
import {
  FileSearchOutlined,
  CheckSquareOutlined,
  RocketOutlined,
  ReloadOutlined,
  SearchOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  LockOutlined,
  ApiOutlined,
  GithubOutlined,
  HddOutlined,
  BranchesOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bindingsOf, expandBinding, type Grid, type Parameter, type ScanCandidate, type ScanResult } from "../api";
import { fmtValue } from "../rules";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import NewApplicationWizard from "./NewApplicationWizard";

// ImportWizard turns a repository scan into managed catalog parameters in
// three clear steps: scan the files, choose and enrich the parameters, then
// review and initialize. Nothing is written to Git until the final confirm,
// and the wizard says so at every step; scanning is always safe.

const paramTypes = ["string", "integer", "number", "boolean", "enum", "ipv4", "cidr", "list"];
const itemTypes = ["string", "integer", "number", "ipv4", "cidr"];
const scopeOptions = [
  { value: "instance", label: "instance (each system has its own value)" },
  { value: "zone", label: "zone" },
  { value: "site", label: "site" },
  { value: "environment", label: "environment (shared per environment)" },
  { value: "global", label: "global (one value everywhere)" },
];

// One editable row of the wizard: a scanned candidate plus the metadata the
// user is enriching it with before it becomes a catalog parameter.
interface Draft {
  key: string; // file|path, unique per candidate
  cand: ScanCandidate;
  category: string;
  type: string;
  itemType?: string;
  scope: string;
  secret: boolean;
}

// defaultCategory proposes a category from the dotted name, so users start
// from something sensible instead of a blank ("network.ntp.servers" -> "Network").
function defaultCategory(name: string): string {
  const seg = name.split(".")[0]?.replace(/[_-]/g, " ").trim();
  if (!seg || seg === name) return "General";
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

// looksSecret flags names that usually hold credentials so the wizard
// suggests masking them, one less thing to forget.
function looksSecret(name: string): boolean {
  return /pass(word)?|secret|token|api[._-]?key|credential|private[._-]?key/i.test(name);
}

const candKey = (c: ScanCandidate) => `${c.file}|${c.path}`;

// Parsers flatten lists into indexed entries (servers[0], servers[1], ...).
// foldFile collapses each such family into one list candidate, so users see
// "ntp.servers" once with all its values instead of a row per element, and a
// family whose list is already managed is recognized as managed.
const IDX_RE = /\[\d+\]$/;

interface FoldedCand {
  cand: ScanCandidate;
  /** element type of a folded list, used to seed itemType */
  elemType?: string;
}

function foldFile(cands: ScanCandidate[]): FoldedCand[] {
  const out: FoldedCand[] = [];
  const families = new Map<string, ScanCandidate[]>();
  for (const c of cands) {
    if (IDX_RE.test(c.path)) {
      const base = c.path.replace(IDX_RE, "");
      const fam = families.get(base) ?? [];
      fam.push(c);
      families.set(base, fam);
    } else {
      out.push({ cand: c });
    }
  }
  for (const [base, fam] of families) {
    const first = fam[0];
    out.push({
      cand: {
        name: first.name.replace(IDX_RE, ""),
        path: base,
        type: "list",
        value: fam.map((c) => c.value),
        file: first.file,
        format: first.format,
      },
      elemType: itemTypes.includes(first.type) ? first.type : "string",
    });
  }
  return out;
}

// Switching repositories inside the wizard clears the query cache, which
// remounts the wizard; this one-shot flag carries "land on the scan step"
// across that remount. It is also how creating an application from the
// Applications page hands straight into the scan step of this wizard.
export const STEP_HANDOFF = "configer.importStep";

export default function ImportWizard({ grid }: { grid: Grid }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { importFocus, setImportFocus, setSection } = useUI();
  const [step, setStep] = useState(() =>
    sessionStorage.getItem(STEP_HANDOFF) ? 1 : 0,
  );
  // A handoff from "Create application" (or a repo switch inside the wizard)
  // lands on the scan step; when it does, kick the scan off immediately so the
  // repository is parsed automatically instead of waiting on another click.
  const handoffScan = useRef(sessionStorage.getItem(STEP_HANDOFF) !== null);
  useEffect(() => {
    sessionStorage.removeItem(STEP_HANDOFF);
  }, []);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [persistIgnore, setPersistIgnore] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [doneInfo, setDoneInfo] = useState<{ imported: number; skipped: string[]; ignored: number } | null>(null);
  // Focus handed over by the Repository Changes inbox is consumed
  // synchronously into a ref so double-invoked dev effects and repeated scan
  // callbacks all see the same value.
  const focusRef = useRef<string | null>(null);
  const autoScanStarted = useRef(false);
  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus, staleTime: 60_000 });

  // Parameters already in the catalog are recognized by (file, path) so the
  // wizard never proposes importing something twice.
  const managed = useMemo(() => {
    const s = new Set<string>();
    for (const r of grid.rows) {
      for (const b of bindingsOf(r.param)) {
        s.add(`${b.file}|${b.path}`);
        // Templated bindings cover one concrete file per instance.
        for (const inst of grid.instances) s.add(`${expandBinding(b, inst)}|${b.path}`);
      }
    }
    return s;
  }, [grid.rows, grid.instances]);

  const existingCategories = useMemo(
    () => [...new Set(grid.rows.map((r) => r.param.category))].sort(),
    [grid.rows],
  );

  const doScan = useMutation({
    mutationFn: api.scan,
    onSuccess: (res) => {
      setScan(res);
      const inc: Record<string, boolean> = {};
      const d: Record<string, Draft> = {};
      const focus = focusRef.current;
      for (const f of res.files ?? []) {
        const fresh = foldFile(f.candidates ?? []).filter((x) => !managed.has(candKey(x.cand)));
        // With a focus (arriving from the Repository Changes inbox) start
        // with only the file/folder in question checked; otherwise check
        // every file that still has something new to offer.
        inc[f.file] = focus ? f.file === focus || f.file.startsWith(focus) : fresh.length > 0;
        // Seed one editable draft per not-yet-managed candidate.
        for (const x of fresh) {
          const key = candKey(x.cand);
          d[key] = {
            key,
            cand: x.cand,
            category: defaultCategory(x.cand.name),
            type: x.cand.type || "string",
            itemType: x.cand.type === "list" ? x.elemType || "string" : undefined,
            scope: "instance",
            secret: looksSecret(x.cand.name),
          };
        }
      }
      setIncluded(inc);
      setDrafts(d);
      setSelectedKeys(Object.keys(d).filter((k) => (focus ? k.startsWith(focus) : true)));
    },
    onError: (e: Error) => message.error(`Scan failed: ${e.message}`),
  });

  // Jumping in from the Repository Changes inbox starts the scan immediately
  // (the repository is already the active one, so the connect step is skipped).
  useEffect(() => {
    if (!importFocus) return;
    focusRef.current = importFocus;
    setImportFocus(null);
    if (!autoScanStarted.current) {
      autoScanStarted.current = true;
      setStep(1);
      doScan.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importFocus]);

  // Arriving on the scan step via a create/switch handoff: scan once, right
  // away, so a new application is parsed the moment the user reaches this step.
  useEffect(() => {
    if (!handoffScan.current || autoScanStarted.current) return;
    autoScanStarted.current = true;
    doScan.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-file counts after list folding: how many settings are news vs
  // already in the catalog.
  const counts = useMemo(() => {
    const r: Record<string, { fresh: number; already: number }> = {};
    for (const f of scan?.files ?? []) {
      const folded = foldFile(f.candidates ?? []);
      const fresh = folded.filter((x) => !managed.has(candKey(x.cand))).length;
      r[f.file] = { fresh, already: folded.length - fresh };
    }
    return r;
  }, [scan, managed]);

  // Candidates that survive both the file include toggles and the selection.
  const eligibleDrafts = useMemo(
    () => Object.values(drafts).filter((d) => included[d.cand.file]),
    [drafts, included],
  );
  const chosen = useMemo(
    () => eligibleDrafts.filter((d) => selectedKeys.includes(d.key)),
    [eligibleDrafts, selectedKeys],
  );
  const ignoredFiles = useMemo(
    () =>
      persistIgnore
        ? (scan?.files ?? []).filter((f) => included[f.file] === false).map((f) => f.file)
        : [],
    [persistIgnore, scan, included],
  );

  const doImport = useMutation({
    mutationFn: () => {
      const parameters: Partial<Parameter>[] = chosen.map((d) => ({
        name: d.cand.name,
        category: d.category || "General",
        type: d.type,
        itemType: d.type === "list" ? d.itemType || "string" : undefined,
        scope: d.scope as Parameter["scope"],
        secret: d.secret,
        // the scanned value becomes the catalog default; per-instance values
        // are edited afterwards in the Config Editor
        default: d.cand.value,
        // The backend template-izes files inside instance folders into
        // {folder}/… bindings and merges duplicates.
        bindings: [{ file: d.cand.file, path: d.cand.path, format: d.cand.format }],
      }));
      return api.importParameters({ parameters, ignoreFiles: ignoredFiles, author: "demo-user" });
    },
    onSuccess: (res) => {
      setDoneInfo({ imported: res.imported, skipped: res.skipped ?? [], ignored: ignoredFiles.length });
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const patchDraft = (key: string, p: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [key]: { ...d[key], ...p } }));
  const patchSelected = (p: Partial<Draft>) =>
    setDrafts((d) => {
      const next = { ...d };
      for (const k of selectedKeys) if (next[k]) next[k] = { ...next[k], ...p };
      return next;
    });

  const reset = () => {
    setStep(0);
    setScan(null);
    setDrafts({});
    setSelectedKeys([]);
    setDoneInfo(null);
    setPersistIgnore(false);
    setFilter("");
  };

  // ---- success screen -------------------------------------------------------
  if (doneInfo) {
    return (
      <div style={{ height: "100%", overflow: "auto", padding: 24 }}>
        <Result
          status="success"
          title={`${doneInfo.imported} parameter(s) are now managed by Configer`}
          subTitle={
            <>
              They were added to the catalog with one commit on Git, values still come from your
              existing files.
              {doneInfo.ignored > 0 && ` ${doneInfo.ignored} file(s) were added to the ignore rules.`}
            </>
          }
          extra={[
            <Button key="editor" type="primary" onClick={() => setSection("config")}>
              Open the editor
            </Button>,
            <Button key="again" onClick={reset}>
              Import more
            </Button>,
          ]}
        >
          {doneInfo.skipped.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`${doneInfo.skipped.length} entr(ies) could not be imported`}
              description={doneInfo.skipped.join(", ")}
            />
          )}
        </Result>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "16px 24px" }}>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 24, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 380px" }}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              Import settings
            </Typography.Title>
            <Typography.Text type="secondary">
              Bring settings from your repository files under management. Scanning only reads files;
              nothing is written to Git until you confirm at the end.
            </Typography.Text>
          </div>
          <Steps
            size="small"
            current={step}
            items={[
              { title: "Connect repository", icon: <ApiOutlined /> },
              { title: "Scan repository", icon: <FileSearchOutlined /> },
              { title: "Choose parameters", icon: <CheckSquareOutlined /> },
              { title: "Review & initialize", icon: <RocketOutlined /> },
            ]}
            style={{ flex: "1 1 520px", marginTop: 4 }}
          />
        </div>
        {step === 0 && <ConnectStep onNext={() => setStep(1)} />}
        {step === 1 && (
          <ScanStep
            scan={scan}
            scanning={doScan.isPending}
            onScan={() => doScan.mutate()}
            included={included}
            setIncluded={setIncluded}
            persistIgnore={persistIgnore}
            setPersistIgnore={setPersistIgnore}
            counts={counts}
            eligibleNew={eligibleDrafts.length}
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <ChooseStep
            drafts={eligibleDrafts}
            selectedKeys={selectedKeys}
            setSelectedKeys={setSelectedKeys}
            patchDraft={patchDraft}
            patchSelected={patchSelected}
            categories={existingCategories}
            filter={filter}
            setFilter={setFilter}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
            chosenCount={chosen.length}
          />
        )}
        {step === 3 && (
          <ReviewStep
            chosen={chosen}
            ignoredFiles={ignoredFiles}
            branch={statusQ.data?.branch}
            importing={doImport.isPending}
            onBack={() => setStep(2)}
            onImport={() => doImport.mutate()}
          />
        )}
      </Space>
    </div>
  );
}

// ---- step 0: connect / choose the repository ----------------------------------

function ConnectStep({ onNext }: { onNext: () => void }) {
  const { repoId } = useUI();
  const switchRepo = useSwitchRepo();
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 15_000 });
  const repos = wsQ.data?.repos ?? [];
  const [choice, setChoice] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const selectedId = choice ?? repoId ?? repos[0]?.id ?? null;
  const selected = repos.find((r) => r.id === selectedId);

  const proceed = () => {
    if (selectedId && selectedId !== repoId) {
      // The cache clear remounts the wizard; land on the scan step after it.
      sessionStorage.setItem(STEP_HANDOFF, "1");
      switchRepo(selectedId);
    } else {
      onNext();
    }
  };

  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "stretch" }}>
      <Card title="Import into a connected repository" style={{ flex: "1 1 380px", minWidth: 340 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
          Configurations live in Git repositories managed on the server. Pick the one to import
          settings into.
        </Typography.Paragraph>
        <Select
          style={{ width: "100%" }}
          value={selectedId ?? undefined}
          placeholder="Choose a repository"
          onChange={(v) => setChoice(v)}
          options={repos.map((r) => ({
            value: r.id,
            label: (
              <Space size={6}>
                {r.local ? <HddOutlined /> : <GithubOutlined />}
                {r.name}
                {r.project && r.project !== r.name && (
                  <span style={{ opacity: 0.55, fontSize: 12 }}>{r.project}</span>
                )}
              </Space>
            ),
          }))}
        />
        {selected && (
          <div style={{ marginTop: 12 }}>
            <Space size={4} wrap>
              {selected.branch && (
                <Tag icon={<BranchesOutlined />} className="mono" style={{ fontSize: 11 }}>
                  {selected.branch}
                </Tag>
              )}
              <Tag>{selected.params} parameters managed</Tag>
              <Tag>{selected.instances} instances</Tag>
              {selected.id === repoId && <Tag color="blue">currently open</Tag>}
            </Space>
            <div className="mono" style={{ fontSize: 11, opacity: 0.55, marginTop: 6, overflowWrap: "anywhere" }}>
              {selected.origin}
            </div>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <Button type="primary" disabled={!selectedId} onClick={proceed}>
            Continue: scan this repository <ArrowRightOutlined />
          </Button>
        </div>
      </Card>
      {/* Creating an application has ONE flow: the guided wizard. This card
          just opens it; on creation we flow straight into the scan step. */}
      <Card
        hoverable
        onClick={() => setWizardOpen(true)}
        style={{ flex: "1 1 380px", minWidth: 340, borderStyle: "dashed" }}
        styles={{
          body: {
            height: "100%", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", textAlign: "center", gap: 6,
          },
        }}
      >
        <PlusOutlined style={{ fontSize: 26, opacity: 0.5 }} />
        <div style={{ fontWeight: 500 }}>New application</div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Pick a GitHub repository and go; it is scanned right here afterwards.
        </Typography.Text>
      </Card>
      <NewApplicationWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={(r) => {
          setWizardOpen(false);
          sessionStorage.setItem(STEP_HANDOFF, "1");
          switchRepo(r.id);
        }}
      />
    </div>
  );
}

// ---- step 1: scan -----------------------------------------------------------

function ScanStep({
  scan,
  scanning,
  onScan,
  included,
  setIncluded,
  persistIgnore,
  setPersistIgnore,
  counts,
  eligibleNew,
  onBack,
  onNext,
}: {
  scan: ScanResult | null;
  scanning: boolean;
  onScan: () => void;
  included: Record<string, boolean>;
  setIncluded: (v: Record<string, boolean>) => void;
  persistIgnore: boolean;
  setPersistIgnore: (v: boolean) => void;
  counts: Record<string, { fresh: number; already: number }>;
  eligibleNew: number;
  onBack: () => void;
  onNext: () => void;
}) {
  if (!scan) {
    // Pre-scan: a full-width hero with the action, and the three promises of
    // the import spelled out underneath; no dead space, nothing to fear.
    const promises: { icon: React.ReactNode; title: string; text: string }[] = [
      {
        icon: <FileSearchOutlined />,
        title: "Scanning is read-only",
        text: "Configer reads the current branch and detects YAML, JSON and XML configuration files. Nothing is written, nothing is sent anywhere.",
      },
      {
        icon: <CheckSquareOutlined />,
        title: "You choose what to manage",
        text: "Every detected setting is a suggestion. Untick whole files or single settings; everything you skip stays exactly as it is.",
      },
      {
        icon: <RocketOutlined />,
        title: "One commit at the end",
        text: "Only the final confirm writes: one reviewable commit adds the chosen parameters to the catalog. Your files keep their values.",
      },
    ];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
            <FileSearchOutlined style={{ fontSize: 44, opacity: 0.5 }} />
            <div style={{ flex: "1 1 360px", minWidth: 0 }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                Find configuration in your repository
              </Typography.Title>
              <Typography.Text type="secondary">
                Configer detects the settings living in your files and offers them for management;
                you stay in control of every single one.
              </Typography.Text>
            </div>
            <Space>
              <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
                Repository
              </Button>
              <Button type="primary" size="large" icon={<FileSearchOutlined />} loading={scanning} onClick={onScan}>
                Scan repository
              </Button>
            </Space>
          </div>
        </Card>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
          {promises.map((p) => (
            <Card key={p.title} size="small">
              <Space align="start" size={12}>
                <span style={{ fontSize: 22, color: "var(--c-review)" }}>{p.icon}</span>
                <div>
                  <Typography.Text strong>{p.title}</Typography.Text>
                  <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0", fontSize: 13 }}>
                    {p.text}
                  </Typography.Paragraph>
                </div>
              </Space>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const files = scan.files ?? [];
  const totalNew = files.reduce((n, f) => n + (counts[f.file]?.fresh ?? 0), 0);
  const totalManaged = files.reduce((n, f) => n + (counts[f.file]?.already ?? 0), 0);
  const anyUnchecked = files.some((f) => included[f.file] === false);

  if (files.length === 0) {
    return (
      <Card>
        <Empty description="No configuration files were found on this branch." />
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <Button icon={<ReloadOutlined />} loading={scanning} onClick={onScan}>
            Scan again
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="What the scan found"
      extra={
        <Button size="small" icon={<ReloadOutlined />} loading={scanning} onClick={onScan}>
          Rescan
        </Button>
      }
    >
      <Space size={28} wrap style={{ marginBottom: 14 }}>
        <Statistic title="Config files" value={files.length} />
        <Statistic title="New settings found" value={totalNew} valueStyle={{ color: totalNew ? "#1baf7a" : undefined }} />
        <Statistic title="Already managed" value={totalManaged} />
        {(scan.skipped?.length ?? 0) > 0 && (
          <Tooltip title={scan.skipped!.join(", ")}>
            <Statistic title="Skipped by ignore rules" value={scan.skipped!.length} />
          </Tooltip>
        )}
      </Space>
      {totalNew === 0 ? (
        <Alert
          type="success"
          showIcon
          message="Everything the scan found is already managed."
          description="New files committed to Git later will show up in Repository changes, and you can rescan here any time."
        />
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            Untick any file you don't want to import from.
          </Typography.Paragraph>
          <Table
            size="small"
            rowKey="file"
            dataSource={files}
            pagination={false}
            columns={[
              {
                title: "",
                width: 40,
                render: (_, f) => (
                  <Checkbox
                    checked={included[f.file] !== false}
                    disabled={(counts[f.file]?.fresh ?? 0) === 0}
                    onChange={(e) => setIncluded({ ...included, [f.file]: e.target.checked })}
                  />
                ),
              },
              { title: "File", dataIndex: "file", render: (v: string) => <span className="mono">{v}</span> },
              { title: "Format", dataIndex: "format", width: 90, render: (v?: string) => (v ? <Tag>{v}</Tag> : null) },
              {
                title: "New settings",
                width: 120,
                align: "right" as const,
                render: (_, f) => {
                  const n = counts[f.file]?.fresh ?? 0;
                  return n > 0 ? <b style={{ color: "#1baf7a" }}>{n}</b> : <span style={{ opacity: 0.45 }}>0</span>;
                },
              },
              {
                title: "Already managed",
                width: 140,
                align: "right" as const,
                render: (_, f) => {
                  const n = counts[f.file]?.already ?? 0;
                  return n > 0 ? n : <span style={{ opacity: 0.45 }}>0</span>;
                },
              },
              {
                title: "",
                width: 160,
                render: (_, f) =>
                  f.error ? (
                    <Tooltip title={f.error}>
                      <Tag color="warning">could not be read fully</Tag>
                    </Tooltip>
                  ) : null,
              },
            ]}
          />
          {anyUnchecked && (
            <Checkbox
              style={{ marginTop: 12 }}
              checked={persistIgnore}
              onChange={(e) => setPersistIgnore(e.target.checked)}
            >
              Remember the unticked files as ignore rules, so future scans skip them
            </Checkbox>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
            <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
              Repository
            </Button>
            <Button type="primary" disabled={eligibleNew === 0} onClick={onNext}>
              Continue: choose parameters <ArrowRightOutlined />
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

// ---- step 2: choose & enrich --------------------------------------------------

function ChooseStep({
  drafts,
  selectedKeys,
  setSelectedKeys,
  patchDraft,
  patchSelected,
  categories,
  filter,
  setFilter,
  onBack,
  onNext,
  chosenCount,
}: {
  drafts: Draft[];
  selectedKeys: string[];
  setSelectedKeys: (k: string[]) => void;
  patchDraft: (key: string, p: Partial<Draft>) => void;
  patchSelected: (p: Partial<Draft>) => void;
  categories: string[];
  filter: string;
  setFilter: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
  chosenCount: number;
}) {
  const allCategories = useMemo(
    () => [...new Set([...categories, ...drafts.map((d) => d.category)])].sort(),
    [categories, drafts],
  );
  const q = filter.trim().toLowerCase();
  const visible = q
    ? drafts.filter(
        (d) =>
          d.cand.name.toLowerCase().includes(q) ||
          d.cand.file.toLowerCase().includes(q) ||
          fmtValue(d.cand.value).toLowerCase().includes(q),
      )
    : drafts;
  const multiFile = new Set(drafts.map((d) => d.cand.file)).size > 1;
  const selCount = selectedKeys.filter((k) => drafts.some((d) => d.key === k)).length;

  return (
    <Card
      title={`Choose what to manage (${chosenCount} of ${drafts.length} selected)`}
      extra={
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Filter by name, value or file"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 240 }}
        />
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
        Each setting gets a category, a data type and a scope. Sensible suggestions are prefilled;
        adjust anything inline, or select several rows and use the bulk controls below.
      </Typography.Paragraph>
      {selCount > 1 && (
        <Space wrap size={8} style={{ marginBottom: 10, padding: "8px 10px", background: "rgba(42,120,214,0.07)", borderRadius: 8 }}>
          <Typography.Text strong style={{ fontSize: 12 }}>
            Apply to {selCount} selected:
          </Typography.Text>
          <AutoComplete
            size="small"
            style={{ width: 170 }}
            placeholder="Set category"
            options={allCategories.map((c) => ({ value: c }))}
            onChange={(v: string) => v && patchSelected({ category: v })}
          />
          <Select
            size="small"
            style={{ width: 150 }}
            placeholder="Set scope"
            options={scopeOptions.map((s) => ({ value: s.value, label: s.value }))}
            onChange={(v: string) => patchSelected({ scope: v })}
          />
          <Select
            size="small"
            style={{ width: 120 }}
            placeholder="Set type"
            options={paramTypes.map((t) => ({ value: t, label: t }))}
            onChange={(v: string) => patchSelected({ type: v, itemType: v === "list" ? "string" : undefined })}
          />
          <Button size="small" icon={<LockOutlined />} onClick={() => patchSelected({ secret: true })}>
            Mark secret
          </Button>
          <Button size="small" onClick={() => patchSelected({ secret: false })}>
            Not secret
          </Button>
        </Space>
      )}
      <Table<Draft>
        size="small"
        rowKey="key"
        dataSource={visible}
        pagination={visible.length > 25 ? { pageSize: 25, size: "small" } : false}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: (keys) => setSelectedKeys(keys as string[]),
        }}
        columns={[
          {
            title: "Setting",
            render: (_, d) => (
              <div>
                <span className="mono">{d.cand.name}</span>
                {multiFile && (
                  <div style={{ fontSize: 11, opacity: 0.55 }} className="mono">
                    {d.cand.file}
                  </div>
                )}
              </div>
            ),
          },
          {
            title: "Current value",
            width: 170,
            render: (_, d) => (
              <span className="mono" style={{ opacity: 0.8 }}>
                {d.secret ? "••••••" : fmtValue(d.cand.value)}
              </span>
            ),
          },
          {
            title: "Type",
            width: 118,
            render: (_, d) => (
              <>
                <Select
                  size="small"
                  value={d.type}
                  style={{ width: "100%" }}
                  options={paramTypes.map((t) => ({ value: t, label: t }))}
                  onChange={(v) => patchDraft(d.key, { type: v, itemType: v === "list" ? d.itemType || "string" : undefined })}
                />
                {d.type === "list" && (
                  <Select
                    size="small"
                    value={d.itemType || "string"}
                    style={{ width: "100%", marginTop: 4 }}
                    options={itemTypes.map((t) => ({ value: t, label: `of ${t}` }))}
                    onChange={(v) => patchDraft(d.key, { itemType: v })}
                  />
                )}
              </>
            ),
          },
          {
            title: "Category",
            width: 170,
            render: (_, d) => (
              <AutoComplete
                size="small"
                value={d.category}
                style={{ width: "100%" }}
                options={allCategories.map((c) => ({ value: c }))}
                filterOption={(input, opt) => (opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
                onChange={(v) => patchDraft(d.key, { category: v })}
              />
            ),
          },
          {
            title: "Scope",
            width: 130,
            render: (_, d) => (
              <Tooltip title={scopeOptions.find((s) => s.value === d.scope)?.label}>
                <Select
                  size="small"
                  value={d.scope}
                  style={{ width: "100%" }}
                  options={scopeOptions.map((s) => ({ value: s.value, label: s.value }))}
                  onChange={(v) => patchDraft(d.key, { scope: v })}
                />
              </Tooltip>
            ),
          },
          {
            title: "Secret",
            width: 70,
            align: "center" as const,
            render: (_, d) => (
              <Switch size="small" checked={d.secret} onChange={(v) => patchDraft(d.key, { secret: v })} />
            ),
          },
        ]}
      />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
          Back to files
        </Button>
        <Button type="primary" disabled={chosenCount === 0} onClick={onNext}>
          Review {chosenCount} parameter(s) <ArrowRightOutlined />
        </Button>
      </div>
    </Card>
  );
}

// ---- step 3: review & initialize ----------------------------------------------

function ReviewStep({
  chosen,
  ignoredFiles,
  branch,
  importing,
  onBack,
  onImport,
}: {
  chosen: Draft[];
  ignoredFiles: string[];
  branch?: string;
  importing: boolean;
  onBack: () => void;
  onImport: () => void;
}) {
  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of chosen) m.set(d.category || "General", (m.get(d.category || "General") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [chosen]);
  const files = [...new Set(chosen.map((d) => d.cand.file))];
  const secrets = chosen.filter((d) => d.secret).length;

  return (
    <Card title="Review & initialize">
      <Space size={28} wrap style={{ marginBottom: 14 }}>
        <Statistic title="Parameters to import" value={chosen.length} />
        <Statistic title="Source files" value={files.length} />
        <Statistic title="Categories" value={byCategory.length} />
        {secrets > 0 && <Statistic title="Marked secret" value={secrets} valueStyle={{ color: "#eda100" }} />}
        {ignoredFiles.length > 0 && <Statistic title="Files to ignore" value={ignoredFiles.length} />}
      </Space>
      <Space size={6} wrap style={{ marginBottom: 12 }}>
        {byCategory.map(([c, n]) => (
          <Tag key={c}>
            {c}: {n}
          </Tag>
        ))}
      </Space>
      <Table<Draft>
        size="small"
        rowKey="key"
        dataSource={chosen}
        pagination={chosen.length > 15 ? { pageSize: 15, size: "small" } : false}
        style={{ marginBottom: 14 }}
        columns={[
          { title: "Setting", render: (_, d) => <span className="mono">{d.cand.name}</span> },
          {
            title: "Value",
            width: 180,
            render: (_, d) => (
              <span className="mono" style={{ opacity: 0.8 }}>
                {d.secret ? "••••••" : fmtValue(d.cand.value)}
              </span>
            ),
          },
          { title: "Type", dataIndex: "type", width: 90, render: (v: string) => <Tag>{v}</Tag> },
          { title: "Category", dataIndex: "category", width: 160 },
          { title: "Scope", dataIndex: "scope", width: 110 },
          { title: "File", width: 220, render: (_, d) => <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>{d.cand.file}</span> },
        ]}
      />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="What happens when you initialize"
        description={
          <>
            One commit is made on the current Git branch{branch ? <> (<code>{branch}</code>)</> : null}, adding
            these parameters to the Configer catalog
            {ignoredFiles.length > 0 && <> and recording {ignoredFiles.length} file(s) as ignored</>}.
            Your existing configuration files keep their values; from now on you edit them per
            system in the Editor, with validation and review built in.
          </>
        }
      />
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <Button icon={<ArrowLeftOutlined />} onClick={onBack} disabled={importing}>
          Back
        </Button>
        <Button type="primary" size="large" icon={<RocketOutlined />} loading={importing} onClick={onImport}>
          Initialize {chosen.length} parameter(s)
        </Button>
      </div>
    </Card>
  );
}
