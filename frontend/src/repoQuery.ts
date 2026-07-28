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
  return useQuery({
    ...options,
    enabled: !!repoId && readable && options.enabled !== false,
  });
}
