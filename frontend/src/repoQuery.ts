// useRepoQuery is the one way to read something that belongs to ONE
// application.
//
// Every repo-scoped endpoint lives under /api/repos/<id>/…, so a read issued
// while no application is selected has nothing to address: the service answers
// 503 "no application is connected yet". That is not a failure - it is the
// ordinary state of a fresh or emptied workspace - so the UI must not poll for
// it, must not toast it, and must not paint an error. Gating the query here
// means the whole app inherits the behaviour instead of each view remembering
// to check.
import {
  useQuery,
  type DefaultError,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useConn } from "./offline";
import { useUI } from "./store";

export function useRepoQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): UseQueryResult<TData, TError> {
  const repoId = useUI((s) => s.repoId);
  // An application that is still connecting - or whose connection failed - has
  // no server behind it. Reading from it would answer "this application is not
  // connected" on every request, once per view, forever; the workspace shows
  // that state once instead.
  const readable = useUI((s) => s.repoReadable);
  // The circuit breaker. A page carries a dozen polling reads, each of which
  // retries a failure three times with backoff, so an unreachable service used
  // to receive MORE traffic than a healthy one - 53 requests a minute from a
  // single tab against 19 when everything was fine, multiplied by every open
  // tab, led by the most expensive endpoint there is. Hammering a service that
  // just fell over is how a blip becomes an outage.
  //
  // So while the connection is known to be down, the repo-scoped reads stop.
  // One probe stays alive to watch for recovery (useHealth, 15 s, no retries),
  // and any successful response anywhere flips the flag back; the queries then
  // re-enable and refetch on their own. Views keep rendering from cache, and
  // the connection banner - not a dead read - is what tells the user.
  const online = useConn((s) => s.online);
  return useQuery({
    ...options,
    enabled: !!repoId && readable && online && options.enabled !== false,
  });
}
