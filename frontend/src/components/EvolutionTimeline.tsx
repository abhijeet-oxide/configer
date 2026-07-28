import {
  Button,
  Empty,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
  theme as antdTheme,
} from "antd";
import {
  RocketOutlined,
  ClusterOutlined,
  EditOutlined,
  PlusCircleOutlined,
  MinusCircleOutlined,
  RollbackOutlined,
  HistoryOutlined,
  ReloadOutlined,
  GlobalOutlined,
  RightOutlined,
  DownOutlined,
  LoadingOutlined,
} from "../icons";
import { useState } from "react";
import { keepPreviousData, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import {
  api,
  type Grid,
  type TimelineEntry,
  type SnapshotKind,
  type CellChange,
  type RestoreScope,
} from "../api";
import { useUI } from "../store";
import { relTime } from "./DashboardView";
import { StatePanel, InSyncArt } from "./illustrations";
import UserAvatar from "./UserAvatar";
import { TableSkeleton } from "./Skeletons";
import { useIdentity } from "../identity";

// EvolutionTimeline shows how this application's configuration EVOLVED, as a
// column of snapshots a user can read, open up and roll back to.
//
// The whole surface rests on one idea, applied at every level: going back is
// never a history rewrite. Every restore stages ordinary forward edits into the
// draft, which the user then reviews and publishes like any other change. So a
// rollback is as safe, as visible and as reversible as an edit made by hand.
//
// Three scopes, one gesture:
//   - the whole application   (this timeline with no instance selected)
//   - one instance            (pick it in the scope selector)
//   - one parameter           (a row inside an opened snapshot)
//
// Two things you can do at any snapshot, deliberately worded so they cannot be
// confused with one another:
//   - "Undo this change"      puts values back to how they were BEFORE it
//   - "Restore to this point" brings them back to how they looked AFTER it

const { Text } = Typography;

/** How each snapshot kind reads at a glance. Red is reserved for errors, so a
 *  version upgrade and a structural change use their own identity colors. */
const kindMeta: Record<SnapshotKind, { icon: React.ReactNode; hex: string; label: string }> = {
  version: { icon: <RocketOutlined />, hex: "#6c3df4", label: "Version upgrade" },
  structural: { icon: <ClusterOutlined />, hex: "var(--c-review)", label: "Instances changed" },
  config: { icon: <EditOutlined />, hex: "var(--c-pending)", label: "Configuration change" },
  none: { icon: <HistoryOutlined />, hex: "var(--c-base)", label: "No configuration change" },
};

/** How each per-parameter change reads inside an opened snapshot. */
const statusMeta: Record<CellChange["status"], { icon: React.ReactNode; hex: string; label: string }> = {
  added: { icon: <PlusCircleOutlined />, hex: "var(--c-ok)", label: "Added" },
  removed: { icon: <MinusCircleOutlined />, hex: "var(--c-danger)", label: "Removed" },
  modified: { icon: <EditOutlined />, hex: "var(--c-pending)", label: "Changed" },
};

/** A value as it reads in the diff; an absent value says so in words. */
function ValueChip({ value, tone }: { value: string; tone: "before" | "after" }) {
  const { token } = antdTheme.useToken();
  const empty = value === "" || value === undefined;
  return (
    <code
      style={{
        padding: "1px 6px",
        borderRadius: token.borderRadiusSM,
        fontSize: 12,
        background: token.colorFillQuaternary,
        color: empty ? token.colorTextTertiary : tone === "before" ? token.colorTextSecondary : token.colorText,
        textDecoration: tone === "before" && !empty ? "line-through" : undefined,
        opacity: tone === "before" ? 0.75 : 1,
        wordBreak: "break-all",
      }}
    >
      {empty ? "not set" : value}
    </code>
  );
}

/** Small count chips summarising what a snapshot did. */
function SummaryChips({ s }: { s: TimelineEntry["summary"] }) {
  if (!s || s.total === 0) return null;
  const bits: { n: number; hex: string; label: string }[] = [
    { n: s.added, hex: "var(--c-ok)", label: "added" },
    { n: s.modified, hex: "var(--c-pending)", label: "changed" },
    { n: s.removed, hex: "var(--c-danger)", label: "removed" },
  ];
  return (
    <Space size={4} wrap>
      {bits
        .filter((b) => b.n > 0)
        .map((b) => (
          <span key={b.label} style={{ fontSize: 11.5, color: b.hex, fontWeight: 600 }}>
            {b.n} {b.label}
          </span>
        ))}
    </Space>
  );
}

export default function EvolutionTimeline({ grid }: { grid: Grid }) {
  const { message } = AntApp.useApp();
  const { token } = antdTheme.useToken();
  const qc = useQueryClient();
  const { selectedInstance, selectInstance, setSection } = useUI();
  const [open, setOpen] = useState<string | null>(null);

  // The instance scope doubles as the app-wide instance deep link (?inst=), so
  // arriving from another view keeps its context.
  const instance = selectedInstance ?? "";

  // History only moves when someone commits, and the service now memoizes each
  // snapshot by commit, so re-reading it on every visit (the 5 s default) spent
  // a round trip to be told the same thing. keepPreviousData holds the current
  // list on screen while a scope switch loads, instead of blanking to a
  // skeleton and back.
  const timelineQ = useRepoQuery({
    queryKey: ["timeline", instance],
    queryFn: () => api.timeline({ instance: instance || undefined, limit: 20 }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const restore = useMutation({
    mutationFn: (p: { ref: string; scope: RestoreScope; instance?: string; paramId?: string; global?: boolean }) =>
      api.restore(p),
    onSuccess: (res) => {
      if (res.applied === 0) {
        message.info(
          res.skipped.length
            ? `Nothing to restore. ${res.skipped.length} item(s) could not be brought back.`
            : "Everything already matches that snapshot, so there is nothing to change.",
        );
        return;
      }
      const skipped = res.skipped.length ? ` ${res.skipped.length} item(s) were skipped.` : "";
      message.success(
        `${res.applied} value(s) staged in your draft. Review and publish them to make the rollback live.${skipped}`,
      );
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const snapshots = timelineQ.data?.snapshots ?? [];
  const supported = timelineQ.data?.supported !== false;

  if (!supported) {
    return (
      <div style={{ padding: 24 }}>
        <StatePanel
          art={<InSyncArt />}
          title="The timeline needs a local repository"
          subtitle="This application is served straight from its hosted repository, which cannot provide a commit history here. Connect it as a local repository to browse and roll back snapshots."
        />
      </div>
    );
  }

  const scopeLabel = instance || "the whole application";

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "16px 20px 40px" }}>
      {/* Scope: the one control that decides what the whole page is about. */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
        <Segmented
          value={instance ? "instance" : "all"}
          onChange={(v) => {
            setOpen(null);
            selectInstance(v === "all" ? null : (grid.instances[0]?.name ?? null));
          }}
          options={[
            { label: "Whole application", value: "all", icon: <GlobalOutlined /> },
            { label: "One instance", value: "instance", icon: <ClusterOutlined /> },
          ]}
        />
        {instance && (
          <Select
            value={instance}
            style={{ minWidth: 200 }}
            onChange={(v) => {
              setOpen(null);
              selectInstance(v);
            }}
            options={grid.instances.map((i) => ({ label: i.name, value: i.name }))}
          />
        )}
        <Tooltip title="Check for new snapshots">
          <Button
            icon={<ReloadOutlined />}
            loading={timelineQ.isFetching}
            onClick={() => timelineQ.refetch()}
          />
        </Tooltip>
      </div>
      <Text type="secondary" style={{ fontSize: 12.5, display: "block", marginBottom: 16 }}>
        How the configuration of {scopeLabel} changed over time, newest first. Open a snapshot to see
        exactly which parameters moved. Anything you bring back is staged in your draft for review -
        nothing changes until you publish it.
      </Text>

      {/* The scope control and the explanation are on screen immediately; only
          the list waits. Skeletoning the whole page meant the chrome the user
          is about to reach for arrived last. */}
      {timelineQ.isLoading ? (
        <TableSkeleton />
      ) : snapshots.length === 0 ? (
        <Empty description={`No configuration changes recorded yet for ${scopeLabel}.`} />
      ) : (
        <div style={{ position: "relative" }}>
          {/* The spine every dot hangs from. */}
          <div
            style={{
              position: "absolute",
              left: 15,
              top: 12,
              bottom: 12,
              width: 2,
              background: token.colorBorderSecondary,
            }}
          />
          {snapshots.map((s) => (
            <SnapshotRow
              key={s.sha}
              entry={s}
              instance={instance}
              expanded={open === s.sha}
              onToggle={() => setOpen(open === s.sha ? null : s.sha)}
              onRestore={(p) => restore.mutate(p)}
              restoring={restore.isPending}
              onOpenDraft={() => setSection("config")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One dot on the spine, plus its opened detail. */
function SnapshotRow({
  entry,
  instance,
  expanded,
  onToggle,
  onRestore,
  restoring,
  onOpenDraft,
}: {
  entry: TimelineEntry;
  instance: string;
  expanded: boolean;
  onToggle: () => void;
  onRestore: (p: { ref: string; scope: RestoreScope; instance?: string; paramId?: string; global?: boolean }) => void;
  restoring: boolean;
  onOpenDraft: () => void;
}) {
  const { token } = antdTheme.useToken();
  // Reading the history is for everyone; restoring stages a draft, so it is an
  // editor action.
  const { canEdit } = useIdentity();
  const meta = kindMeta[entry.kind] ?? kindMeta.none;
  const scope: RestoreScope = instance ? "instance" : "all";
  const scopeWords = instance ? `instance ${instance}` : "every instance";

  return (
    <div style={{ position: "relative", paddingLeft: 44, marginBottom: 10 }}>
      {/* The dot: color and icon carry the kind of change at a glance. */}
      <div
        style={{
          position: "absolute",
          left: 4,
          top: 12,
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: token.colorBgContainer,
          border: `2px solid ${meta.hex}`,
          color: meta.hex,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
        }}
      >
        {meta.icon}
      </div>

      <div
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadius,
          background: token.colorBgContainer,
          padding: "10px 12px",
        }}
      >
        {/* Header line: what happened, by whom, when. The whole line toggles. */}
        <div
          onClick={onToggle}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle();
            }
          }}
          style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}
        >
          <span style={{ color: token.colorTextTertiary, fontSize: 10, marginTop: 4 }}>
            {expanded ? <DownOutlined /> : <RightOutlined />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Tag color="default" style={{ borderColor: meta.hex, color: meta.hex, marginInlineEnd: 0 }}>
                {meta.label}
              </Tag>
              <Text strong style={{ fontSize: 13.5 }}>
                {entry.message}
              </Text>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              <UserAvatar name={entry.author} size={18} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {entry.author} · {relTime(entry.date)} · <code style={{ fontSize: 11 }}>{entry.short}</code>
              </Text>
              <SummaryChips s={entry.summary} />
            </div>
            {/* Version moves are the headline a fleet operator scans for. */}
            {(entry.versions ?? []).length > 0 && (
              <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(entry.versions ?? []).map((v) => (
                  <Tag key={v.instance} color="purple" style={{ marginInlineEnd: 0 }}>
                    {v.instance}: {v.from || "none"} → {v.to || "none"}
                  </Tag>
                ))}
              </div>
            )}
            {(entry.structure ?? []).length > 0 && (
              <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(entry.structure ?? []).map((m) => (
                  <Tag
                    key={m.instance}
                    color={m.action === "added" ? "green" : "red"}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {m.instance} {m.action === "added" ? "added" : "retired"}
                  </Tag>
                ))}
              </div>
            )}
            {/* Which instances this snapshot touched, when looking at them all. */}
            {!instance && (entry.instances ?? []).length > 0 && (
              <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
                {(entry.instances ?? []).map((n) => (
                  <Tag key={n} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                    {n}
                  </Tag>
                ))}
              </div>
            )}
          </div>

          {/* Going back to this exact state, at the current scope. */}
          {canEdit && (
          <div onClick={(e) => e.stopPropagation()}>
            <Popconfirm
              title={`Restore ${instance || "the whole application"} to this point?`}
              description={
                <span style={{ maxWidth: 320, display: "inline-block" }}>
                  Brings the configuration of {scopeWords} back to how it looked at this snapshot. The
                  edits are staged in your draft to review - nothing changes until you publish.
                </span>
              }
              okText="Stage restore"
              onConfirm={() => onRestore({ ref: entry.sha, scope, instance: instance || undefined })}
            >
              <Tooltip title="Bring the configuration back to how it looked here">
                <Button size="small" icon={<HistoryOutlined />} loading={restoring}>
                  Restore to here
                </Button>
              </Tooltip>
            </Popconfirm>
          </div>
          )}
        </div>

        {expanded && (
          <SnapshotDetail
            sha={entry.sha}
            previous={entry.previous ?? ""}
            instance={instance}
            onRestore={onRestore}
            restoring={restoring}
            onOpenDraft={onOpenDraft}
          />
        )}
      </div>
    </div>
  );
}

/** The opened snapshot: every parameter that moved, each undoable on its own. */
function SnapshotDetail({
  sha,
  previous,
  instance,
  onRestore,
  restoring,
  onOpenDraft,
}: {
  sha: string;
  previous: string;
  instance: string;
  onRestore: (p: { ref: string; scope: RestoreScope; instance?: string; paramId?: string; global?: boolean }) => void;
  restoring: boolean;
  onOpenDraft: () => void;
}) {
  const { token } = antdTheme.useToken();
  // Every "undo" below stages a draft, so all of them need edit access; the
  // snapshot itself reads for anyone.
  const { canEdit } = useIdentity();
  // What changed AT a commit cannot change: the commit is immutable and so is
  // its comparison against the one before it. Cache it for the session, so
  // collapsing and reopening a snapshot is free.
  const detailQ = useRepoQuery({
    queryKey: ["timeline-snapshot", sha, instance],
    queryFn: () => api.timelineSnapshot(sha, { instance: instance || undefined, limit: 20 }),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });

  if (detailQ.isLoading) {
    return (
      <div style={{ padding: "14px 4px", color: token.colorTextTertiary, fontSize: 12.5 }}>
        <LoadingOutlined /> Reading what changed…
      </div>
    );
  }
  if (detailQ.isError) {
    return (
      <div style={{ padding: "14px 4px", color: token.colorError, fontSize: 12.5 }}>
        Could not read this snapshot: {(detailQ.error as Error).message}
      </div>
    );
  }

  const changes = detailQ.data?.changes ?? [];
  if (changes.length === 0) {
    return (
      <div style={{ padding: "14px 4px", color: token.colorTextTertiary, fontSize: 12.5 }}>
        No parameter values changed at this snapshot.
        {previous === "" && " This is the earliest snapshot in view, so there is nothing to compare it against."}
      </div>
    );
  }

  // Group by instance so a fleet-wide change reads instance by instance - and
  // so one instance can be rolled back without touching its siblings.
  const groups = new Map<string, CellChange[]>();
  for (const c of changes) {
    const key = c.instance ?? "";
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  const groupKeys = Array.from(groups.keys()).sort();

  // Undoing means going back to the state BEFORE this snapshot. Without a
  // predecessor in view there is nothing to go back to.
  const canUndo = canEdit && previous !== "";

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${token.colorBorderSecondary}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {changes.length} parameter change(s) at this snapshot
        </Text>
        {canUndo && (
          <Popconfirm
            title="Undo this entire change?"
            description={
              <span style={{ maxWidth: 320, display: "inline-block" }}>
                Puts every value below back to what it was before this snapshot. Staged in your draft
                to review - nothing changes until you publish.
              </span>
            }
            okText="Stage undo"
            onConfirm={() =>
              onRestore({
                ref: previous,
                scope: instance ? "instance" : "all",
                instance: instance || undefined,
              })
            }
          >
            <Button size="small" danger icon={<RollbackOutlined />} loading={restoring}>
              Undo this change
            </Button>
          </Popconfirm>
        )}
      </div>

      {groupKeys.map((key) => (
        <div key={key || "__global__"} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Text strong style={{ fontSize: 12.5 }}>
              {key === "" ? (
                <>
                  <GlobalOutlined /> Shared by every instance
                </>
              ) : (
                <>
                  <ClusterOutlined /> {key}
                </>
              )}
            </Text>
            {/* Rolling back exactly one instance out of a fleet-wide change. */}
            {canUndo && key !== "" && !instance && (
              <Popconfirm
                title={`Undo this change for ${key} only?`}
                description={
                  <span style={{ maxWidth: 320, display: "inline-block" }}>
                    Puts {key} back to how it was before this snapshot and leaves every other instance
                    exactly as it is. Staged in your draft to review.
                  </span>
                }
                okText="Stage undo"
                onConfirm={() => onRestore({ ref: previous, scope: "instance", instance: key })}
              >
                <Tooltip title={`Roll back only ${key}, leaving other instances untouched`}>
                  <Button size="small" type="text" icon={<RollbackOutlined />} loading={restoring}>
                    Undo for {key}
                  </Button>
                </Tooltip>
              </Popconfirm>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {(groups.get(key) ?? []).map((c) => {
              const sm = statusMeta[c.status];
              return (
                <div
                  key={c.paramId + "|" + (c.instance ?? "")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 8px",
                    borderRadius: token.borderRadiusSM,
                    background: token.colorFillQuaternary,
                    flexWrap: "wrap",
                  }}
                >
                  <Tooltip title={sm.label}>
                    <span style={{ color: sm.hex, fontSize: 12, display: "inline-flex" }}>{sm.icon}</span>
                  </Tooltip>
                  <Text style={{ fontSize: 12.5, minWidth: 160, flex: "0 1 auto" }}>{c.name || c.paramId}</Text>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                    <ValueChip value={c.before} tone="before" />
                    <span style={{ color: token.colorTextTertiary, fontSize: 11 }}>→</span>
                    <ValueChip value={c.after} tone="after" />
                  </span>
                  {/* One parameter, one instance, back to its earlier value. */}
                  {canUndo && (
                    <Popconfirm
                      title="Put this value back?"
                      description={
                        <span style={{ maxWidth: 320, display: "inline-block" }}>
                          Sets {c.name || c.paramId}
                          {c.instance ? ` on ${c.instance}` : " (shared)"} back to{" "}
                          <code>{c.before === "" ? "not set" : c.before}</code>. Staged in your draft to
                          review.
                        </span>
                      }
                      okText="Stage undo"
                      onConfirm={() =>
                        onRestore({
                          ref: previous,
                          scope: "parameter",
                          paramId: c.paramId,
                          instance: c.instance || undefined,
                          global: !c.instance,
                        })
                      }
                    >
                      <Tooltip title={`Set back to ${c.before === "" ? "not set" : c.before}`}>
                        <Button size="small" type="text" icon={<RollbackOutlined />} loading={restoring} />
                      </Tooltip>
                    </Popconfirm>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <Button size="small" type="link" style={{ paddingInline: 0 }} onClick={onOpenDraft}>
        Review staged changes in the editor
      </Button>
    </div>
  );
}
