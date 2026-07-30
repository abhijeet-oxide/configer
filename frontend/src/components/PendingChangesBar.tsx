// PendingChangesBar is a floating reminder that staged (but unsubmitted) edits
// are waiting. It keeps the draft one click away from anywhere: jump back to
// review it, or discard it outright.
//
// It is ONE pill, tucked into the bottom edge of the window. At rest it shows
// what is waiting ("2 pending changes"); pointing at it (or focusing it, or
// tapping it on a touch screen) lifts the SAME pill and reveals the rest of it -
// what the state means and the two things you can do about it. It used to be
// two separate pills: a slim tab that had to be clicked to swap it for a wider
// one that repeated the count in words. Two steps, twice the space, and the
// first step told the reader nothing they did not already know.
import { useState } from "react";
import { Button, Popconfirm, Tooltip, App as AntApp } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { PullRequestOutlined, DeleteOutlined } from "../icons";
import { api } from "../api";
import { useUI } from "../store";

export default function PendingChangesBar() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const setSection = useUI((s) => s.setSection);
  // Revealed by the pointer, by focus, or - where neither exists - by a tap
  // that latches it open. Hover alone would leave the pill unusable on a phone
  // and unreachable from the keyboard.
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);

  const draftQ = useRepoQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
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

  const open = hover || focus || pinned;
  const label = `${pending} pending change${pending === 1 ? "" : "s"}`;

  return (
    <div
      className={"pending-bar" + (open ? " is-open" : "")}
      role="status"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPinned(false);
      }}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
    >
      <button
        type="button"
        className="pending-bar-head"
        aria-expanded={open}
        aria-label={`${label}, staged but not submitted`}
        onClick={() => setPinned((p) => !p)}
      >
        <span className="pending-bar-dot" />
        <span className="pending-bar-label">{label}</span>
      </button>
      <span className="pending-bar-more" aria-hidden={!open}>
        <span className="pending-bar-sub">staged, not yet submitted</span>
        <Button
          size="small"
          type="primary"
          icon={<PullRequestOutlined />}
          tabIndex={open ? 0 : -1}
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
          <Tooltip title="Discard draft">
            <Button
              size="small"
              type="text"
              icon={<DeleteOutlined />}
              loading={discard.isPending}
              tabIndex={open ? 0 : -1}
              aria-label="Discard draft"
            />
          </Tooltip>
        </Popconfirm>
      </span>
    </div>
  );
}
