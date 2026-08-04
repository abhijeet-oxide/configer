// PendingChangesBar is the floating reminder that staged (but unsubmitted) edits
// are waiting, and the way back to them from anywhere: review the draft, or
// discard it.
//
// At rest it is a small ORANGE tab on the bottom edge saying how many edits are
// waiting. Pointing at it opens the rest of it - the state in words and the two
// actions - and moving away closes it again. No click, no second pill.
//
// The one rule this component must never break: THE TAB DOES NOT MOVE. It grows
// upward and outward from a bottom edge that stays exactly where it was, because
// anything else fights the pointer. An earlier version lifted itself 18px off
// the edge on hover, which moved it out from under the cursor that opened it,
// which closed it, which put it back under the cursor - a pill that flickered
// open and shut as long as you left the mouse near the bottom of the window.
import { useState } from "react";
import { Button, Popconfirm, Tooltip, App as AntApp } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { PullRequestOutlined, DeleteOutlined } from "../icons";
import { api, reviewItems } from "../api";
import { useUI } from "../store";

export default function PendingChangesBar() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const setSection = useUI((s) => s.setSection);
  const setOpenSubmit = useUI((s) => s.setOpenSubmit);
  // Open by pointer or by focus; a tap latches it open where there is no
  // pointer to hover with (a phone), and tapping the tab again closes it.
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);

  const draftQ = useRepoQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const draft = draftQ.data?.draft;
  // The same count the review dialog shows (see api.reviewItems), so the bar
  // and the dialog can never disagree about how many changes there are.
  const pending = reviewItems(draft?.items ?? []).length;

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
        className="pending-bar-tab"
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
          onClick={() => {
            // "Review" means review, so it opens the review dialog. Switching
            // to the editor alone landed the user on a grid of a thousand rows
            // with no sign of the handful of edits they had just asked to see.
            setOpenSubmit(true);
            setSection("config");
          }}
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
