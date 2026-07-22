// PendingChangesBar is a floating reminder that staged (but unsubmitted) edits
// are waiting. It keeps the draft one click away from anywhere: jump back to
// review it, or discard it outright. It is collapsible: a click on its collapse
// control tucks it into a slim orange tab pinned to the bottom edge, and a click
// on that tab brings the full bar back. In the editor and file viewer - where a
// floating pill would cover content and each already carries its own bottom
// status strip - it starts collapsed by default, so it never obscures the work.
import { useState } from "react";
import { Button, Popconfirm, Tooltip, App as AntApp } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PullRequestOutlined, DeleteOutlined, DownOutlined } from "../icons";
import { api } from "../api";
import { useUI } from "../store";

export default function PendingChangesBar() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const section = useUI((s) => s.section);
  const setSection = useUI((s) => s.setSection);
  // null = follow the per-section default; true/false = the user's explicit
  // choice this session, which overrides the default until they navigate.
  const [collapsed, setCollapsed] = useState<boolean | null>(null);

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

  if (pending === 0) return null;

  // The editor (config) and file viewer are space-constrained and own their own
  // bottom status bar, so the reminder starts collapsed there and expanded
  // everywhere else; an explicit toggle wins over that default.
  const spaceConstrained = section === "config" || section === "files";
  const isCollapsed = collapsed ?? spaceConstrained;
  const label = `${pending} pending change${pending === 1 ? "" : "s"}`;

  if (isCollapsed) {
    return (
      <Tooltip title={`${label} - show the draft`} placement="top">
        <button
          type="button"
          className="pending-bar-tab"
          onClick={() => setCollapsed(false)}
          aria-label={`${label}, staged but not submitted. Click to expand the draft bar.`}
        >
          <span className="pending-bar-dot" />
          <span className="pending-bar-tab-count">{pending}</span>
        </button>
      </Tooltip>
    );
  }

  return (
    <div className="pending-bar" role="status">
      <span className="pending-bar-dot" />
      <span style={{ fontWeight: 600 }}>{label}</span>
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
      <Tooltip title="Collapse to the bottom edge">
        <Button
          size="small"
          type="text"
          icon={<DownOutlined />}
          onClick={() => setCollapsed(true)}
          aria-label="Collapse the draft bar"
        />
      </Tooltip>
    </div>
  );
}
