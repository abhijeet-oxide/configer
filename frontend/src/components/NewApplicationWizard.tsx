import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Select,
  Space,
  Steps,
  Tag,
  Typography,
  App as AntApp,
} from "antd";
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  BranchesOutlined,
  FileSearchOutlined,
  GithubOutlined,
  LockOutlined,
  PlusOutlined,
  RocketOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type GitHubRepo, type RepoSummary } from "../api";
import { relTime } from "./DashboardView";
import { InlineListSkeleton } from "./Skeletons";

// NewApplicationWizard is the seamless "New application" flow:
//
//   sign in with GitHub → pick one of YOUR repositories (own or org) →
//   pick the branch → name the application → create, then scan.
//
// No URLs, no tokens: the server browses GitHub with the signed-in user's
// own access (or the deployment token) and credentials never reach the
// browser. A manual mode (git URL or server path) stays available for
// everything that isn't GitHub.

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
  const [step, setStep] = useState(0);
  const [manual, setManual] = useState(false);
  const [repo, setRepo] = useState<GitHubRepo | null>(null);
  const [branch, setBranch] = useState<string | undefined>();
  const [name, setName] = useState("");

  const statusQ = useQuery({ queryKey: ["github-status"], queryFn: api.githubStatus, enabled: open });

  const reset = () => {
    setStep(0);
    setManual(false);
    setRepo(null);
    setBranch(undefined);
    setName("");
  };

  const create = useMutation({
    mutationFn: () =>
      api.connectRepo({ url: repo!.url, name: name.trim() || repo!.name, branch }),
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
      destroyOnClose
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        An application manages the configuration living in one Git repository. Pick the
        repository and branch, give it a name, and Configer scans it for settings — nothing is
        written until you say so.
      </Typography.Paragraph>
      <Steps
        size="small"
        current={step}
        style={{ margin: "8px 0 20px" }}
        items={[
          { title: "Repository", icon: <GithubOutlined /> },
          { title: "Branch", icon: <BranchesOutlined /> },
          { title: "Name & create", icon: <RocketOutlined /> },
        ]}
      />
      {step === 0 &&
        (manual ? (
          <>
            <ConnectForm compact onDone={(r) => { reset(); onCreated(r); }} />
            <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => setManual(false)}>
              <ArrowLeftOutlined /> Back to picking from GitHub
            </Button>
          </>
        ) : (
          <RepoStep
            loading={statusQ.isLoading}
            status={statusQ.data}
            onPick={pickRepo}
            onManual={() => setManual(true)}
          />
        ))}
      {step === 1 && repo && (
        <BranchStep
          repo={repo}
          branch={branch}
          setBranch={setBranch}
          onBack={() => setStep(0)}
          onNext={() => setStep(2)}
        />
      )}
      {step === 2 && repo && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Alert
            type="info"
            showIcon
            icon={<FileSearchOutlined />}
            message={
              <>
                <span className="mono">{repo.fullName}</span> on branch{" "}
                <Tag icon={<BranchesOutlined />} className="mono" style={{ fontSize: 11, marginInlineEnd: 0 }}>
                  {branch ?? repo.defaultBranch ?? "default"}
                </Tag>{" "}
                — after creating, Configer scans this branch and shows the configuration files it
                found, so you choose what to manage.
              </>
            }
          />
          <Form layout="vertical" requiredMark={false}>
            <Form.Item
              label="Application name"
              extra="How this configuration appears across Configer. The repository is not renamed."
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                autoFocus
                placeholder={repo.name}
              />
            </Form.Item>
          </Form>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <Button icon={<ArrowLeftOutlined />} onClick={() => setStep(1)} disabled={create.isPending}>
              Branch
            </Button>
            <Button
              type="primary"
              size="large"
              icon={<RocketOutlined />}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Create application & scan
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---- step 0: pick the repository -------------------------------------------

function RepoStep({
  loading,
  status,
  onPick,
  onManual,
}: {
  loading: boolean;
  status?: { available: boolean; source: string; login?: string; signInEnabled: boolean };
  onPick: (r: GitHubRepo) => void;
  onManual: () => void;
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

  if (!status?.available) {
    return (
      <div style={{ textAlign: "center", padding: "20px 12px" }}>
        <GithubOutlined style={{ fontSize: 44, opacity: 0.6 }} />
        <Typography.Title level={5} style={{ marginTop: 14 }}>
          Connect your GitHub account
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 440, margin: "0 auto 18px" }}>
          Sign in once and Configer shows the repositories you have access to — yours and your
          organizations' — so creating an application is a couple of clicks, with no URLs or
          tokens to paste.
        </Typography.Paragraph>
        {status?.signInEnabled ? (
          <Button type="primary" size="large" icon={<GithubOutlined />} href="/api/auth/login">
            Continue with GitHub
          </Button>
        ) : (
          <Alert
            type="info"
            showIcon
            style={{ textAlign: "start", maxWidth: 520, margin: "0 auto" }}
            message="GitHub sign-in is not configured on this deployment"
            description="An administrator can enable it (GITHUB_OAUTH_CLIENT_ID) or set a server-wide GitHub token. You can still connect a repository manually below."
          />
        )}
        <div style={{ marginTop: 14 }}>
          <Button type="link" onClick={onManual}>
            Connect manually (git URL or server path)
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Input
          allowClear
          autoFocus
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
        <Alert
          type="warning"
          showIcon
          message="Couldn't list your repositories"
          description={(reposQ.error as Error).message}
          action={
            <Button size="small" onClick={() => reposQ.refetch()}>
              Try again
            </Button>
          }
        />
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
      <Button type="link" size="small" style={{ alignSelf: "flex-start", paddingInline: 0 }} onClick={onManual}>
        Not on GitHub? Connect manually
      </Button>
    </div>
  );
}

// ---- step 1: pick the branch ------------------------------------------------

function BranchStep({
  repo,
  branch,
  setBranch,
  onBack,
  onNext,
}: {
  repo: GitHubRepo;
  branch?: string;
  setBranch: (b: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const branchesQ = useQuery({
    queryKey: ["github-branches", repo.fullName],
    queryFn: () => api.githubBranches(repo.fullName),
    staleTime: 60_000,
  });
  const chosen = branch ?? branchesQ.data?.default ?? repo.defaultBranch;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Typography.Text>
        Which branch of <span className="mono">{repo.fullName}</span> holds the configuration to
        manage? Configer reads and writes on this branch; every edit still goes through review.
      </Typography.Text>
      {branchesQ.isError ? (
        <Alert
          type="warning"
          showIcon
          message="Couldn't list branches"
          description={(branchesQ.error as Error).message}
          action={
            <Button size="small" onClick={() => branchesQ.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <Select
          size="large"
          showSearch
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
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
          Repository
        </Button>
        <Button type="primary" disabled={!chosen} onClick={() => { if (chosen) setBranch(chosen); onNext(); }}>
          Continue <ArrowRightOutlined />
        </Button>
      </div>
    </div>
  );
}

// ---- manual fallback ---------------------------------------------------------

// ConnectForm is the manual path (a git URL or a path on the server) — also
// used by the import wizard's connect step.
export function ConnectForm({
  onDone,
  compact,
}: {
  onDone: (r: RepoSummary) => void;
  compact?: boolean;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ url: string; name: string; branch?: string; token?: string }>();
  const connect = useMutation({
    mutationFn: (v: { url: string; name: string; branch?: string; token?: string }) => api.connectRepo(v),
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
        rules={[{ required: true, message: "Give a git URL or a path on the server" }]}
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
