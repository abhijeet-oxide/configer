import {
  Button,
  Empty,
  Popconfirm,
  Segmented,
  Select,
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
  TagOutlined,
  CheckOutlined,
  BranchesOutlined,
} from "../icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import {
  api,
  type Grid,
  type TimelineEntry,
  type SnapshotKind,
  type CellChange,
  type RestoreScope,
  type ChangeRequest,
  type ChangeState,
} from "../api";
import { useUI } from "../store";
import { relTime } from "./DashboardView";
import { StatePanel, InSyncArt } from "./illustrations";
import UserAvatar from "./UserAvatar";
import ValueDiff from "./ui/ValueDiff";
import GraphRail, { layoutGraph, ROW_H, type GraphInput, type RailRow } from "./GraphRail";
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

/** The colour a change in flight is drawn in, matching the status vocabulary
 *  the rest of the product uses: a draft is pending, a review is under way, an
 *  approved change is ready. */
function stateColor(state: ChangeState): string {
  if (state === "draft") return "var(--c-pending)";
  if (state === "approved") return "var(--c-ok)";
  return "var(--c-review)";
}

function stateWords(state: ChangeState): string {
  if (state === "draft") return "Your draft, not sent for review yet";
  if (state === "approved") return "Approved, waiting to be published";
  return "Under review";
}

export default function EvolutionTimeline({ grid }: { grid: Grid }) {
  const { message } = AntApp.useApp();
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

  // Changes that have LEFT the trunk but not landed on it: the draft being
  // written right now, and anything waiting on a reviewer. They are the part of
  // the picture a commit list cannot contain - a commit list only knows what
  // already happened - and leaving them out was why the timeline could show an
  // application as quiet while two changes were in flight against it.
  const changesQ = useRepoQuery({
    queryKey: ["changes"],
    queryFn: api.changes,
    refetchInterval: 20_000,
  });
  const inFlight = useMemo(
    () =>
      (changesQ.data ?? [])
        .filter((c) => c.state === "draft" || c.state === "under_review" || c.state === "approved")
        .filter((c) => (c.items?.length ?? 0) > 0)
        .filter((c) => !instance || (c.items ?? []).some((it) => it.instance === instance))
        .sort((a, b) => b.id - a.id),
    [changesQ.data, instance],
  );

  const snapshots = useMemo(() => timelineQ.data?.snapshots ?? [], [timelineQ.data]);
  const supported = timelineQ.data?.supported !== false;

  // One list, newest first: the changes still in flight, then the commits that
  // landed. Every row is a node in one graph, so an open change is expressed as
  // a node whose parent is the commit it branched from - which is what it is.
  const graph = useMemo(() => {
    const tip = snapshots[0]?.sha ?? "";
    const inputs: GraphInput[] = [
      ...inFlight.map((c) => ({
        sha: `cr:${c.id}`,
        parents: tip ? [tip] : [],
        open: true,
        color: stateColor(c.state),
      })),
      ...snapshots.map((snap) => ({
        sha: snap.sha,
        // Only parents that are IN VIEW can be drawn; a parent scrolled off the
        // end of the window would otherwise hold a lane open forever.
        parents: (snap.parents ?? []).filter((p) => snapshots.some((o) => o.sha === p)),
      })),
    ];
    return layoutGraph(inputs);
  }, [inFlight, snapshots]);

  const total = inFlight.length + snapshots.length;

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
      ) : total === 0 ? (
        <Empty description={`No configuration changes recorded yet for ${scopeLabel}.`} />
      ) : (
        <div className="gg">
          {/* Changes still in flight come first: they are the newest thing that
              has happened, and they are above the tip they branched from. */}
          {inFlight.map((cr, i) => (
            <GraphRow
              key={`cr-${cr.id}`}
              rail={graph.rows[i]}
              lanes={graph.lanes}
              first={i === 0}
              last={false}
            >
              <InFlightRow cr={cr} onOpen={() => setSection(cr.state === "draft" ? "config" : "approvals")} />
            </GraphRow>
          ))}
          {snapshots.map((s, i) => {
            const idx = inFlight.length + i;
            return (
              <GraphRow
                key={s.sha}
                rail={graph.rows[idx]}
                lanes={graph.lanes}
                first={idx === 0}
                last={idx === total - 1}
                detail={
                  open === s.sha ? (
                    <SnapshotDetail
                      entry={s}
                      instance={instance}
                      onRestore={(p) => restore.mutate(p)}
                      restoring={restore.isPending}
                      onOpenDraft={() => setSection("config")}
                    />
                  ) : null
                }
              >
                <SnapshotRow
                  entry={s}
                  expanded={open === s.sha}
                  onToggle={() => setOpen(open === s.sha ? null : s.sha)}
                />
              </GraphRow>
            );
          })}
        </div>
      )}
    </div>
  );
}

// GraphRow ties one rail slice to one row of content. The rail is a sibling of
// the row rather than a background under it, and neither carries a margin, so
// the lanes tile into one continuous picture - the gaps in the earlier version
// were the spacing between cards, which nothing was drawing through.
function GraphRow({
  rail,
  lanes,
  first,
  last,
  detail,
  children,
}: {
  rail?: RailRow;
  lanes: number;
  first: boolean;
  last: boolean;
  /** opened content, shown under the row; the rail grows to cover it */
  detail?: React.ReactNode;
  children: React.ReactNode;
}) {
  const detailRef = useRef<HTMLDivElement>(null);
  const [extra, setExtra] = useState(0);
  // The rail is one SVG per row, so when a row opens it has to be told how much
  // taller to draw. Measured rather than guessed: the detail's height depends
  // on how many parameters moved.
  useEffect(() => {
    if (!detail) {
      setExtra(0);
      return;
    }
    const el = detailRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setExtra(el.offsetHeight));
    ro.observe(el);
    setExtra(el.offsetHeight);
    return () => ro.disconnect();
  }, [detail]);

  if (!rail) return null;
  return (
    <div style={{ display: "flex", alignItems: "flex-start" }}>
      <GraphRail row={rail} lanes={lanes} first={first} last={last} height={ROW_H + extra} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {children}
        {detail && <div ref={detailRef}>{detail}</div>}
      </div>
    </div>
  );
}

/** One dot on the spine, plus its opened detail. */
function SnapshotRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: TimelineEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = kindMeta[entry.kind] ?? kindMeta.none;
  const merge = (entry.parents?.length ?? 0) > 1;
  return (
    <div
      className={`gg-row${expanded ? " is-open" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      style={{ ["--gg-accent" as string]: meta.hex }}
    >
      <span className="gg-caret">{expanded ? <DownOutlined /> : <RightOutlined />}</span>
      <Tooltip title={meta.label}>
        <span className="gg-kind" style={{ color: meta.hex }}>{meta.icon}</span>
      </Tooltip>
      <span className="gg-subject" title={entry.message}>
        {entry.message}
      </span>
      <Refs names={entry.refs} />
      {merge && (
        <Tooltip title="A merge: this commit brought another line of work in">
          <Tag className="gg-tag" bordered={false}>merge</Tag>
        </Tooltip>
      )}
      <span className="gg-spacer" />
      <Counts values={entry.summary?.total ?? 0} files={entry.files ?? 0} />
      <UserAvatar name={entry.author} size={18} />
      <span className="gg-author" title={entry.author}>{entry.author}</span>
      <Tooltip title={new Date(entry.date).toLocaleString()}>
        <span className="gg-when">{relTime(entry.date)}</span>
      </Tooltip>
      <Sha sha={entry.sha} short={entry.short} />
    </div>
  );
}

/** Tag and branch names sitting on a commit, in git's own vocabulary. */
function Refs({ names }: { names?: string[] }) {
  if (!names?.length) return null;
  return (
    <>
      {names.map((n) => (
        <Tooltip key={n} title={`Tagged ${n}`}>
          <span className="gg-ref">
            <TagOutlined style={{ fontSize: 9 }} /> {n}
          </span>
        </Tooltip>
      ))}
    </>
  );
}

/** How big the change was, in both currencies: parameters and files. */
function Counts({ values, files }: { values: number; files: number }) {
  if (!values && !files) return null;
  return (
    <Tooltip title={`${values} value${values === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"}`}>
      <span className="gg-counts">
        {values > 0 && <span className="gg-count">{values}v</span>}
        {files > 0 && <span className="gg-count gg-count-files">{files}f</span>}
      </span>
    </Tooltip>
  );
}

// Sha shows the short id and copies the full one. A truncated id is enough to
// recognize a commit and useless for doing anything with it, and nobody should
// be retyping forty hex characters off a screen.
function Sha({ sha, short }: { sha: string; short: string }) {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);
  if (!sha) return null;
  const copy = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(sha);
    setCopied(true);
    message.success("Commit id copied");
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <Tooltip title={<span className="mono">{sha}</span>}>
      <span
        role="button"
        tabIndex={0}
        className={`gg-sha${copied ? " is-copied" : ""}`}
        onClick={copy}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") copy(e);
        }}
      >
        {copied ? <CheckOutlined style={{ fontSize: 10 }} /> : short}
      </span>
    </Tooltip>
  );
}

// InFlightRow is a change that has branched off the trunk and not landed: the
// draft being written right now, or one waiting on a reviewer. It reads on the
// same line grid as a commit so the eye runs straight down, and its colour says
// which of those it is.
function InFlightRow({ cr, onOpen }: { cr: ChangeRequest; onOpen: () => void }) {
  const color = stateColor(cr.state);
  const n = cr.items?.length ?? 0;
  return (
    <div
      className="gg-row gg-row-open"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{ ["--gg-accent" as string]: color }}
    >
      <span className="gg-caret" />
      <Tooltip title={stateWords(cr.state)}>
        <span className="gg-state" style={{ color, borderColor: color }}>
          {cr.number ? `CR-${cr.number}` : "draft"}
        </span>
      </Tooltip>
      <span className="gg-subject" title={cr.title}>
        {cr.title === "Draft changes" ? "Unnamed draft" : cr.title}
      </span>
      {cr.category && <Tag className="gg-tag" bordered={false}>{cr.category}</Tag>}
      {cr.reference && <span className="gg-ref">{cr.reference}</span>}
      <span className="gg-spacer" />
      <Tooltip title={`${n} pending change${n === 1 ? "" : "s"}, not committed yet`}>
        <span className="gg-counts"><span className="gg-count">{n}v</span></span>
      </Tooltip>
      <UserAvatar name={cr.author} size={18} />
      <span className="gg-author" title={cr.author}>{cr.author}</span>
      <Tooltip title={new Date(cr.updatedAt ?? cr.createdAt).toLocaleString()}>
        <span className="gg-when">{relTime(cr.updatedAt ?? cr.createdAt)}</span>
      </Tooltip>
      {cr.branch ? (
        <Tooltip title={`On branch ${cr.branch}`}>
          <span className="gg-branch"><BranchesOutlined style={{ fontSize: 9 }} /> {cr.branch.split("/").pop()}</span>
        </Tooltip>
      ) : (
        <Tooltip title="A branch is created when this is submitted for review">
          <span className="gg-branch is-muted">no branch yet</span>
        </Tooltip>
      )}
    </div>
  );
}

/** The opened snapshot: every parameter that moved, each undoable on its own. */
function SnapshotDetail({
  entry,
  instance,
  onRestore,
  restoring,
  onOpenDraft,
}: {
  entry: TimelineEntry;
  instance: string;
  onRestore: (p: { ref: string; scope: RestoreScope; instance?: string; paramId?: string; global?: boolean }) => void;
  restoring: boolean;
  onOpenDraft: () => void;
}) {
  const sha = entry.sha;
  const previous = entry.previous ?? "";
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

  const scope: RestoreScope = instance ? "instance" : "all";
  const scopeWords = instance ? `instance ${instance}` : "every instance";

  // The panel always leads with the context that did not fit on the row: what
  // this commit said, which instances and versions it moved, and the way back
  // to it. The body below is the parameter detail, which has to be fetched.
  const header = (
    <div className="gg-detail-head">
      <div className="gg-detail-msg">{entry.message}</div>
      <div className="gg-detail-meta">
        {(entry.versions ?? []).map((v) => (
          <Tag key={v.instance} color="purple" className="gg-tag">
            {v.instance}: {v.from || "none"} → {v.to || "none"}
          </Tag>
        ))}
        {(entry.structure ?? []).map((m) => (
          <Tag key={m.instance} color={m.action === "added" ? "green" : "red"} className="gg-tag">
            {m.instance} {m.action === "added" ? "added" : "retired"}
          </Tag>
        ))}
        {!instance &&
          (entry.instances ?? []).map((n) => (
            <Tag key={n} className="gg-tag">{n}</Tag>
          ))}
      </div>
      {canEdit && (
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
      )}
    </div>
  );

  if (detailQ.isLoading) {
    return (
      <div className="gg-detail">
        {header}
        <div className="gg-detail-note">
          <LoadingOutlined /> Reading what changed…
        </div>
      </div>
    );
  }
  if (detailQ.isError) {
    return (
      <div className="gg-detail">
        {header}
        <div className="gg-detail-note" style={{ color: token.colorError }}>
          Could not read this snapshot: {(detailQ.error as Error).message}
        </div>
      </div>
    );
  }

  const changes = detailQ.data?.changes ?? [];
  if (changes.length === 0) {
    return (
      <div className="gg-detail">
        {header}
        <div className="gg-detail-note">
          No parameter values changed at this snapshot.
          {previous === "" && " This is the earliest snapshot in view, so there is nothing to compare it against."}
        </div>
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
    <div className="gg-detail">
      {header}
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
                    {/* History answers "what did that commit actually do", which
                        needs the changed characters, not two long values to
                        compare by eye. Same diff as the review surfaces. */}
                    <ValueDiff before={c.before} after={c.after} label={c.name || c.paramId} />
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
