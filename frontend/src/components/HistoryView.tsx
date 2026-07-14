import { Typography, Empty, Tag, Skeleton, Avatar, Tooltip } from "antd";
import { BranchesOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { relTime } from "./DashboardView";

// HistoryView is the application History tab: a git-graph-style timeline of the
// commits that changed this application's configuration, newest first. It reads
// like the VS Code / GitHub commit graph, with a connected node rail on the
// left and identity + message on the right.

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// A deterministic soft color per author, so the same person keeps a color.
function authorColor(name: string): string {
  const colors = ["#2f6bff", "#6c3df4", "#0ca30c", "#eda100", "#d03b3b", "#0aa2c0", "#c2410c"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

export default function HistoryView() {
  const q = useQuery({ queryKey: ["history"], queryFn: () => api.history(60), refetchInterval: 30_000 });
  const commits = q.data?.commits ?? [];
  const supported = q.data?.supported ?? true;

  return (
    <div style={{ padding: "20px 28px", height: "100%", overflow: "auto" }}>
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 2 }}>
        History
      </Typography.Title>
      <Typography.Text type="secondary">
        Every change to this application's configuration, newest first. Each commit is one reviewed
        or attributed change to the canonical model.
      </Typography.Text>

      {q.isLoading ? (
        <Skeleton active style={{ marginTop: 24 }} />
      ) : !supported ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="History is available for repositories cloned or opened on the server. This application is managed through the GitHub API with no clone; view its history on GitHub."
          style={{ marginTop: 40 }}
        />
      ) : commits.length === 0 ? (
        <Empty description="No configuration history yet." style={{ marginTop: 40 }} />
      ) : (
        <div style={{ marginTop: 20, maxWidth: 900 }}>
          {commits.map((c, i) => {
            const last = i === commits.length - 1;
            const color = authorColor(c.author);
            return (
              <div key={c.sha} style={{ display: "flex", gap: 14, alignItems: "stretch" }}>
                {/* graph rail: node + connecting line */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 24 }}>
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      background: color,
                      border: "2px solid var(--ant-color-bg-container, #fff)",
                      boxShadow: `0 0 0 2px ${color}55`,
                      marginTop: 6,
                      flexShrink: 0,
                    }}
                  />
                  {!last && <span style={{ flex: 1, width: 2, background: "rgba(127,137,160,0.25)", marginTop: 2 }} />}
                </div>
                {/* commit content */}
                <div style={{ paddingBottom: 20, minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Typography.Text strong style={{ fontSize: 13.5 }}>
                      {c.message}
                    </Typography.Text>
                    <Tooltip title="Commit">
                      <Tag className="mono" style={{ fontSize: 11, margin: 0 }} icon={<BranchesOutlined />}>
                        {c.short}
                      </Tag>
                    </Tooltip>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
                    <Avatar size={20} style={{ background: color, fontSize: 10, flexShrink: 0 }}>
                      {initials(c.author)}
                    </Avatar>
                    <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                      {c.author} · {relTime(c.date)}
                    </Typography.Text>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
