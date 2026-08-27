// ChangePreview shows the exact file edits a change request will write, before
// it is submitted: a list of touched files (with +/- line counts) and a
// side-by-side diff of the selected one, rendered by the same lazy Monaco pane
// the Files view uses. It answers "what will this actually change on disk?"
// with the real bytes, not a value-level summary.
import { Suspense, lazy, useMemo, useState } from "react";
import { Alert, Empty, Segmented, Select, Spin, Switch, Tag, Tooltip, Typography } from "antd";
import { useRepoQuery } from "../repoQuery";
import { api, type FilePreview } from "../api";
import { useUI } from "../store";

const MonacoFileView = lazy(() => import("./MonacoFileView"));

/** How many un-appliable items are named in full before the rest are counted. */
const PROBLEMS_SHOWN = 4;

function statusColor(status: FilePreview["status"]): string {
  if (status === "added") return "green";
  if (status === "removed") return "red";
  return "blue";
}

export default function ChangePreview({ changeId }: { changeId: number }) {
  const mode = useUI((s) => s.mode);
  const previewQ = useRepoQuery({
    queryKey: ["change-preview", changeId],
    queryFn: () => api.previewChange(changeId),
    staleTime: 0,
  });

  const files = useMemo(() => previewQ.data?.files ?? [], [previewQ.data]);
  const structural = previewQ.data?.structural ?? [];
  const problems = previewQ.data?.problems ?? [];
  const [active, setActive] = useState(0);
  // A configuration file is two thousand lines with three of them changed. The
  // whole file is available on a click; what the reviewer came for is not.
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [layout, setLayout] = useState<"split" | "inline">("split");

  if (previewQ.isLoading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
        <Spin />
      </div>
    );
  }
  if (previewQ.isError) {
    return (
      <Typography.Text type="danger">
        Could not build the preview: {(previewQ.error as Error).message}
      </Typography.Text>
    );
  }
  if (files.length === 0 && structural.length === 0 && problems.length === 0) {
    return <Empty description="No file changes to preview" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  const current = files[Math.min(active, files.length - 1)];

  return (
    <div className="cf-preview">
      {/* An edit that cannot be written is the most important thing on this
          panel: a submit will refuse it too, so it is named here - which
          parameter, which instance, which file - while the edits that DO apply
          still show their real diff below.

          Only the first few, though. Forty of these printed in full is a wall of
          text that hides both the count and the diff underneath it; the rest are
          counted, and one line says what to do about all of them. */}
      {problems.length > 0 && (
        <Alert
          type="warning"
          showIcon
          className="cf-problems"
          message={`${problems.length} change${problems.length === 1 ? "" : "s"} cannot be written yet`}
          description={
            <div className="cf-problem-list">
              {problems.slice(0, PROBLEMS_SHOWN).map((p, i) => (
                <div key={i} className="cf-problem">
                  <code>{p.paramId || p.file || "change"}</code>
                  {p.instance && <span className="cf-problem-inst">on {p.instance}</span>}
                  <span className="cf-problem-why">{p.message}</span>
                </div>
              ))}
              {problems.length > PROBLEMS_SHOWN && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  and {problems.length - PROBLEMS_SHOWN} more
                </Typography.Text>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Undo them in the list of changes (or fix the file each one points at); everything
                else can go for review as it is.
              </Typography.Text>
            </div>
          }
        />
      )}
      {structural.length > 0 && (
        <div style={{ flexShrink: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {structural.map((s) => (
            <Tag key={s} color="purple">
              {s}
            </Tag>
          ))}
        </div>
      )}

      {files.length === 0 && problems.length > 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Nothing else in this change rewrites a file"
        />
      )}
      {files.length > 0 && (
        <>
          {/* One row for "which file", whether the change touches two files or
              forty. Tabs across the top were fine for two and became a sideways
              scrollbar at ten - a second axis to hunt along, above a diff that is
              already the thing you came to read. A picker names the file, counts
              what moved in it, and says how many others there are. */}
          <div className="cf-preview-files">
            <Select
              size="small"
              value={String(active)}
              onChange={(v) => setActive(Number(v))}
              popupMatchSelectWidth={false}
              style={{ flex: 1, minWidth: 0 }}
              options={files.map((f, i) => ({
                value: String(i),
                label: (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <Tag color={statusColor(f.status)} style={{ marginInlineEnd: 0 }}>
                      {f.status}
                    </Tag>
                    <code className="cf-preview-path">{f.file}</code>
                    <span style={{ fontSize: 11, color: "var(--c-ok)" }}>+{f.additions}</span>
                    <span style={{ fontSize: 11, color: "var(--c-danger)" }}>-{f.deletions}</span>
                  </span>
                ),
              }))}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
              {files.length === 1 ? "1 file" : `file ${active + 1} of ${files.length}`}
            </Typography.Text>
          </div>
          <div className="cf-preview-opts">
            <Tooltip title="Collapse everything this change did not touch">
              <label className="cf-preview-opt">
                <Switch size="small" checked={onlyChanges} onChange={setOnlyChanges} />
                Only changed lines
              </label>
            </Tooltip>
            <Segmented
              size="small"
              value={layout}
              onChange={(v) => setLayout(v as "split" | "inline")}
              options={[
                { label: "Side by side", value: "split" },
                { label: "Inline", value: "inline" },
              ]}
            />
          </div>
          {current && (
            <div className="cf-preview-diff">
              <Suspense fallback={<div style={{ padding: 16 }}><Spin /></div>}>
                <MonacoFileView
                  path={current.file}
                  original={current.before}
                  content={current.after}
                  diff
                  diffLayout={layout}
                  onlyChanges={onlyChanges}
                  dark={mode === "dark"}
                />
              </Suspense>
            </div>
          )}
        </>
      )}
    </div>
  );
}
