// ChangePreview shows the exact file edits a change request will write, before
// it is submitted: a list of touched files (with +/- line counts) and a
// side-by-side diff of the selected one, rendered by the same lazy Monaco pane
// the Files view uses. It answers "what will this actually change on disk?"
// with the real bytes, not a value-level summary.
import { Suspense, lazy, useMemo, useState } from "react";
import { Alert, Empty, Segmented, Spin, Tag, Typography } from "antd";
import { useRepoQuery } from "../repoQuery";
import { api, type FilePreview } from "../api";
import { useUI } from "../store";

const MonacoFileView = lazy(() => import("./MonacoFileView"));

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
    <div>
      {/* An edit that cannot be written is the most important thing on this
          panel: a submit will refuse it too, so it is named here - which
          parameter, which instance, which file - while the edits that DO apply
          still show their real diff below. */}
      {problems.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message={`${problems.length} change${problems.length === 1 ? "" : "s"} cannot be written yet`}
          description={
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {problems.map((p, i) => (
                <div key={i} style={{ fontSize: 12.5 }}>
                  <code>{p.paramId || p.file || "change"}</code>
                  {p.instance && <span style={{ color: "var(--text-2)" }}> on {p.instance}</span>}
                  <div style={{ color: "var(--text-2)" }}>{p.message}</div>
                </div>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Undo these in the list above (or fix the file they point at) and the rest can go for
                review as they are.
              </Typography.Text>
            </div>
          }
        />
      )}
      {structural.length > 0 && (
        <div style={{ marginBottom: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {structural.map((s) => (
            <Tag key={s} color="purple">
              {s}
            </Tag>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <>
          <Segmented
            size="small"
            value={String(active)}
            onChange={(v) => setActive(Number(v))}
            options={files.map((f, i) => ({
              value: String(i),
              label: (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Tag color={statusColor(f.status)} style={{ marginInlineEnd: 0 }}>
                    {f.status}
                  </Tag>
                  <code style={{ fontSize: 12 }}>{f.file}</code>
                  <span style={{ fontSize: 11, color: "var(--c-ok)" }}>+{f.additions}</span>
                  <span style={{ fontSize: 11, color: "var(--c-danger)" }}>-{f.deletions}</span>
                </span>
              ),
            }))}
            style={{ marginBottom: 8, overflowX: "auto", maxWidth: "100%" }}
          />
          {current && (
            <div style={{ height: 320, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
              <Suspense fallback={<div style={{ padding: 16 }}><Spin /></div>}>
                <MonacoFileView
                  path={current.file}
                  original={current.before}
                  content={current.after}
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
