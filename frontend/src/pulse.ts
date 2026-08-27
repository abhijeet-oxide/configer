// The workspace's heartbeat: ONE small poll that decides when everything else
// re-reads.
//
// A configuration is shared. A colleague publishes a change, a pipeline pushes
// a commit, somebody in the next room opens a change request - and the screen
// has to notice, or the person reading it is making decisions about a
// repository that moved ten minutes ago.
//
// The obvious way to get that is to poll what is on screen, and that is what
// the app grew into: the draft every 15 s, the change list every 15 s, the
// repository status every 20 s, the findings every 30 s, each on its own timer,
// each re-fetching in full whether or not anything had happened. Meanwhile the
// GRID - the one thing the parameters page is actually made of, and the most
// expensive read the service serves - was on no timer at all. So the app paid
// for constant polling and still could not see a colleague's edit.
//
// This inverts it. Nothing on screen polls. One endpoint answers "what revision
// is the world at" in a few dozen bytes, this hook asks only that, and the
// expensive reads are invalidated only when the answer actually CHANGES. A
// quiet workspace costs one tiny response per interval however many views are
// open; a busy one refreshes everything exactly once per real event.
//
// Two properties keep it honest:
//
//   - It is mounted ONCE, at the top of the app. A heartbeat per view is just
//     the old problem with extra steps.
//   - It goes through useRepoQuery, so it inherits the gating the rest of the
//     app has: no application connected, connection down, tab in the
//     background - it stops, like everything else. Polling a service that just
//     fell over is how a blip becomes an outage.

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useRepoQuery } from "./repoQuery";

// What still polls on its own, and why - so the next person does not "finish
// the job" and break something:
//
//   the health probe (deployment.ts)  the recovery watchdog. It is what notices
//                                     the service coming back, so it cannot
//                                     depend on a repo-scoped read.
//   the workspace (Home, Applications, App.tsx)
//                                     CROSS-application. One application's
//                                     revision says nothing about another being
//                                     added, opened or failing.
//   the inbox and the change overview  also cross-application.
//   incoming source changes            a fetch out to Vault or another
//                                     repository, on its own slow cadence.
//   PR checks                          GitHub's state, not ours.
//
// Everything else that belongs to ONE application now waits for the heartbeat.

/** How often to ask. Short enough that a colleague's change lands while you are
 *  still looking at the same screen, long enough that an idle tab is not a
 *  traffic source. The reply is a few dozen bytes and touches no files. */
const PULSE_MS = 10_000;

/** Everything whose answer can change when the repository or the change store
 *  moves. Prefix keys: `["grid", "change", 7]` is invalidated by `["grid"]`,
 *  which is what makes a change-scoped grid read refresh with the rest.
 *
 *  Deliberately a LIST rather than invalidating everything: an unqualified
 *  invalidate would also drop the presets, the capabilities and the region
 *  tables, none of which can change without a deploy, and re-fetch them on
 *  every heartbeat that saw a commit. */
const REPO_KEYS = [
  ["grid"],
  ["draft"],
  ["changes"],
  ["project-info"],
  ["paramHistory"],
  ["files"],
  ["files-draft"],
  ["files-committed"],
  ["repo-status"],
  ["findings"],
  ["instances"],
  ["timeline"],
  ["history"],
  ["change"],
] as const;

function invalidateRepoReads(qc: ReturnType<typeof useQueryClient>) {
  for (const key of REPO_KEYS) qc.invalidateQueries({ queryKey: key });
}

/** What a refresh control needs to describe the heartbeat. */
export interface PulseStatus {
  /** epoch ms of the last confirmed answer (0 while none has arrived) */
  checkedAt: number;
  /** a check is in flight */
  checking: boolean;
  /** the heartbeat itself could not be reached */
  failed: boolean;
}

/**
 * usePulseStatus OBSERVES the heartbeat without driving it: no interval of its
 * own, no invalidation. Any number of views may call it.
 *
 * It exists so that showing "up to date" next to a refresh button does not
 * quietly start a second heartbeat. React Query keeps one cache entry and one
 * timer per key, so an observer with no interval rides along on the owner's
 * poll and re-renders when the answer lands - but an observer that also ran the
 * invalidation effect would fire it once per mounted view, which is the
 * duplicated-refresh problem this whole file exists to remove.
 */
export function usePulseStatus(): PulseStatus {
  const q = useRepoQuery({ queryKey: ["revision"], queryFn: api.revision, retry: false, gcTime: Infinity });
  return { checkedAt: q.dataUpdatedAt, checking: q.isFetching, failed: q.isError };
}

/**
 * useRepoPulse OWNS the heartbeat: it is the one that polls, and the one that
 * refreshes the reads when the answer moves. Mount it EXACTLY ONCE, near the
 * root; everywhere else wants usePulseStatus.
 */
export function useRepoPulse(): PulseStatus {
  const qc = useQueryClient();
  const q = useRepoQuery({
    queryKey: ["revision"],
    queryFn: api.revision,
    refetchInterval: PULSE_MS,
    // A heartbeat that retries is a heartbeat that stampedes a service which is
    // already struggling. The next beat is the retry.
    retry: false,
    gcTime: Infinity,
  });

  // The revision we have already refreshed for. A ref rather than state: this
  // must not itself cause a render, and comparing against a stale closure would
  // re-invalidate on every beat.
  const seen = useRef<string | null>(null);
  const rev = q.data ? `${q.data.head}|${q.data.changes}` : null;

  useEffect(() => {
    if (!rev) return;
    // The FIRST answer is the baseline, not an event: everything on screen was
    // just loaded against it, and treating it as a change would make every page
    // load refetch itself once for nothing.
    if (seen.current === null) {
      seen.current = rev;
      return;
    }
    if (seen.current === rev) return;
    seen.current = rev;
    invalidateRepoReads(qc);
  }, [rev, qc]);

  return { checkedAt: q.dataUpdatedAt, checking: q.isFetching, failed: q.isError };
}

/**
 * useRefreshRepo is the manual "check now". It re-asks the heartbeat AND
 * re-reads everything outright, because somebody who pressed a refresh button
 * is telling you they do not trust the last answer - honouring that with
 * "the revision is unchanged, nothing to do" is technically correct and
 * useless.
 */
export function useRefreshRepo() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["revision"] });
    invalidateRepoReads(qc);
  };
}
