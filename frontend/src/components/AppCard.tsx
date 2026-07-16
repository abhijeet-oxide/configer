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
      className="card-clickable"
      onClick={onOpen}
      role="button"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        boxShadow: "var(--el-1)",
        padding: "var(--sp-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        cursor: "pointer",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontSize: "var(--fs-14)",
            fontWeight: 600,
            color: "var(--brand)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {r.name}
        </span>
        <span style={{ color: "var(--text-3)", flexShrink: 0 }}>
          {r.local ? <HddOutlined /> : <GithubOutlined />}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {r.branch && <MonoChip icon={<BranchesOutlined style={{ fontSize: 10 }} />}>{r.branch}</MonoChip>}
        <SyncPill r={r} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--fs-12)" }}>
        <span style={{ color: "var(--c-review)", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <ClusterOutlined style={{ fontSize: 11 }} />
          {r.instances} instance{r.instances === 1 ? "" : "s"}
        </span>
        <span style={{ display: "inline-flex", gap: 12 }}>
          <span style={{ color: r.openChanges > 0 ? "var(--c-pending)" : "var(--text-3)" }}>
            ● {r.openChanges} change{r.openChanges === 1 ? "" : "s"}
          </span>
          <span style={{ color: r.drafts > 0 ? "var(--c-review)" : "var(--text-3)" }}>
            ● {r.drafts > 0 ? "draft edits" : "0 edits"}
          </span>
        </span>
      </div>
      <div style={{ fontSize: "var(--fs-11)", color: "var(--text-3)", marginTop: "auto" }}>
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
      className="card-clickable"
      onClick={onOpen}
      style={{
        background: "var(--surface)",
        border: `1px solid ${active ? "var(--brand-border)" : "var(--border)"}`,
        borderRadius: "var(--r-lg)",
        boxShadow: "var(--el-1)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        cursor: "pointer",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ fontSize: 20, color: "var(--text-3)", marginTop: 2 }}>
          {r.local ? <HddOutlined /> : <GithubOutlined />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong style={{ fontSize: 14.5 }}>
            {r.name}
          </Typography.Text>
          <div
            className="mono"
            style={{ fontSize: 11, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
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
      <div
        style={{ marginTop: "auto", display: "flex", justifyContent: "flex-end", gap: 6 }}
        onClick={(e) => e.stopPropagation()}
      >
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
