import {
  Button,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
} from "antd";
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  BranchesOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  GithubOutlined,
  HddOutlined,
  LockOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  SearchOutlined,
} from "../icons";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type GitHubRepo, type RepoSummary } from "../api";
import { useCapabilities } from "../deployment";
import { relTime } from "./DashboardView";
import { InlineNotice, Stepper } from "./ui";
import { InlineListSkeleton } from "./Skeletons";

// NewApplicationWizard is the seamless "New application" flow. It opens on a
// choice of source, as two big cards:
//
//   Git repository → sign in with GitHub → pick one of YOUR repositories →
//                    branch + name on one screen → create, then scan.
//   Local folder   → point at a folder on the server; Configer turns it into
//                    a local Git repository (initial commit included) and
//                    manages it in place.
//
// No URLs, no tokens: the server browses GitHub with the signed-in user's
// own access (or the deployment token) and credentials never reach the
// browser. A manual mode (git URL) stays available for everything that isn't
// GitHub. The step body has a fixed minimum height so the dialog never jumps
// between steps.

type Source = "git" | "local";

export default function NewApplicationWizard({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (r: RepoSummary) => void;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [source, setSource] = useState<Source | null>(null);
  const [step, setStep] = useState(0); // within the Git path: 0 pick repo, 1 finish
  const [manual, setManual] = useState(false);
  const [repo, setRepo] = useState<GitHubRepo | null>(null);
  const [branch, setBranch] = useState<string | undefined>();
  const [name, setName] = useState("");

  const statusQ = useQuery({ queryKey: ["github-status"], queryFn: api.githubStatus, enabled: open });
  const caps = useCapabilities();
  // "Local folder" browses the SERVER's filesystem. On a hosted deployment that
  // is a machine the user has never seen, so the choice is not offered - and
  // with only one source left there is nothing to choose: the dialog opens
  // straight on it instead of asking a question with one answer.
  const soleSource: Source | null = caps.localFolders ? null : "git";
  const chosen = source ?? soleSource;

  const reset = () => {
    setSource(null);
    setStep(0);
    setManual(false);
    setRepo(null);
    setBranch(undefined);
    setName("");
  };

  const create = useMutation({
    // Connect returns 202 immediately; wait for the background clone/open to
    // finish (or fail) before advancing, so onboarding gets a ready repository.
    mutationFn: async () => {
      const started = await api.connectRepo({ url: repo!.url, name: name.trim() || repo!.name, branch });
      return api.waitForRepoReady(started.id);
    },
    onSuccess: (r) => {
      message.success(`Application "${r.name}" created. Scanning the repository…`);
      qc.invalidateQueries({ queryKey: ["workspace"] });
      reset();
      onCreated(r);
    },
    onError: (e: Error) => message.error(e.message, 6),
  });

  const pickRepo = (r: GitHubRepo) => {
    setRepo(r);
    setBranch(undefined);
    if (!name.trim()) setName(r.name);
    setStep(1);
  };

  // The step strip mirrors the path actually being walked. With one source
  // there is no Source step to show, so the strip starts at Repository.
  const sourceStep = soleSource === null ? [{ label: "Source", icon: <FolderOpenOutlined /> }] : [];
  const stepItems =
    chosen === "local"
      ? [...sourceStep, { label: "Create", icon: <ThunderboltOutlined /> }]
      : [
          ...sourceStep,
          { label: "Repository", icon: <GithubOutlined /> },
          { label: "Create", icon: <ThunderboltOutlined /> },
        ];
  const currentStep =
    (chosen === null ? 0 : chosen === "local" ? 1 : 1 + step) - (soleSource === null ? 0 : 1);

  return (
    <Modal
      title="New application"
      open={open}
      onCancel={() => {
        reset();
        onClose();
      }}
      footer={null}
      width={720}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" className="wizard-intro" style={{ marginTop: 4 }}>
        An application manages the configuration in one Git repository
        {caps.localFolders ? ", remote or a folder on this machine" : ""}. Configer scans it for
        settings; no changes are made until you confirm.
      </Typography.Paragraph>
      <div className="wizard-steps mb-5 mt-2 rounded-card-lg bg-surface-2 px-4 py-3">
        <Stepper current={currentStep} steps={stepItems} />
      </div>
      {/* A floor so the dialog chrome and buttons never jump between steps -
          dropped on short and narrow screens, where the content sets the height
          and the dialog body scrolls. */}
      <div className="wizard-body">
        {chosen === null && <SourceStep onPick={setSource} />}

        {chosen === "local" && (
          <LocalFolderStep
            onBack={() => setSource(null)}
            onDone={(r) => {
              reset();
              onCreated(r);
            }}
          />
        )}

        {chosen === "git" && step === 0 &&
          (manual ? (
            <>
              <ConnectForm compact onDone={(r) => { reset(); onCreated(r); }} />
              <Button type="link" size="small" style={{ paddingInline: 0, alignSelf: "flex-start" }} onClick={() => setManual(false)}>
                <ArrowLeftOutlined /> Back to picking from GitHub
              </Button>
            </>
          ) : (
            <RepoStep
              loading={statusQ.isLoading}
              status={statusQ.data}
              onPick={pickRepo}
              onManual={() => setManual(true)}
              onBack={soleSource === null ? () => setSource(null) : undefined}
            />
          ))}
        {chosen === "git" && step === 1 && repo && (
          <FinishStep
            repo={repo}
            branch={branch}
            setBranch={setBranch}
            name={name}
            setName={setName}
            creating={create.isPending}
            onBack={() => setStep(0)}
            onCreate={() => create.mutate()}
          />
        )}
      </div>
    </Modal>
  );
}

// ---- step: pick the source ---------------------------------------------------

// Two big, equal choices - where does the configuration live?
function SourceStep({ onPick }: { onPick: (s: Source) => void }) {
  const card: React.CSSProperties = {
    border: "1px solid rgba(127,137,160,0.28)",
    borderRadius: 12,
    padding: "22px 18px",
    cursor: "pointer",
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
  };
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-start", gap: 14 }}>
      <Typography.Text strong style={{ fontSize: 15, textAlign: "center" }}>
        Where does the configuration live?
      </Typography.Text>
      <div className="choice-row">
        <div className="card-clickable" style={card} onClick={() => onPick("git")} role="button" tabIndex={0}>
          <GithubOutlined className="choice-card-icon" style={{ opacity: 0.75 }} />
          <Typography.Text strong style={{ fontSize: 14.5 }}>
            Git repository
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            Connect a repository on GitHub (or any git URL). You'll authorize with GitHub and
            pick from your repositories - no URLs or tokens to paste.
          </Typography.Text>
          <Button type="primary" ghost size="small" style={{ marginTop: "auto" }}>
            Choose a repository <ArrowRightOutlined />
          </Button>
        </div>
        <div className="card-clickable" style={card} onClick={() => onPick("local")} role="button" tabIndex={0}>
          <HddOutlined className="choice-card-icon" style={{ opacity: 0.75 }} />
          <Typography.Text strong style={{ fontSize: 14.5 }}>
            Local folder
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            Point at a folder on this machine. Configer turns it into a local Git repository
            (history included) and manages the configuration in place.
          </Typography.Text>
          <Button type="primary" ghost size="small" style={{ marginTop: "auto" }}>
            Choose a folder <ArrowRightOutlined />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- step: local folder --------------------------------------------------------

// The folder is CHOSEN, never typed: one button opens a modal folder picker
// (FolderPickerModal) that browses the machine Configer runs on and hands back
// the real path. The application takes the folder's name and a pointer to where
// it lives - both kept in the workspace on this device. The backend opens the
// folder in place and initializes Git (with an initial import commit) when it
// isn't a repository yet, so every edit is versioned from the very first one.
type PickedFolder = { path: string; name: string; isRepo: boolean };

function LocalFolderStep({
  onBack,
  onDone,
}: {
  onBack: () => void;
  onDone: (r: RepoSummary) => void;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<PickedFolder | null>(null);

  const connect = useMutation({
    // Name is derived server-side from the folder; nothing to enter here.
    mutationFn: async (path: string) => {
      const started = await api.connectRepo({ url: path });
      return api.waitForRepoReady(started.id);
    },
    onSuccess: (r) => {
      message.success(`Application "${r.name}" created from the local folder. Scanning it…`);
      qc.invalidateQueries({ queryKey: ["workspace"] });
      onDone(r);
    },
    onError: (e: Error) => message.error(e.message, 6),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      {!picked ? (
        // The "click to select" affordance, styled like a drop zone so it
        // reads as the one thing to do on this step.
        <div
          className="card-clickable"
          role="button"
          tabIndex={0}
          onClick={() => setPickerOpen(true)}
          style={{
            border: "1.5px dashed rgba(127,137,160,0.5)",
            borderRadius: 12,
            padding: "40px 22px",
            textAlign: "center",
            cursor: "pointer",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
          }}
        >
          <FolderOpenOutlined className="choice-card-icon" style={{ opacity: 0.7 }} />
          <Typography.Text strong style={{ fontSize: 14.5 }}>
            Click to select a local directory
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12.5, maxWidth: 420 }}>
            Browse the folders on this machine and choose one to manage. Configer reads the folder
            in place - no files are uploaded.
          </Typography.Text>
        </div>
      ) : (
        // The chosen folder, with its resolved name and a way to change it.
        <div
          style={{
            border: "1px solid rgba(127,137,160,0.28)",
            borderRadius: 12,
            padding: "16px 18px",
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <FolderOutlined style={{ fontSize: 30, opacity: 0.7 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Space size={8}>
              <Typography.Text strong style={{ fontSize: 14.5 }}>
                {picked.name}
              </Typography.Text>
              {!picked.isRepo && (
                <Tag color="geekblue" style={{ fontSize: 10 }}>
                  new local git repo
                </Tag>
              )}
            </Space>
            <div className="mono" style={{ fontSize: 12, opacity: 0.6, overflowWrap: "anywhere" }}>
              {picked.path}
            </div>
          </div>
          <Button onClick={() => setPickerOpen(true)} disabled={connect.isPending}>
            Change
          </Button>
        </div>
      )}

      <Typography.Text type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        <FileSearchOutlined /> The folder is added as itself
        {picked && !picked.isRepo && " - a local Git repository is initialized for it"}. Configer
        then scans it and shows the configuration files it found, so you choose what to manage.
      </Typography.Text>

      <div className="wizard-actions">
        <Button icon={<ArrowLeftOutlined />} onClick={onBack} disabled={connect.isPending}>
          Source
        </Button>
        <Button
          type="primary"
          size="large"
          icon={<ThunderboltOutlined />}
          loading={connect.isPending}
          disabled={!picked}
          onClick={() => picked && connect.mutate(picked.path)}
        >
          Create application &amp; scan
        </Button>
      </div>

      <FolderPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(f) => {
          setPicked(f);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

// FolderPickerModal is the "click to select" dialog: it browses the filesystem
// of the machine Configer runs on (its filesystem is the user's own when
// Configer runs on their device), navigating into sub-folders and stepping up,
// and hands the chosen folder's real path back to the caller.
function FolderPickerModal({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (f: PickedFolder) => void;
}) {
  // The directory currently open in the picker (undefined = the server's home).
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  const listQ = useQuery({
    queryKey: ["fs-browse", cwd ?? ""],
    queryFn: () => api.browseFolders(cwd),
    enabled: open,
    // keep the previous listing on screen while the next loads (no flicker)
    placeholderData: (prev) => prev,
  });
  const listing = listQ.data;

  return (
    <Modal
      title="Select a local folder"
      open={open}
      onCancel={onClose}
      width={600}
      okText="Use this folder"
      okButtonProps={{ disabled: !listing?.path }}
      onOk={() =>
        listing && onSelect({ path: listing.path, name: listing.name, isRepo: listing.isRepo })
      }
    >
      {/* Current location + up. The path is shown, never typed. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0" }}>
        <Tooltip title="Up one folder">
          <Button
            size="small"
            icon={<ArrowUpOutlined />}
            disabled={!listing?.parent}
            onClick={() => listing?.parent && setCwd(listing.parent)}
            aria-label="Up one folder"
          />
        </Tooltip>
        <FolderOpenOutlined style={{ opacity: 0.6 }} />
        <Typography.Text className="mono" ellipsis style={{ fontSize: 12.5, flex: 1 }} title={listing?.path}>
          {listing?.path ?? "…"}
        </Typography.Text>
      </div>

      {/* The folders inside the current one; click to go deeper. */}
      <div
        style={{
          minHeight: 260,
          maxHeight: 340,
          overflow: "auto",
          border: "1px solid rgba(127,137,160,0.28)",
          borderRadius: 10,
        }}
      >
        {listQ.isError ? (
          <InlineNotice
            tone="warn"
            className="m-3"
            action={
              listing?.parent ? (
                <Button size="small" onClick={() => listing?.parent && setCwd(listing.parent)}>
                  Go up
                </Button>
              ) : undefined
            }
          >
            This folder can&rsquo;t be opened: {(listQ.error as Error).message}
          </InlineNotice>
        ) : listQ.isLoading ? (
          <InlineListSkeleton rows={6} />
        ) : (listing?.folders.length ?? 0) === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No sub-folders here. Use this folder, or step up."
            style={{ marginTop: 40 }}
          />
        ) : (
          <List
            size="small"
            dataSource={listing?.folders ?? []}
            renderItem={(f) => (
              <List.Item
                className="scm-change-row"
                style={{ cursor: "pointer", paddingInline: 12 }}
                onClick={() => setCwd(f.path)}
                actions={[<ArrowRightOutlined key="go" style={{ opacity: 0.4 }} />]}
              >
                <List.Item.Meta
                  avatar={<FolderOutlined style={{ fontSize: 18, opacity: 0.7, marginTop: 3 }} />}
                  title={
                    <Space size={8}>
                      <span>{f.name}</span>
                      {f.hasConfiger ? (
                        <Tag color="geekblue" style={{ fontSize: 10 }}>
                          Configer app
                        </Tag>
                      ) : f.isRepo ? (
                        <Tag style={{ fontSize: 10 }}>git repo</Tag>
                      ) : null}
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 11.5, display: "block", marginTop: 8 }}>
        Browsing the machine Configer runs on. Click a folder to open it, then “Use this folder”.
      </Typography.Text>
    </Modal>
  );
}

// ---- step 0: pick the repository -------------------------------------------

function RepoStep({
  loading,
  status,
  onPick,
  onManual,
  onBack,
}: {
  loading: boolean;
  status?: { available: boolean; source: string; login?: string; signInEnabled: boolean };
  onPick: (r: GitHubRepo) => void;
  onManual: () => void;
  /** absent when this deployment offers only one source: there is nowhere back to */
  onBack?: () => void;
}) {
  const [q, setQ] = useState("");
  const reposQ = useQuery({
    queryKey: ["github-repos"],
    queryFn: api.githubRepos,
    enabled: !!status?.available,
    staleTime: 60_000,
  });

  const repos = useMemo(() => {
    const all = reposQ.data?.repos ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (r) =>
        r.fullName.toLowerCase().includes(needle) ||
        (r.description ?? "").toLowerCase().includes(needle),
    );
  }, [reposQ.data, q]);

  if (loading) return <InlineListSkeleton rows={5} />;

  // Two different situations wear the same "we cannot list your repositories"
  // shape, and they need different pages. If signing in is possible, invite it.
  // If GitHub was never connected to this deployment, DON'T offer a button that
  // cannot work: say the integration is unavailable in the user's own terms -
  // no OAuth, no environment variables, nothing they cannot act on - and lead
  // with the path that does work here.
  if (!status?.available) {
    if (!status?.signInEnabled) {
      return (
        <div style={{ textAlign: "center", padding: "20px 12px" }}>
          <BranchesOutlined className="choice-card-icon" style={{ opacity: 0.6 }} />
          <Typography.Title level={5} style={{ marginTop: 14 }}>
            Add a repository by its address
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ maxWidth: 460, margin: "0 auto 18px" }}>
            GitHub integration is not available on this deployment, so repositories are added by
            their Git address instead. An administrator can connect GitHub to let you browse and
            pick from your repositories.
          </Typography.Paragraph>
          <Button type="primary" size="large" icon={<BranchesOutlined />} onClick={onManual}>
            Add by Git address
          </Button>
          {onBack && (
            <div style={{ marginTop: 14 }}>
              <Button type="link" size="small" onClick={onBack}>
                <ArrowLeftOutlined /> Back to choosing a source
              </Button>
            </div>
          )}
        </div>
      );
    }
    return (
      <div style={{ textAlign: "center", padding: "20px 12px" }}>
        <GithubOutlined className="choice-card-icon" style={{ opacity: 0.6 }} />
        <Typography.Title level={5} style={{ marginTop: 14 }}>
          Connect your GitHub account
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 440, margin: "0 auto 18px" }}>
          Sign in once and Configer shows the repositories you have access to - yours and your
          organizations' - so creating an application is a couple of clicks, with no URLs or
          tokens to paste.
        </Typography.Paragraph>
        <Button
          type="primary"
          size="large"
          icon={<GithubOutlined />}
          href={`/api/auth/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`}
        >
          Continue with GitHub
        </Button>
        <div style={{ marginTop: 14 }}>
          <Button type="link" onClick={onManual}>
            Connect manually (git URL)
          </Button>
        </div>
        {onBack && (
          <div style={{ marginTop: 4 }}>
            <Button type="link" size="small" onClick={onBack}>
              <ArrowLeftOutlined /> Back to choosing a source
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* The "who am I searching as" note wraps under the box rather than
          squeezing it on a narrow screen. */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Input
          allowClear
          autoFocus
          style={{ flex: "1 1 220px", minWidth: 0 }}
          prefix={<SearchOutlined />}
          placeholder="Search your repositories and organizations…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          {status.source === "session" && status.login ? (
            <>
              as <b>{status.login}</b>
            </>
          ) : (
            "via the server's GitHub access"
          )}
        </Typography.Text>
      </div>
      {reposQ.isError ? (
        <InlineNotice
          tone="warn"
          action={
            <Button size="small" onClick={() => reposQ.refetch()}>
              Try again
            </Button>
          }
        >
          Couldn&rsquo;t list your repositories: {(reposQ.error as Error).message}
        </InlineNotice>
      ) : reposQ.isLoading ? (
        <InlineListSkeleton rows={6} />
      ) : repos.length === 0 ? (
        <Empty description={q ? "Nothing matches that search." : "No repositories found."} />
      ) : (
        <List
          size="small"
          style={{ maxHeight: 380, overflow: "auto" }}
          dataSource={repos.slice(0, 60)}
          renderItem={(r) => (
            <List.Item
              className="scm-change-row"
              style={{ cursor: "pointer", borderRadius: 8, paddingInline: 10 }}
              onClick={() => onPick(r)}
              actions={[<ArrowRightOutlined key="go" style={{ opacity: 0.45 }} />]}
            >
              <List.Item.Meta
                avatar={<GithubOutlined style={{ fontSize: 18, opacity: 0.7, marginTop: 4 }} />}
                title={
                  <Space size={8}>
                    <span className="mono" style={{ fontSize: 13 }}>
                      {r.fullName}
                    </span>
                    {r.private && (
                      <Tag icon={<LockOutlined />} style={{ fontSize: 10 }}>
                        private
                      </Tag>
                    )}
                  </Space>
                }
                description={
                  <span style={{ fontSize: 12 }}>
                    {r.description || "no description"}
                    {r.pushedAt && <span style={{ opacity: 0.6 }}> · updated {relTime(r.pushedAt)}</span>}
                  </span>
                }
              />
            </List.Item>
          )}
        />
      )}
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={onBack}>
          <ArrowLeftOutlined /> Source
        </Button>
        <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={onManual}>
          Not on GitHub? Connect manually
        </Button>
      </div>
    </div>
  );
}

// ---- step 1: branch, name & create -------------------------------------------

// A Select and a text input do not deserve two separate steps: everything
// after picking the repository lives on one screen, one click from done.
function FinishStep({
  repo,
  branch,
  setBranch,
  name,
  setName,
  creating,
  onBack,
  onCreate,
}: {
  repo: GitHubRepo;
  branch?: string;
  setBranch: (b: string) => void;
  name: string;
  setName: (n: string) => void;
  creating: boolean;
  onBack: () => void;
  onCreate: () => void;
}) {
  const branchesQ = useQuery({
    queryKey: ["github-branches", repo.fullName],
    queryFn: () => api.githubBranches(repo.fullName),
    staleTime: 60_000,
  });
  const chosen = branch ?? branchesQ.data?.default ?? repo.defaultBranch;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
      <Form layout="vertical" requiredMark={false}>
        <Form.Item
          label={
            <>
              Branch of <span className="mono" style={{ marginInlineStart: 4 }}>{repo.fullName}</span>
            </>
          }
          extra="Configer reads and writes on this branch; every edit still goes through review."
        >
          {branchesQ.isError ? (
            <InlineNotice
              tone="warn"
              action={
                <Button size="small" onClick={() => branchesQ.refetch()}>
                  Try again
                </Button>
              }
            >
              Couldn&rsquo;t list branches: {(branchesQ.error as Error).message}
            </InlineNotice>
          ) : (
            <Select
              size="large"
              showSearch
              style={{ width: "100%" }}
              loading={branchesQ.isLoading}
              value={branchesQ.isLoading ? undefined : chosen}
              placeholder="Choose a branch"
              onChange={(v) => setBranch(v)}
              suffixIcon={<BranchesOutlined />}
              options={(branchesQ.data?.branches ?? []).map((b) => ({
                value: b,
                label: (
                  <span className="mono">
                    {b}
                    {b === branchesQ.data?.default ? "  (default)" : ""}
                  </span>
                ),
              }))}
            />
          )}
        </Form.Item>
        <Form.Item
          label="Application name"
          extra="How this configuration appears across Configer. The repository is not renamed."
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder={repo.name}
          />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <FileSearchOutlined /> After creating, Configer scans this branch and shows the
        configuration files it found, so you choose what to manage.
      </Typography.Text>
      <div className="wizard-actions">
        <Button icon={<ArrowLeftOutlined />} onClick={onBack} disabled={creating}>
          Repository
        </Button>
        <Button
          type="primary"
          size="large"
          icon={<ThunderboltOutlined />}
          loading={creating}
          disabled={branchesQ.isLoading && !chosen}
          onClick={onCreate}
        >
          Create application & scan
        </Button>
      </div>
    </div>
  );
}

// ---- manual fallback ---------------------------------------------------------

// ConnectForm is the manual path (a Git address, or a path on the server where
// that is meaningful) - also used by the import wizard's connect step. It needs
// no integration at all, which is why it stays available on every deployment.
export function ConnectForm({
  onDone,
  compact,
}: {
  onDone: (r: RepoSummary) => void;
  compact?: boolean;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const caps = useCapabilities();
  const [form] = Form.useForm<{ url: string; name: string; branch?: string; token?: string }>();
  const connect = useMutation({
    mutationFn: async (v: { url: string; name: string; branch?: string; token?: string }) => {
      const started = await api.connectRepo(v);
      return api.waitForRepoReady(started.id);
    },
    onSuccess: (r) => {
      const how = r.local ? "opened in place" : r.noClone ? "connected via the GitHub API" : "connected";
      message.success(`Application "${r.name}" created (${how}).`);
      qc.invalidateQueries({ queryKey: ["workspace"] });
      form.resetFields();
      onDone(r);
    },
    onError: (e: Error) => message.error(e.message, 6),
  });
  return (
    <Form form={form} layout="vertical" onFinish={(v) => connect.mutate(v)} requiredMark={false}>
      <Form.Item
        name="name"
        label="Application name"
        rules={[{ required: true, message: "Give the application a name" }]}
      >
        <Input placeholder="e.g. Network Platform" maxLength={60} autoFocus />
      </Form.Item>
      <Form.Item
        name="url"
        label="Repository"
        rules={[
          {
            required: true,
            message: caps.localFolders
              ? "Give a Git address or a folder on this machine"
              : "Give the repository's Git address",
          },
        ]}
        extra={compact ? undefined : "The Git repository whose configuration this application manages."}
      >
        <Input placeholder="https://github.com/acme/network-config.git" className="mono" />
      </Form.Item>
      <Form.Item name="branch" label="Branch (optional)">
        <Input placeholder="default branch" className="mono" maxLength={80} />
      </Form.Item>
      <Form.Item
        name="token"
        label="Access token (private repositories)"
        extra="Used by the server for Git operations. It never leaves the server and is never shown again."
      >
        <Input.Password placeholder="ghp_… (optional)" autoComplete="off" />
      </Form.Item>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button type="primary" htmlType="submit" loading={connect.isPending} icon={<PlusOutlined />}>
          Create application
        </Button>
      </div>
    </Form>
  );
}
