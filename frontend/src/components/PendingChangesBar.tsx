// PendingChangesBar is a floating reminder that staged (but unsubmitted) edits
// are waiting, shown on every section EXCEPT the editor itself (where the
// toolbar already surfaces the draft). It keeps the draft one click away from
// anywhere: jump back to review it, or discard it outright.
import { Button, Popconfirm, App as AntApp } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PullRequestOutlined, DeleteOutlined } from "../icons";
import { api } from "../api";
import { useUI } from "../store";

export default function PendingChangesBar() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const section = useUI((s) => s.section);
  const setSection = useUI((s) => s.setSection);

  const draftQ = useQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const draft = draftQ.data?.draft;
  const pending = draft?.items?.length ?? 0;

  const discard = useMutation({
    mutationFn: () => api.rejectChange(draft!.id),
    onSuccess: () => {
      qc.invalidateQueries();
      message.info("Draft discarded; nothing was written to Git.");
    },
    onError: (e: Error) => message.error(e.message),
  });

  // Hidden with no pending edits, and in the editor (its toolbar owns the draft)
  // so it never doubles up on the primary Review button.
  if (pending === 0 || section === "config") return null;

  return (
    <div className="pending-bar" role="status">
      <span className="pending-bar-dot" />
      <span style={{ fontWeight: 600 }}>
        {pending} pending change{pending === 1 ? "" : "s"}
      </span>
      <span style={{ color: "var(--text-2)", fontSize: 12 }}>staged, not yet submitted</span>
      <span style={{ flex: 1 }} />
      <Button
        size="small"
        type="primary"
        icon={<PullRequestOutlined />}
        onClick={() => setSection("config")}
      >
        Review
      </Button>
      <Popconfirm
        title="Discard all staged edits?"
        description="This clears the draft. Nothing has been written to Git, so nothing is lost there."
        okText="Discard"
        okButtonProps={{ danger: true }}
        onConfirm={() => discard.mutate()}
      >
        <Button size="small" type="text" icon={<DeleteOutlined />} loading={discard.isPending} aria-label="Discard draft" />
      </Popconfirm>
    </div>
  );
}
