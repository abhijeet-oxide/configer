import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { App as AntApp, Button, Dropdown, Tooltip } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BranchesOutlined, DownOutlined, ReloadOutlined, UndoOutlined } from "../icons";
import { api, crRef, type ChangeRequest } from "../api";
import { useUI } from "../store";
import { useIdentity } from "../identity";
import { STATUS, statusColor, statusOf } from "../changestatus";
import { relTime } from "./DashboardView";
import { StatusPill } from "./ui";
import { useRefreshRepo } from "../pulse";

// "Whose values am I looking at?" - one question, one control.
//
// The parameters page used to answer it with silence. It always showed the
// published files with your own draft on top, and every other version of the
// truth was unreachable from the screen where people actually read values. That
// is fine right up until a change is REJECTED, and then it is the whole problem:
// the author comes back, sees the original value, and has nothing anywhere
// telling them their proposal ever existed - because a rejected change reaches
// no branch the trunk knows about and no commit, so there is genuinely nowhere
// else its values live.
//
// So the page can be read THROUGH a change. Main is the default and stays the
// default. Picking a change lays that change's edits over the published files
// and says so plainly in a bar; picking a rejected one also offers the way back
// in, because looking at refused work and resuming it are the same errand.
//
// It is deliberately a CHANGE picker and not a branch picker, even though the
// two are nearly the same list. A branch name is a derived fact - the number,
// the title and the state are what somebody remembers and what the reviewer
// wrote to them about - and a draft has no branch at all until it is submitted.
// The branch is shown on the entry that has one; it is not the thing being
// chosen.

/** The states worth offering, in the order somebody looks for them. Published
 *  changes are absent on purpose: their values ARE main, so a Published entry
 *  would be a second way to say the thing the default already says. */
const OFFERED = ["draft", "under_review", "approved", "rejected"] as const;

/** Rank inside the list. Your unsent work first, then what is waiting on
 *  somebody, then what was refused - which is roughly the order of how likely
 *  you are to be looking for it. */
const RANK: Record<string, number> = { draft: 0, under_review: 1, approved: 2, rejected: 3 };

function pillTone(state: ChangeRequest["state"]) {
  return state === "rejected" ? "danger" : state === "approved" ? "ok" : state === "under_review" ? "review" : "pending";
}

/** What to call a change in a list: its number, or "Your draft" for the one
 *  draft that is yours (a draft has no number - it is not a change request
 *  yet). */
function label(cr: ChangeRequest, mine: (author: string) => boolean): string {
  const ref = crRef(cr);
  if (ref) return ref;
  return mine(cr.author) ? "Your draft" : "Draft";
}

/** How long ago, in the fewest words that are still true. Deliberately coarse:
 *  the exact second is noise, and "just now" is the answer somebody wants 95%
 *  of the time they glance at it. */
function freshness(at: number, now: number): string {
  if (!at) return "checking…";
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 45) return "up to date";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export default function ChangeViewPicker({
  changes,
  checkedAt,
  checking,
  failed,
}: {
  changes: ChangeRequest[] | undefined;
  /** epoch ms of the last confirmed heartbeat (see pulse.ts) */
  checkedAt: number;
  checking: boolean;
  failed: boolean;
}) {
  const { viewChangeId, viewChange, setSection } = useUI();
  const me = useIdentity();
  // "Yours" is matched the way the Change Flow matches it: a change records the
  // author as a display name or as a login depending on how it was made, so
  // both are checked rather than picking one and mislabelling half of them.
  const isMine = (a: string) => !!a && (a === me.displayName || a === me.user?.login);
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const refresh = useRefreshRepo();
  // The clock the freshness label reads. It ticks on its own, because
  // "up to date" has to become "2m ago" while nobody is touching anything -
  // a label that only re-renders when the data changes says "up to date"
  // forever, which is the one thing it must never do.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, []);

  const offerable = useMemo(() => {
    const list = (changes ?? []).filter((c) => (OFFERED as readonly string[]).includes(c.state));
    return [...list].sort((a, b) => {
      const r = (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9);
      return r !== 0 ? r : (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    });
  }, [changes]);

  const viewed = offerable.find((c) => c.id === viewChangeId) ?? null;

  // Resuming pulls the refused edits back into your draft. It deliberately
  // lands you on the grid reading MAIN again - your draft is now on top of it,
  // which is the thing you are about to edit, and staying pointed at the
  // rejected change would leave you looking at a copy of work you have already
  // taken.
  const resume = useMutation({
    mutationFn: (id: number) => api.reopenChange(id),
    onSuccess: (res) => {
      viewChange(null);
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
      const settled = res.settled
        ? ` ${res.settled} ${res.settled === 1 ? "edit was" : "edits were"} already how the repository reads today, so ${res.settled === 1 ? "it was" : "they were"} left out.`
        : "";
      message.success(
        `${res.carried} ${res.carried === 1 ? "edit" : "edits"} from ${res.from} are back in your draft.${settled}`,
      );
    },
    onError: (e: Error) => message.error(e.message),
  });

  const items = [
    {
      key: "main",
      label: (
        <div className="cf-viewpick-row">
          <span className="cf-viewpick-name">Main</span>
          <span className="cf-viewpick-sub">The published values, with your own draft on top</span>
        </div>
      ),
    },
    ...(offerable.length ? [{ type: "divider" as const, key: "d" }] : []),
    ...offerable.map((c) => {
      const look = STATUS[statusOf(c.state)];
      return {
        key: String(c.id),
        label: (
          <div className="cf-viewpick-row" style={{ ["--st" as string]: statusColor(statusOf(c.state)) }}>
            <span className="cf-viewpick-name">
              <span className="cf-viewpick-ref">{label(c, isMine)}</span>
              {c.title}
            </span>
            <span className="cf-viewpick-sub">
              <StatusPill tone={pillTone(c.state)} size="sm">
                {look.label}
              </StatusPill>
              <span>
                {c.author} · {relTime(c.updatedAt)}
                {c.items?.length ? ` · ${c.items.length} ${c.items.length === 1 ? "edit" : "edits"}` : ""}
              </span>
            </span>
            {/* The branch is shown where there IS one, as a fact about the
                change - not as the thing being picked. A draft has none. */}
            {c.branch && <span className="cf-viewpick-branch mono">{c.branch}</span>}
          </div>
        ),
      };
    }),
  ];

  // The strip wears the viewed change's status colour, and nothing at all when
  // it is showing main: the quiet state is the common one and must not look
  // like an alert.
  const tone = viewed ? statusColor(statusOf(viewed.state)) : null;
  return (
    <div
      className={`cf-viewbar${viewed ? " is-viewing" : ""}`}
      style={tone ? ({ ["--st" as string]: tone } as CSSProperties) : undefined}
    >
      <Dropdown
        trigger={["click"]}
        open={open}
        onOpenChange={setOpen}
        placement="bottomLeft"
        menu={{
          items,
          selectedKeys: [viewed ? String(viewed.id) : "main"],
          onClick: ({ key }) => {
            viewChange(key === "main" ? null : Number(key));
            setOpen(false);
          },
        }}
      >
        <Tooltip title="Which change's values the grid is showing">
          <Button size="small" icon={<BranchesOutlined />} style={{ flexShrink: 0, maxWidth: 260 }}>
            <span className="cf-viewbtn-label">
              {viewed ? `${label(viewed, isMine)} · ${viewed.title}` : "Main"}
            </span>
            <DownOutlined style={{ fontSize: 9, opacity: 0.55, marginInlineStart: 2 }} />
          </Button>
        </Tooltip>
      </Dropdown>

      {viewed && (
        <>
          <StatusPill tone={pillTone(viewed.state)} size="sm">
            {STATUS[statusOf(viewed.state)].label}
          </StatusPill>
          {/* Why it was turned down, in the reviewer's own words, on the screen
              where the author is looking at what they proposed. It is the first
              thing they need and it used to be three clicks away in a comment
              thread. */}
          {viewed.state === "rejected" && viewed.rejectReason && (
            <span className="cf-viewbar-reason" title={viewed.rejectReason}>
              &ldquo;{viewed.rejectReason}&rdquo;
              {viewed.rejectedBy ? <span className="cf-viewbar-by"> - {viewed.rejectedBy}</span> : null}
            </span>
          )}
          <span className="cf-viewbar-note">
            {viewed.state === "rejected"
              ? "Never published - these values are what this change asked for."
              : "Proposed values, laid over the published files."}
          </span>
          <span className="cf-viewbar-spacer" />
          {viewed.state === "rejected" && me.canEdit && (
            <Button
              size="small"
              type="primary"
              icon={<UndoOutlined />}
              loading={resume.isPending}
              onClick={() => resume.mutate(viewed.id)}
            >
              Resume this change
            </Button>
          )}
          <Button size="small" onClick={() => setSection("changes")}>
            Open change
          </Button>
          <Button size="small" type="text" onClick={() => viewChange(null)}>
            Back to Main
          </Button>
        </>
      )}

      {/* Freshness, and the way to insist on it.
          The page keeps itself current on its own (pulse.ts), which is exactly
          the kind of thing nobody believes without being shown - so the strip
          says when it last confirmed, and offers the button anyway. Somebody
          who presses refresh is telling you they do not trust the last answer,
          and "the revision is unchanged, nothing to do" is a correct and
          useless reply, so it re-reads outright. */}
      {!viewed && <span className="cf-viewbar-spacer" />}
      <span className={`cf-viewbar-fresh${failed ? " is-stale" : ""}`}>
        {failed ? "Not reaching the service" : freshness(checkedAt, now)}
      </span>
      <Tooltip title="Check for changes now">
        <Button
          size="small"
          type="text"
          aria-label="Refresh"
          icon={<ReloadOutlined />}
          loading={checking}
          onClick={refresh}
          className="cf-viewbar-refresh"
        />
      </Tooltip>
    </div>
  );
}
