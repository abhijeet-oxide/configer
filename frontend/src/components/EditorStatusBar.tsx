import { Badge, Drawer, Tooltip, theme as antdTheme } from "antd";
import {
  BranchesOutlined,
  SyncOutlined,
  CloudDownloadOutlined,
  DiffOutlined,
  CheckCircleFilled,
  FilterFilled,
  WarningFilled,
  CloudServerOutlined,
} from "@ant-design/icons";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Grid } from "../api";
import { useUI } from "../store";
import SourceControlPanel from "./SourceControlPanel";

// EditorStatusBar is the VS Code bottom bar for the config editor: branch name
// and remote state bottom-left, a one-click pull, a "changes" pill that opens
// the Source Control view, and a validity readout on the right that doubles as
// the "show only invalid cells" toggle. It makes the Git reality visible to
// anyone who wants it, without demanding they learn Git to edit a value.
//
// Deliberately CHARCOAL, not the brand color: the bar is chrome (git plumbing
// + status), so it must not read as a primary surface or compete with the
// grid. The one accent it carries is the active invalid-only filter.

// Charcoal is fixed in both light and dark: the bar anchors the bottom of the
// editor as a neutral, quiet band regardless of theme.
const CHARCOAL = "#2b2f36";
const CHARCOAL_ACTIVE = "#3a3f48";

export default function EditorStatusBar({ grid }: { grid: Grid }) {
  const { token } = antdTheme.useToken();
  const qc = useQueryClient();
  const { filters, setFilters } = useUI();
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
  const invalidOnly = filters.invalidOnly;

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
          background: CHARCOAL,
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
        <Tooltip title={st?.remote ? (st.behind > 0 ? `${st.behind} behind - click to pull` : "Up to date - click to pull") : "Local only"}>
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
        {/* Validity readout doubles as the "show only invalid cells" toggle.
            Clicking flips filters.invalidOnly; clicking again clears it (so
            there is always a way to undo the selection). The active state is
            unmistakable: a lit accent block with a filter icon. */}
        <Tooltip
          title={
            invalidOnly
              ? "Showing only invalid cells - click to show everything again"
              : invalid
                ? `${invalid} edited value(s) fail validation - click to show only invalid cells`
                : "All edited values are valid"
          }
        >
          <span
            style={{
              ...item,
              background: invalidOnly ? token.colorError : invalid ? CHARCOAL_ACTIVE : undefined,
              fontWeight: invalidOnly ? 600 : undefined,
            }}
            onClick={() => setFilters({ invalidOnly: !invalidOnly })}
          >
            {invalidOnly ? <FilterFilled /> : invalid ? <WarningFilled /> : <CheckCircleFilled />}
            {invalidOnly ? `only invalid (${invalid})` : invalid ? `${invalid} invalid` : "valid"}
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
