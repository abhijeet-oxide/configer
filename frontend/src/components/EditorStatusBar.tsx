import { Badge, Drawer, Tooltip, theme as antdTheme } from "antd";
import {
  BranchesOutlined,
  SyncOutlined,
  CloudDownloadOutlined,
  DiffOutlined,
  CheckCircleFilled,
  WarningFilled,
  CloudServerOutlined,
} from "@ant-design/icons";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Grid } from "../api";
import SourceControlPanel from "./SourceControlPanel";

// EditorStatusBar is the VS Code bottom bar for the config editor: branch name
// and remote state bottom-left, a one-click pull, a "changes" pill that opens
// the Source Control view, and a live validity readout on the right. It makes
// the Git reality visible to anyone who wants it, without demanding they learn
// Git to edit a value.

export default function EditorStatusBar({ grid }: { grid: Grid }) {
  const { token } = antdTheme.useToken();
  const qc = useQueryClient();
  const [scmOpen, setScmOpen] = useState(false);

  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus, refetchInterval: 20_000 });
  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const st = statusQ.data;
  const changes = draftQ.data?.draft?.items?.length ?? 0;

  const invalid = useMemo(() => {
    let n = 0;
    for (const r of grid.rows) for (const c of Object.values(r.cells)) if (c.set && !c.valid) n++;
    return n;
  }, [grid.rows]);

  const sync = useMutation({
    mutationFn: api.repoSync,
    onSuccess: () => qc.invalidateQueries(),
  });

  const item: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: "100%",
    padding: "0 10px",
    fontSize: 12,
    cursor: "pointer",
    userSelect: "none",
  };

  return (
    <>
      <div
        className="editor-statusbar"
        style={{
          display: "flex",
          alignItems: "center",
          height: 26,
          flexShrink: 0,
          background: token.colorPrimary,
          color: "#fff",
          fontSize: 12,
        }}
      >
        <Tooltip title="This is the branch your saved edits build on. Configer commits them to a review branch for you.">
          <span style={item} onClick={() => setScmOpen(true)}>
            <BranchesOutlined />
            <span className="mono">{st?.branch ?? "…"}</span>
          </span>
        </Tooltip>
        <Tooltip title={st?.remote ? (st.behind > 0 ? `${st.behind} behind — click to pull` : "Up to date — click to pull") : "Local only"}>
          <span
            style={{ ...item, opacity: st?.remote ? 1 : 0.7 }}
            onClick={() => st?.remote && sync.mutate()}
          >
            {sync.isPending ? <SyncOutlined spin /> : st?.remote ? <CloudDownloadOutlined /> : <CloudServerOutlined />}
            {st?.remote ? (st.behind > 0 ? st.behind : "") : "local"}
          </span>
        </Tooltip>
        <Tooltip title="Open Source Control: your active changes, grouped by file">
          <span style={item} onClick={() => setScmOpen(true)}>
            <Badge count={changes} size="small" offset={[6, -2]} color={changes ? token.colorWarning : undefined}>
              <span style={{ color: "#fff", display: "inline-flex", alignItems: "center", gap: 5 }}>
                <DiffOutlined />
                Changes
              </span>
            </Badge>
          </span>
        </Tooltip>
        <div style={{ flex: 1 }} />
        <Tooltip title={invalid ? `${invalid} edited value(s) fail validation` : "All edited values are valid"}>
          <span style={item}>
            {invalid ? <WarningFilled /> : <CheckCircleFilled />}
            {invalid ? `${invalid} invalid` : "valid"}
          </span>
        </Tooltip>
      </div>

      <Drawer
        title={
          <span>
            <BranchesOutlined style={{ marginInlineEnd: 8 }} />
            Source Control
          </span>
        }
        placement="left"
        width={380}
        open={scmOpen}
        onClose={() => setScmOpen(false)}
        styles={{ body: { padding: 0 } }}
      >
        <SourceControlPanel grid={grid} />
      </Drawer>
    </>
  );
}
