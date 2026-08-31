import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { App as AntApp, Button, Dropdown, Input, Tooltip } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BranchesOutlined, DownOutlined, ReloadOutlined, SearchOutlined, UndoOutlined } from "../icons";
import { api, crRef, type ChangeRequest } from "../api";
import { useUI } from "../store";
import { useRepoQuery } from "../repoQuery";
import { useIdentity } from "../identity";
import { STATUS, statusColor, statusOf } from "../changestatus";
import { relTime } from "./DashboardView";
import { StatusPill } from "./ui";
import { useRefreshRepo } from "../pulse";

// "Whose version am I looking at?" - one question, one control, ONE bar above
// both surfaces that answer it.
//
// Parameters shows the configuration as values; Files shows the same
// configuration as the bytes those values live in. They are two readings of one
// thing, so they take one picker, in one place, saying one sentence - a control
// that appeared over the grid and not over the files meant a reviewer could
// compare a change's values and never its diff.
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
//
// Two things keep it usable on an application that has been in service a while,
// where there are thousands of changes and none of them are ever deleted:
//
//   The list is what is IN FLIGHT, complete. Drafts, changes under review and
//   approved ones are always few, because being in flight is a transient state
//   however old the application is. Asking the service for that set (?state=)
//   rather than filtering the newest page client-side is the difference between
//   a picker that always shows every open change and one that shows whichever
//   few happened to make the newest fifty.
//
//   Anything else is REACHED BY SEARCHING, not by scrolling. Typing queries the
//   whole history server-side (?q=), so a change from last year is one word
//   away instead of behind a page cursor nobody has a reason to follow. Endless
//   scrolling would be the other answer and it is the wrong one: nobody finds
//   CR-412 by scrolling to it.

/** Rank inside the list: what is waiting on somebody first, then other people's
 *  unsent work, then endings - roughly the order of how likely you are to be
 *  looking for it. */
const RANK: Record<string, number> = {
  under_review: 0,
  approved: 1,
  draft: 2,
  rejected: 3,
  published: 4,
};

/** How many changes the list draws before it stops and says how many more there
 *  are. A dropdown is a place to RECOGNISE something, not to read a list: past
 *  about a dozen rows nobody scans them, they search - so the cap is set where
 *  scanning stops working and the search box is offered instead. */
const SHOWN = 12;

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
  draftItems,
  checkedAt,
  checking,
  failed,
}: {
  changes: ChangeRequest[] | undefined;
  /** how many edits are staged in the reader's own draft, counted the way the
   *  review counts them (see api.reviewItems) so the picker, the tab badge and
   *  the submit button can never disagree */
  draftItems?: number;
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
  const isMine = useCallback(
    (a: string) => !!a && (a === me.displayName || a === me.user?.login),
    [me.displayName, me.user?.login],
  );
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

  // What somebody has typed into the picker, and the debounced copy that is
  // actually sent. Debounced because every keystroke would otherwise be a
  // request, and this is a search box in a dropdown, not a command line.
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  // Searching asks the SERVICE, across every state and the whole history -
  // which is the point: the reason to type is that what you want is not in the
  // list in front of you. It runs only while the dropdown is open, so a closed
  // picker costs nothing.
  const searchQ = useRepoQuery({
    queryKey: ["changes", "search", debounced],
    queryFn: () => api.changes({ q: debounced, limit: 40 }),
    enabled: open && debounced.length > 0,
    staleTime: 15_000,
  });

  const searching = debounced.length > 0;
  const results = useMemo(() => {
    const source = searching ? (searchQ.data ?? []) : (changes ?? []);
    return [...source]
      // Your OWN draft is not a destination: it is already what Main shows (see
      // the Main row below), and listing it again offered a second way to reach
      // the view you were on, which did nothing when picked.
      .filter((c) => !(c.state === "draft" && isMine(c.author)))
      // A published change's values ARE main, so it is never a separate view -
      // not even as a search hit, where picking it would silently show main
      // under another name.
      .filter((c) => c.state !== "published")
      .sort((a, b) => {
        const r = (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9);
        return r !== 0 ? r : (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      });
  }, [searching, searchQ.data, changes, isMine]);

  const shown = results.slice(0, SHOWN);
  const hidden = results.length - shown.length;

  // The change being viewed is FETCHED, not looked up in the list.
  //
  // The list is what is in flight; a change reached by search usually is not -
  // it is the rejected one from last month, which is the whole reason somebody
  // searched. Reading the bar out of the list meant picking a search hit and
  // watching the bar fall back to "Main" the moment the search was cleared,
  // while the grid went on showing that change's values. The bar said one
  // thing and the cells said another.
  //
  // It shares its key with ParameterGrid's read of the same change, so this
  // costs no extra request.
  const viewedQ = useRepoQuery({
    queryKey: ["change", viewChangeId],
    queryFn: () => api.change(viewChangeId as number),
    enabled: viewChangeId != null,
  });
  const viewed = viewChangeId == null ? null : (viewedQ.data ?? null);

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

  // Your own unsent edits ride along with Main - the grid has always shown
  // them, and it should. What was missing was the control SAYING so: it kept
  // reading plainly "Main" while three edits of yours sat on top of the values
  // on screen, and offered "Your draft" as a separate entry that showed exactly
  // the same thing. So the default row describes what it actually is, and there
  // is only one of it.
  const unsent = draftItems ?? 0;

  const items = [
    ...(searching
      ? []
      : [
          {
            key: "main",
            label: (
              <div
                className="cf-viewpick-row"
                style={unsent ? ({ ["--st" as string]: statusColor("draft") } as CSSProperties) : undefined}
              >
                <span className="cf-viewpick-name">
                  {unsent > 0 && <span className="cf-viewpick-ref">Your draft</span>}
                  {unsent > 0 ? "on top of main" : "Main"}
                </span>
                <span className="cf-viewpick-sub">
                  {unsent > 0 ? (
                    <>
                      <StatusPill tone="pending" size="sm">
                        {unsent} unsent
                      </StatusPill>
                      <span>Not sent for review yet - it has no number or branch until you submit</span>
                    </>
                  ) : (
                    <span>The published values</span>
                  )}
                </span>
              </div>
            ),
          },
          ...(shown.length ? [{ type: "divider" as const, key: "d" }] : []),
        ]),
    ...shown.map((c) => {
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
    // What the list is NOT showing. A dropdown that silently stops at twelve is
    // how somebody concludes their change is gone; saying the number and where
    // to go for it costs one row.
    ...(hidden > 0 || (searching && !shown.length) || (!searching && !shown.length)
      ? [
          {
            key: "more",
            disabled: true,
            label: (
              <div className="cf-viewpick-note">
                {searching
                  ? searchQ.isFetching
                    ? "Searching…"
                    : shown.length === 0
                      ? `Nothing matches "${debounced}".`
                      : `${hidden} more match - keep typing to narrow.`
                  : shown.length === 0
                    ? "Nothing is in flight. Search to reach a change that has ended."
                    : `${hidden} more in flight - search by number, title or author.`}
              </div>
            ),
          },
        ]
      : []),
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
        onOpenChange={(o) => {
          setOpen(o);
          // A search left behind is a list that lies the next time it is
          // opened, so closing clears it.
          if (!o) {
            setQuery("");
            setDebounced("");
          }
        }}
        placement="bottomLeft"
        popupRender={(menu) => (
          <div className="cf-pop cf-viewpick-pop">
            <Input
              autoFocus
              size="small"
              allowClear
              prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
              placeholder="Search every change - number, title, author…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // The dropdown closes on Escape; without this the keystroke is
              // eaten by the field and the picker traps you in it.
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                e.stopPropagation();
              }}
            />
            {menu}
          </div>
        )}
        menu={{
          items,
          selectedKeys: [viewed ? String(viewed.id) : "main"],
          onClick: ({ key }) => {
            if (key === "more") return;
            viewChange(key === "main" ? null : Number(key));
            setOpen(false);
          },
        }}
      >
        <Tooltip title="Which change's configuration this page is showing">
          <Button size="small" icon={<BranchesOutlined />} style={{ flexShrink: 0, maxWidth: 280 }}>
            <span className="cf-viewbtn-label">
              {viewed ? `${label(viewed, isMine)} · ${viewed.title}` : "Main"}
            </span>
            {/* Editing on main does not change WHICH view you are on - your
                draft has always been part of it - but it does change what is on
                screen, so the control says so. There is no branch name to show
                yet, and inventing one would be a lie: a draft has no number and
                no branch until it is submitted. */}
            {!viewed && unsent > 0 && (
              <span className="cf-viewbtn-unsent">
                {unsent} unsent
              </span>
            )}
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
              ? "Never published - this is what the change asked for."
              : "Proposed changes, laid over the published files."}
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
