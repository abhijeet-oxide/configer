import { Alert, Button, Dropdown, Space, Tooltip, Typography } from "antd";
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
} from "@ant-design/icons";
import type { RepoSummary } from "../api";
import { StatusPill, MonoChip } from "./ui";
import EnvTag from "./EnvTag";
import { relTime } from "./DashboardView";

// AppCard renders one application in the collection. Two variants share the
// same data story: "full" is the Applications page card (actions, favorite,
// environments); "home" is the compact card on the operational start page.

export function SyncPill({ r }: { r: RepoSummary }) {
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
  if (!r.remote && r.local) return <StatusPill tone="neutral">Local</StatusPill>;
  return <StatusPill tone="ok">Git synced</StatusPill>;
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
        {r.branch && <MonoChip icon={<BranchesOutlined style={{ fontSize: 10 }} />}>{r.branch}</MonoChip>}
        <SyncPill r={r} />
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
            ● {r.drafts > 0 ? "draft edits" : "0 edits"}
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
              items: [
                { key: "open", label: "Open configuration" },
                { key: "edit", label: "Edit details" },
                { key: "import", label: "Import settings" },
                { type: "divider" },
                { key: "disconnect", danger: true, label: "Disconnect from workspace" },
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

      {r.error ? (
        <Alert type="error" showIcon message={r.error} />
      ) : r.needsSetup ? (
        <Alert
          type="warning"
          showIcon
          message="Not set up yet"
          description="Configer hasn't scanned this repository into an application. Open it to finish setup."
        />
      ) : (
        <>
          <Space size={6} wrap>
            {active && <StatusPill tone="review">Active</StatusPill>}
            {r.branch && <MonoChip icon={<BranchesOutlined style={{ fontSize: 10 }} />}>{r.branch}</MonoChip>}
            <SyncPill r={r} />
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
                <span style={{ color: "var(--c-pending)", fontWeight: 600 }}>draft edits</span>
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
        <Tooltip title="Details: health, environments, recent activity">
          <Button size="small" icon={<InfoCircleOutlined />} onClick={onDetails} aria-label="Application details" />
        </Tooltip>
        <Button size="small" type="primary" ghost={!r.needsSetup} onClick={onOpen}>
          {r.needsSetup ? "Finish setup" : "Open"} <RightOutlined style={{ fontSize: 10 }} />
        </Button>
      </div>
    </div>
  );
}
