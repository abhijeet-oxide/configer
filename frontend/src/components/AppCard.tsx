import { Button, Dropdown, Space, Tooltip, Typography } from "antd";
import {
  BranchesOutlined,
  ClusterOutlined,
  GithubOutlined,
  HddOutlined,
  InfoCircleOutlined,
  MoreOutlined,
  RightOutlined,
  StarOutlined,
  StarFilled,
} from "../icons";
import type { RepoSummary } from "../api";
import { InlineNotice, StatusPill } from "./ui";
import EnvTag from "./EnvTag";
import { relTime } from "./DashboardView";
import { sentence } from "../notify";

// AppCard renders one application in the collection. Two variants share the
// same data story: "full" is the Applications page card (actions, favorite,
// environments); "home" is the compact card on the operational start page.

export function SyncPill({ r }: { r: RepoSummary }) {
  // A connection that is still running, or that failed, is about the
  // APPLICATION itself rather than its sync state, and outranks everything
  // else the pill could say.
  if (r.status === "connecting") return <StatusPill tone="pending">Connecting…</StatusPill>;
  if (r.status === "opening") return <StatusPill tone="pending">Opening…</StatusPill>;
  if (r.status === "error") return <StatusPill tone="danger">Not connected</StatusPill>;
  if (r.error) return <StatusPill tone="danger">Unavailable</StatusPill>;
  if (r.syncError)
    return (
      <Tooltip title={r.syncError}>
        <span style={{ display: "inline-flex" }}>
          <StatusPill tone="pending">Sync issue</StatusPill>
        </span>
      </Tooltip>
    );
  if ((r.behind ?? 0) > 0) return <StatusPill tone="pending">{r.behind} behind</StatusPill>;
  // A local-only repo needs no badge: "Local" was pure noise repeated on every
  // card. Sync state is shown only when there is a remote to be in/out of step
  // with.
  if (!r.remote && r.local) return null;
  return <StatusPill tone="ok">Git synced</StatusPill>;
}

// AccessPill says what the CALLER can do in this application, and where that
// came from. It belongs on the card, not next to the person's name: the same
// engineer is an approver on one application and a reader on the next, so one
// label on a profile is always wrong for some of them.
export function AccessPill({ r }: { r: RepoSummary }) {
  if (!r.role || r.roleSource === "single-user") return null;
  const tone = r.role === "viewer" ? "neutral" : r.role === "editor" ? "review" : "ok";
  const label = r.role === "viewer" ? "View only" : r.role === "editor" ? "Can edit" : "Can publish";
  const why =
    r.roleSource === "git"
      ? "This mirrors your permission on the repository in GitHub."
      : r.roleSource === "admin"
        ? "You are an administrator of this Configer deployment."
        : r.roleSource === "configer"
          ? "An administrator granted you this access in Configer."
          : "This deployment's default access.";
  return (
    <Tooltip title={why}>
      <span style={{ display: "inline-flex" }}>
        <StatusPill tone={tone as "neutral" | "review" | "ok"}>{label}</StatusPill>
      </span>
    </Tooltip>
  );
}

// The compact Home variant: name, branch, instances, waiting work, updated.
export function HomeAppCard({ r, onOpen }: { r: RepoSummary; onOpen: () => void }) {
  return (
    <div
      className="card-clickable flex min-w-0 cursor-pointer flex-col gap-2 rounded-card bg-surface p-4 shadow-neu"
      onClick={onOpen}
      role="button"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex-1 overflow-hidden text-sm font-semibold text-ellipsis whitespace-nowrap text-brand">
          {r.name}
        </span>
        <span className="shrink-0 text-ink-3">
          {r.local ? <HddOutlined /> : <GithubOutlined />}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {r.branch && (
          <span className="mono inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-ink-3">
            <BranchesOutlined style={{ fontSize: 10 }} />
            {r.branch}
          </span>
        )}
        <SyncPill r={r} />
        <AccessPill r={r} />
      </div>
      <div className="flex flex-col gap-1 text-xs">
        <span className="inline-flex items-center gap-1.5 text-review">
          <ClusterOutlined style={{ fontSize: 11 }} />
          {r.instances} instance{r.instances === 1 ? "" : "s"}
        </span>
        <span className="inline-flex gap-3">
          <span style={{ color: r.openChanges > 0 ? "var(--c-pending)" : "var(--text-3)" }}>
            ● {r.openChanges} change{r.openChanges === 1 ? "" : "s"}
          </span>
          <span style={{ color: r.drafts > 0 ? "var(--c-review)" : "var(--text-3)" }}>
            ● {r.drafts > 0 ? `${r.drafts} in draft` : "0 in draft"}
          </span>
        </span>
      </div>
      <div className="mt-auto text-[11px] text-ink-3">
        {r.addedAt ? `Added ${relTime(r.addedAt)}` : r.project && r.project !== r.name ? r.project : " "}
      </div>
    </div>
  );
}

// The full Applications-page variant (moved from WorkspaceView, restyled with
// the design-layer chips; behavior unchanged).
export default function AppCard({
  r,
  active,
  fav,
  onToggleFav,
  onOpen,
  onDetails,
  onEdit,
  onImport,
  onDisconnect,
}: {
  r: RepoSummary;
  active: boolean;
  fav: boolean;
  onToggleFav: () => void;
  /** go inside: the application's Configuration page */
  onOpen: () => void;
  /** open the details side panel (the info button) */
  onDetails: () => void;
  onEdit: () => void;
  onImport: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div
      className={`card-clickable flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-card bg-surface p-3.5 shadow-neu ${
        active ? "ring-1 ring-brand-border" : ""
      }`}
      onClick={onOpen}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div className="mt-0.5 text-xl text-ink-3">
          {r.local ? <HddOutlined /> : <GithubOutlined />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong style={{ fontSize: 14.5 }}>
            {r.name}
          </Typography.Text>
          <div className="mono overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-ink-3">
            {r.origin}
          </div>
        </div>
        <span onClick={(e) => e.stopPropagation()}>
          <Tooltip title={fav ? "Unpin from favorites" : "Mark as favorite (pinned first)"}>
            <Button
              size="small"
              type="text"
              icon={fav ? <StarFilled style={{ color: "var(--c-pending)" }} /> : <StarOutlined />}
              onClick={onToggleFav}
            />
          </Tooltip>
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <Dropdown
            trigger={["click"]}
            menu={{
              // Only what this role can actually do here. Disconnecting an
              // application is the approver's call, like publishing.
              items: [
                { key: "open", label: "Open configuration" },
                ...(r.role && r.role !== "viewer"
                  ? [
                      { key: "edit", label: "Edit details" },
                      { key: "import", label: "Import settings" },
                    ]
                  : []),
                ...(!r.role || r.role === "approver"
                  ? [
                      { type: "divider" as const },
                      { key: "disconnect", danger: true, label: "Disconnect from workspace" },
                    ]
                  : []),
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === "open") onOpen();
                if (key === "edit") onEdit();
                if (key === "import") onImport();
                if (key === "disconnect") onDisconnect();
              },
            }}
          >
            <Button size="small" type="text" icon={<MoreOutlined />} />
          </Dropdown>
        </span>
      </div>

      {r.status === "connecting" ? (
        <InlineNotice tone="info">
          Reading the repository. This card updates itself when it is ready.
        </InlineNotice>
      ) : r.status === "opening" ? (
        // Not a problem and not a new connection: the application is already
        // connected, this server just has not needed it yet. Opening it is a
        // few seconds, and opening it happens by itself.
        <InlineNotice tone="info">
          Getting this application ready. It stays usable; this card updates itself.
        </InlineNotice>
      ) : r.status === "error" ? (
        // The message already says what happened and what to do; the Remove
        // button is right below it, so "remove it and try again" would only
        // repeat one of them and, when the fix is elsewhere, contradict it.
        <InlineNotice tone="danger">
          {sentence(r.error) || "This repository could not be connected."}
        </InlineNotice>
      ) : r.error ? (
        <InlineNotice tone="danger">{r.error}</InlineNotice>
      ) : r.needsSetup ? (
        <InlineNotice tone="warn">Not set up yet - open it to finish setup.</InlineNotice>
      ) : (
        <>
          <Space size={6} wrap>
            {active && <StatusPill tone="review">Active</StatusPill>}
            {r.branch && (
              <span className="mono inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-ink-3">
                <BranchesOutlined style={{ fontSize: 10 }} />
                {r.branch}
              </span>
            )}
            <SyncPill r={r} />
            <AccessPill r={r} />
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            {r.params} parameter{r.params === 1 ? "" : "s"} · {r.instances} instance{r.instances === 1 ? "" : "s"}
            {r.openChanges > 0 && (
              <>
                {" · "}
                <span style={{ color: "var(--c-review)", fontWeight: 600 }}>{r.openChanges} in review</span>
              </>
            )}
            {r.drafts > 0 && (
              <>
                {" · "}
                <span style={{ color: "var(--c-pending)", fontWeight: 600 }}>{r.drafts} in draft</span>
              </>
            )}
          </Typography.Text>
          <Space size={4} wrap style={{ minHeight: 22 }}>
            {Object.entries(r.environments ?? {})
              .sort()
              .map(([env, n]) => (
                <EnvTag key={env} env={env} count={n} />
              ))}
          </Space>
        </>
      )}
      {/* Footer actions: info opens the side panel; the arrow (like the card
          itself) goes straight inside the application. */}
      <div className="mt-auto flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
        {r.status ? (
          // Nothing to open: the one useful action on an application that is
          // not connected is to stop waiting for it.
          <Button size="small" danger disabled={r.status === "connecting"} onClick={onDisconnect}>
            Remove
          </Button>
        ) : (
          <>
            <Button size="small" icon={<InfoCircleOutlined />} onClick={onDetails}>
              Details
            </Button>
            <Button size="small" type="primary" ghost={!r.needsSetup} onClick={onOpen}>
              {r.needsSetup ? "Finish setup" : "Open"} <RightOutlined style={{ fontSize: 10 }} />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
