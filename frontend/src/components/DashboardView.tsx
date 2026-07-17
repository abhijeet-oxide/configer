import { Button, Checkbox, Dropdown, List, Modal, Tooltip, Typography, Alert, App as AntApp } from "antd";
import {
  CheckCircleFilled,
  WarningFilled,
  EditOutlined,
  ExportOutlined,
  MoreOutlined,
  PullRequestOutlined,
  HistoryOutlined,
} from "../icons";
import UserAvatar from "./UserAvatar";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Grid } from "../api";
import { useActivity } from "../activity";
import { ActivitySparkline } from "./charts";
import { useUI } from "../store";
import { envHex } from "../theme";
import { StatTile, SectionCard, AttentionCard, AppContextChips, StatusPill, Stagger, StaggerItem } from "./ui";
import EditApplicationModal from "./EditApplicationModal";

// DashboardView is the application Overview: is it healthy, do I have unsent
// edits, did the repository change, does anything need action, how are the
// deployment targets, and what happened recently. Hierarchy over equal
// cards: health and attention lead, activity and repository status support.

export function relTime(iso?: string): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// DeleteApplicationModal removes an application from the workspace, and
// optionally deletes the .configer metadata folder from the repository
// itself. The repository's own configuration files are never touched.
function DeleteApplicationModal({
  open,
  onClose,
  project,
  repoId,
  onRemoved,
}: {
  open: boolean;
  onClose: () => void;
  project: string;
  repoId: string | null;
  onRemoved: () => void;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [alsoConfiger, setAlsoConfiger] = useState(false);

  const remove = useMutation({
    mutationFn: async () => {
      // Delete the .configer metadata first (a commit on the repo), then drop
      // the workspace connection.
      if (alsoConfiger) await api.deinit("demo-user");
      if (repoId) await api.removeRepo(repoId);
    },
    onSuccess: () => {
      message.success(
        alsoConfiger
          ? `"${project}" removed and its .configer metadata deleted from the repository.`
          : `"${project}" removed from the workspace. The repository is untouched.`,
      );
      qc.invalidateQueries({ queryKey: ["workspace"] });
      onClose();
      onRemoved();
    },
    onError: (e: Error) => message.error(e.message, 6),
  });

  return (
    <Modal
      open={open}
      title={`Delete "${project}"?`}
      okText={alsoConfiger ? "Delete metadata & remove" : "Remove"}
      okButtonProps={{ danger: true, loading: remove.isPending }}
      onOk={() => remove.mutate()}
      onCancel={onClose}
    >
      <Typography.Paragraph>
        This removes the application from your Configer workspace. By default the Git repository,
        including your configuration files and the <span className="mono">.configer</span> metadata,
        stays exactly as it is, and you can reconnect any time.
      </Typography.Paragraph>
      <Checkbox checked={alsoConfiger} onChange={(e) => setAlsoConfiger(e.target.checked)}>
        Also delete the <span className="mono">.configer</span> folder from the repository
      </Checkbox>
      {alsoConfiger && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message="This un-onboards the repository"
          description={
            <>
              All Configer metadata (parameters, instances, application details) is deleted in a
              commit. Your actual configuration files are <b>not</b> touched, but the repository
              will need to be set up again to manage it here. This cannot be undone except through
              Git history.
            </>
          }
        />
      )}
    </Modal>
  );
}

export default function DashboardView({ grid }: { grid: Grid }) {
  const { setSection, setFilters, selectParam, selectInstance, setJump, repoId, setRepo } = useUI();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const changesQ = useQuery({ queryKey: ["changes"], queryFn: api.changes, refetchInterval: 15_000 });
  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft });
  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus });
  const findingsQ = useQuery({ queryKey: ["findings"], queryFn: api.findings, refetchInterval: 30_000, retry: false });
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const activity = useActivity(6);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const sync = useMutation({
    mutationFn: api.repoSync,
    onSuccess: () => {
      message.success("Synchronized with the Git remote.");
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  // Per-instance health, reused by attention and the deployment targets.
  const perInstance = grid.instances.map((i) => {
    let invalid = 0;
    let bound = 0;
    for (const r of grid.rows) {
      const c = r.cells[i.name];
      if (!c) continue;
      if (c.set) bound++;
      if (!c.valid) invalid++;
    }
    return { inst: i, invalid, bound };
  });
  const invalid = perInstance.reduce((s, t) => s + t.invalid, 0);

  const awaiting = changesQ.data?.filter((c) => c.state === "under_review") ?? [];
  const pending = draftQ.data?.draft?.items?.length ?? 0;
  const st = statusQ.data;
  const findings = findingsQ.data?.findings ?? [];
  const repo = wsQ.data?.repos.find((r) => r.id === repoId);
  const gitUrl = repo?.origin?.startsWith("http") ? repo.origin : undefined;

  // change activity per day, last 14 days
  const days: { label: string; count: number }[] = [];
  for (let d = 13; d >= 0; d--) {
    const day = new Date(Date.now() - d * 86400_000);
    const key = day.toISOString().slice(0, 10);
    const count = (changesQ.data ?? []).filter((c) => c.updatedAt?.slice(0, 10) === key).length;
    days.push({ label: key.slice(5), count });
  }

  // Jump straight to the first broken cell (the editor scrolls + flashes it).
  const fixFirstInvalid = () => {
    for (const t of perInstance) {
      if (t.invalid === 0) continue;
      const row = grid.rows.find((r) => {
        const c = r.cells[t.inst.name];
        return c && !c.valid;
      });
      if (row) {
        selectInstance(t.inst.name);
        selectParam(row.param.id);
        setJump("cell", row.param.id, t.inst.name);
        setFilters({ invalidOnly: true });
        setSection("config");
        return;
      }
    }
    setSection("config");
  };

  type Attention = {
    key: string;
    severity: "warn" | "danger" | "info";
    title: string;
    sub: string;
    actionLabel: string;
    onAction: () => void;
  };
  const attention: Attention[] = [];
  if (invalid > 0)
    attention.push({
      key: "invalid",
      severity: "danger",
      title: `${invalid} setting${invalid === 1 ? "" : "s"} failing validation`,
      sub: "The editor opens on the first problem",
      actionLabel: "Fix now",
      onAction: fixFirstInvalid,
    });
  if (findings.length > 0)
    attention.push({
      key: "drift",
      severity: "warn",
      title: `${findings.length} repository change${findings.length === 1 ? "" : "s"} detected`,
      sub: "Review and import changes made outside Configer",
      actionLabel: "Review changes",
      onAction: () => setSection("drift"),
    });
  if (pending > 0)
    attention.push({
      key: "drafts",
      severity: "warn",
      title: `${pending} local edit${pending === 1 ? "" : "s"} haven't been submitted`,
      sub: "Create a change request to publish",
      actionLabel: "Review edits",
      onAction: () => setSection("config"),
    });
  if (awaiting.length > 0)
    attention.push({
      key: "review",
      severity: "info",
      title: `${awaiting.length} change request${awaiting.length === 1 ? "" : "s"} waiting for review`,
      sub: "Approve or reject in the review workspace",
      actionLabel: "Review",
      onAction: () => setSection("approvals"),
    });
  if (st?.upstreamGone || st?.syncError)
    attention.push({
      key: "sync",
      severity: st?.upstreamGone ? "danger" : "warn",
      title: st?.upstreamGone ? "The branch was removed on the remote" : "Git synchronization issue",
      sub: st?.syncError || "Your local work is safe",
      actionLabel: "Sync now",
      onAction: () => sync.mutate(),
    });

  return (
    <div className="h-full overflow-auto bg-canvas px-6 py-5">
      <Stagger className="mx-auto flex max-w-[1240px] flex-col gap-4">
        {/* Identity row: name + persistent context, actions on the right. */}
        <StaggerItem className="flex flex-wrap items-center gap-3">
          <span className="text-xl font-semibold text-ink">{grid.project}</span>
          <AppContextChips />
          <div style={{ flex: 1 }} />
          {gitUrl && (
            <Button size="small" icon={<ExportOutlined />} href={gitUrl} target="_blank">
              View in Git
            </Button>
          )}
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "edit", label: "Edit details" },
                { key: "import", label: "Import settings" },
                { type: "divider" },
                { key: "delete", danger: true, label: "Delete application" },
              ],
              onClick: ({ key }) => {
                if (key === "edit") setEditOpen(true);
                if (key === "import") setSection("import");
                if (key === "delete") setDeleteOpen(true);
              },
            }}
          >
            <Button size="small" icon={<MoreOutlined />} />
          </Dropdown>
        </StaggerItem>

        {/* The four operational numbers, each clickable to its source. */}
        <StaggerItem className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <StatTile
            label="Configuration health"
            value={
              <span style={{ color: invalid ? "var(--c-danger)" : "var(--c-ok)", fontSize: "var(--fs-16)" }}>
                {invalid === 0 ? "All settings valid" : `${invalid} to fix`}
              </span>
            }
            sub={invalid === 0 ? "No issues found" : "Open the editor on the first problem"}
            icon={
              invalid === 0 ? (
                <CheckCircleFilled style={{ color: "var(--c-ok)" }} />
              ) : (
                <WarningFilled style={{ color: "var(--c-danger)" }} />
              )
            }
            onClick={invalid ? fixFirstInvalid : () => setSection("config")}
          />
          <StatTile
            label="Unsent edits"
            value={pending}
            sub={pending ? "Waiting to be submitted" : "Nothing waiting"}
            icon={<EditOutlined style={{ color: pending ? "var(--c-pending)" : "var(--text-3)" }} />}
            onClick={() => setSection("config")}
          />
          <StatTile
            label="Repository changes"
            value={findings.length}
            sub={findings.length ? "Made outside Configer" : "None outside Configer"}
            icon={<PullRequestOutlined style={{ color: findings.length ? "var(--c-pending)" : "var(--text-3)" }} />}
            onClick={() => setSection("drift")}
          />
          <StatTile
            label="Last sync"
            value={st?.lastSync ? relTime(st.lastSync) : st?.remote ? "…" : "Local"}
            sub={
              !st?.remote
                ? "Local repository, no remote"
                : st.behind > 0
                  ? `${st.behind} commit${st.behind === 1 ? "" : "s"} behind`
                  : "Repository up to date"
            }
            icon={<HistoryOutlined style={{ color: "var(--text-3)" }} />}
            onClick={() => sync.mutate()}
          />
        </StaggerItem>

        {/* Attention + deployment targets: the two questions after health. */}
        <StaggerItem className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
          <SectionCard title="Needs your attention">
            {attention.length === 0 ? (
              <div className="flex items-center gap-2.5 py-2 text-ink-2">
                <CheckCircleFilled style={{ color: "var(--c-ok)", fontSize: 16 }} />
                Nothing needs you right now.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {attention.map((a) => (
                  <AttentionCard
                    key={a.key}
                    severity={a.severity}
                    title={a.title}
                    sub={a.sub}
                    actionLabel={a.actionLabel}
                    onAction={a.onAction}
                    primary={a.severity !== "danger"}
                  />
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Deployment targets"
            extra={
              <a onClick={() => setSection("instances")} style={{ fontSize: "var(--fs-12)" }}>
                View all instances
              </a>
            }
          >
            <div className="flex flex-col">
              {perInstance.map(({ inst, invalid: bad, bound }) => (
                <div
                  key={inst.name}
                  onClick={() => {
                    selectInstance(inst.name);
                    setJump("instance", inst.name);
                    setSection("config");
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 0",
                    borderBottom: "1px solid var(--border)",
                    cursor: "pointer",
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: envHex(inst.environment) }}
                    title={inst.environment}
                  />
                  <span className="mono" style={{ fontSize: "var(--fs-12)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {inst.name}
                  </span>
                  {bad > 0 ? (
                    <StatusPill tone="danger" size="sm">{bad} invalid</StatusPill>
                  ) : (
                    <StatusPill tone="ok" size="sm">Active</StatusPill>
                  )}
                  <span style={{ fontSize: "var(--fs-11)", color: "var(--text-3)", width: 96, textAlign: "right" }}>
                    {bound} parameter{bound === 1 ? "" : "s"}
                  </span>
                  <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-3)", width: 64, textAlign: "right" }}>
                    {inst.softwareVersion ?? ""}
                  </span>
                </div>
              ))}
            </div>
          </SectionCard>
        </StaggerItem>

        {/* Supporting band: what happened, how much, and the repository. */}
        <StaggerItem className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          <SectionCard
            title="Recent activity"
            extra={
              <a onClick={() => setSection("changes")} style={{ fontSize: "var(--fs-12)" }}>
                View all activity
              </a>
            }
          >
            {activity.items.length === 0 ? (
              <div style={{ color: "var(--text-3)", fontSize: "var(--fs-12)", padding: "var(--sp-2) 0" }}>
                No activity yet. Edit a setting in the editor to start a draft.
              </div>
            ) : (
              <List
                size="small"
                dataSource={activity.items}
                renderItem={(a) => (
                  <List.Item
                    style={{ cursor: a.section ? "pointer" : "default", paddingInline: 0 }}
                    onClick={() => a.section && setSection(a.section)}
                  >
                    <div style={{ display: "flex", gap: 8, minWidth: 0, width: "100%", alignItems: "flex-start" }}>
                      <UserAvatar name={a.actor} size={20} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: "var(--fs-12)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {a.actor && <b>{a.actor} </b>}
                          {a.text}
                        </div>
                      </div>
                      <span style={{ fontSize: "var(--fs-11)", color: "var(--text-3)", flexShrink: 0 }}>{relTime(a.at)}</span>
                    </div>
                  </List.Item>
                )}
              />
            )}
          </SectionCard>

          <SectionCard title="Changes over time (14 days)">
            <ActivitySparkline days={days} width={280} height={90} />
            <div style={{ fontSize: "var(--fs-11)", color: "var(--text-3)", marginTop: 4 }}>
              {(changesQ.data ?? []).length} change request{(changesQ.data ?? []).length === 1 ? "" : "s"} total
            </div>
          </SectionCard>

          <SectionCard
            title="Repository status"
            extra={
              gitUrl ? (
                <a href={gitUrl} target="_blank" rel="noreferrer" style={{ fontSize: "var(--fs-12)" }}>
                  View repository
                </a>
              ) : undefined
            }
          >
            <div className="flex flex-col gap-2">
              <div style={{ fontWeight: 600, fontSize: "var(--fs-13)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {repo?.name ?? grid.project}
              </div>
              <div className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-2)" }}>{st?.branch ?? "main"}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {st?.upstreamGone ? (
                  <StatusPill tone="danger">Branch removed</StatusPill>
                ) : st?.syncError ? (
                  <Tooltip title={st.syncError}>
                    <span style={{ display: "inline-flex" }}>
                      <StatusPill tone="pending">Sync issue</StatusPill>
                    </span>
                  </Tooltip>
                ) : !st?.remote ? (
                  <StatusPill tone="neutral">Local</StatusPill>
                ) : st.behind > 0 ? (
                  <StatusPill tone="pending">{st.behind} behind</StatusPill>
                ) : (
                  <StatusPill tone="ok">Synced</StatusPill>
                )}
                <span style={{ fontSize: "var(--fs-11)", color: "var(--text-3)" }}>
                  {st?.lastSync ? relTime(st.lastSync) : ""}
                </span>
              </div>
              {(st?.ahead ?? 0) > 0 && (
                <div style={{ fontSize: "var(--fs-11)", color: "var(--text-3)" }}>
                  {st?.ahead} commit{st?.ahead === 1 ? "" : "s"} ahead of the remote
                </div>
              )}
              <Button size="small" loading={sync.isPending} onClick={() => sync.mutate()} style={{ alignSelf: "flex-start" }}>
                Sync now
              </Button>
            </div>
          </SectionCard>
        </StaggerItem>
      </Stagger>

      <DeleteApplicationModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        project={grid.project}
        repoId={repoId}
        onRemoved={() => {
          setRepo(null);
          setSection("workspace");
        }}
      />
      {repoId && <EditApplicationModal open={editOpen} repoId={repoId} onClose={() => setEditOpen(false)} />}
    </div>
  );
}
