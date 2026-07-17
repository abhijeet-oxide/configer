import { Button, Empty, Tag, Tooltip, Typography, theme as antdTheme, App as AntApp } from "antd";
import {
  BranchesOutlined,
  CloudDownloadOutlined,
  FileOutlined,
  SyncOutlined,
  UndoOutlined,
  ArrowRightOutlined,
  CloudServerOutlined,
  ExclamationCircleOutlined,
} from "../icons";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, expandBinding, primaryBinding, structuralLabel, type ChangeItem, type Grid } from "../api";
import { fmtValue } from "../rules";
import { useUI } from "../store";
import SubmitChangesButton from "./SubmitChangesButton";

// SourceControlPanel is the VS Code "Source Control" view, translated for people
// who never think about Git: the branch the work lands on, the active (still
// uncommitted) changes grouped by the file each one touches, a one-click undo
// per change, and pull-latest; all without exposing raw Git. Committing is the
// same review-and-submit flow used elsewhere (SubmitChangesButton), so a change
// becomes a branch + pull request behind the scenes.

function afterValue(it: ChangeItem): string {
  const structural = structuralLabel(it);
  if (structural) return structural;
  if (it.action === "exclude") return "removed from this instance";
  if (it.action === "reset") return "back to inherited";
  return fmtValue(it.new);
}

interface FileChanges {
  file: string;
  items: ChangeItem[];
}

export default function SourceControlPanel({ grid }: { grid: Grid }) {
  const { token } = antdTheme.useToken();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { selectParam } = useUI();

  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const statusQ = useQuery({ queryKey: ["repo-status"], queryFn: api.repoStatus, refetchInterval: 20_000 });
  const items = useMemo(() => draftQ.data?.draft?.items ?? [], [draftQ.data]);
  const st = statusQ.data;

  // Map every draft item to the file its write-back lands in, so changes
  // group the way a developer would see them in a diff: by file.
  const fileOf = useMemo(() => {
    const rows = new Map(grid.rows.map((r) => [r.param.id, r]));
    const insts = new Map(grid.instances.map((i) => [i.name, i]));
    return (it: ChangeItem): string => {
      // A direct file edit groups under its own file; other structural
      // items change the instance registry (plus a folder).
      if (it.action === "edit-file") return it.file ?? "(file)";
      if (structuralLabel(it)) return ".configer/instances.yaml";
      const row = rows.get(it.paramId);
      if (!row) return "(unmapped)";
      if (it.scope === "global") return primaryBinding(row.param).file || "(unmapped)";
      return (
        row.cells[it.instance]?.file ||
        expandBinding(primaryBinding(row.param), insts.get(it.instance)) ||
        "(unmapped)"
      );
    };
  }, [grid.rows, grid.instances]);

  const byFile = useMemo<FileChanges[]>(() => {
    const groups = new Map<string, ChangeItem[]>();
    for (const it of items) {
      const f = fileOf(it) ?? "(unmapped)";
      const arr = groups.get(f) ?? [];
      arr.push(it);
      groups.set(f, arr);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, its]) => ({ file, items: its }));
  }, [items, fileOf]);

  const revert = useMutation({
    mutationFn: (it: ChangeItem) =>
      api.revertValue(it.action === "edit-file" ? `file:${it.file}` : it.paramId, it.instance),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e: Error) => message.error(e.message),
  });
  const sync = useMutation({
    mutationFn: api.repoSync,
    onSuccess: (s) => {
      message.success(s.behind > 0 ? `Pulled; ${s.behind} still behind` : "Up to date with the remote");
      qc.invalidateQueries();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const draftId = draftQ.data?.draft?.id;
  const targetBranch = draftQ.data?.draft?.targetBranch ?? st?.branch;
  // While a draft is open the work rides its own feature branch, named for
  // real on submit - so the panel never says the user is editing "on main".
  const draftBranch = draftQ.data?.draft?.branch;
  const hasDraft = items.length > 0 || !!draftId;
  const currentBranch = hasDraft && draftBranch ? draftBranch : st?.branch;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Branch + remote status: the VS Code bottom-left widget, expanded. */}
      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <BranchesOutlined style={{ color: token.colorPrimary }} />
          <Typography.Text strong className="mono" style={{ fontSize: 13 }} ellipsis={{ tooltip: currentBranch }}>
            {currentBranch ?? "…"}
          </Typography.Text>
          {hasDraft && draftBranch && (
            <Tooltip title="Your first edit moved you off the main branch onto this feature branch. It gets a real name when you submit the change request.">
              <Tag color="processing" style={{ margin: 0, fontSize: 10, lineHeight: "16px" }}>
                {draftBranch === "feature/unnamed" ? "new · unnamed" : "feature"}
              </Tag>
            </Tooltip>
          )}
          <div style={{ flex: 1 }} />
          <Tooltip title={st?.remote ? "Pull the latest from the remote" : "No remote configured"}>
            <Button
              size="small"
              type="text"
              icon={<CloudDownloadOutlined />}
              loading={sync.isPending}
              disabled={!st?.remote}
              onClick={() => sync.mutate()}
            >
              {st ? (st.behind > 0 ? `Pull ${st.behind}` : "Pull") : "Pull"}
            </Button>
          </Tooltip>
        </div>
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {st?.upstreamGone ? (
            <Tag color="error" icon={<ExclamationCircleOutlined />}>branch removed on remote</Tag>
          ) : st?.remote ? (
            <Tag color={st.behind > 0 ? "processing" : "success"} icon={<SyncOutlined spin={sync.isPending} />}>
              {st.behind > 0 ? `${st.behind} behind` : "up to date"}
            </Tag>
          ) : (
            <Tag icon={<CloudServerOutlined />}>local only</Tag>
          )}
          {(st?.ahead ?? 0) > 0 && <Tag color="warning">{st!.ahead} ahead</Tag>}
        </div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 11.5, margin: "8px 0 0" }}>
          {hasDraft ? (
            <>
              Every edit - a value, a new instance, an instance's settings - is collected on this
              feature branch as a pending change. Submitting names the branch and opens a pull request
              into <code>{targetBranch ?? "main"}</code>. You don't need to touch Git.
            </>
          ) : (
            <>
              Make an edit and Configer moves you off <code>{targetBranch ?? "main"}</code> onto a feature
              branch automatically, collecting changes for review before they merge back.
            </>
          )}
        </Typography.Paragraph>
      </div>

      {/* Active changes, grouped by file. */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 8px" }}>
        <Typography.Text
          type="secondary"
          style={{ fontSize: 11, letterSpacing: 0.4, paddingInline: 6, textTransform: "uppercase" }}
        >
          Changes {items.length > 0 && `· ${items.length}`}
        </Typography.Text>
        {items.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No active changes. Edit values in the table and they show up here."
            style={{ marginTop: 40 }}
          />
        ) : (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 12 }}>
            {byFile.map((fc) => (
              <div key={fc.file}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 6px" }}>
                  <FileOutlined style={{ opacity: 0.6 }} />
                  <Typography.Text className="mono" style={{ fontSize: 12 }} ellipsis={{ tooltip: fc.file }}>
                    {fc.file}
                  </Typography.Text>
                  <span
                    style={{
                      marginLeft: "auto",
                      color: token.colorWarning,
                      fontWeight: 700,
                      fontSize: 12,
                      minWidth: 16,
                      textAlign: "center",
                    }}
                    title={`${fc.items.length} change(s) in this file`}
                  >
                    {fc.items.length}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {fc.items.map((it) => (
                    <div
                      key={`${it.action ?? "set"}|${it.paramId}|${it.instance}|${it.file ?? ""}`}
                      className="scm-change-row"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "5px 6px 5px 22px",
                        borderRadius: 6,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {structuralLabel(it) ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: "16px" }}>
                              structure
                            </Tag>
                            <span style={{ fontSize: 12 }}>{structuralLabel(it)}</span>
                          </div>
                        ) : (
                          <>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <a
                                className="mono"
                                style={{ fontSize: 12 }}
                                onClick={() => selectParam(it.paramId)}
                              >
                                {it.paramId}
                              </a>
                              {it.scope === "global" ? (
                                <Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: "16px" }}>
                                  global
                                </Tag>
                              ) : (
                                <Tag style={{ margin: 0, fontSize: 10, lineHeight: "16px" }}>{it.instance}</Tag>
                              )}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginTop: 2 }}>
                              <span className="mono" style={{ opacity: 0.5 }}>{fmtValue(it.old)}</span>
                              <ArrowRightOutlined style={{ opacity: 0.4, fontSize: 9 }} />
                              <span className="mono" style={{ color: token.colorSuccessText }}>{afterValue(it)}</span>
                            </div>
                          </>
                        )}
                      </div>
                      <Tooltip title="Discard this change">
                        <Button
                          size="small"
                          type="text"
                          icon={<UndoOutlined />}
                          loading={revert.isPending}
                          onClick={() => revert.mutate(it)}
                        />
                      </Tooltip>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Commit = the existing review-and-submit flow. */}
      <div
        style={{
          padding: "10px 12px",
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          {items.length > 0
            ? `${items.length} change${items.length > 1 ? "s" : ""} ready`
            : draftId
              ? "Draft ready"
              : "Nothing to submit yet"}
        </Typography.Text>
        <SubmitChangesButton instances={grid.instances} />
      </div>
    </div>
  );
}
