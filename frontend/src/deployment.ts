// The deployment's own identity: which Configer this is, which version, and
// which environment it serves.
//
// This is a property of the SERVICE, not of any one application, so it is read
// from /api/health - the only identity endpoint that answers before (and
// without) an application being connected. /api/meta carries the same fields
// but is repo-scoped, so a workspace with no applications cannot use it.
import { useQuery } from "@tanstack/react-query";
import { api, type Health } from "./api";

export interface Deployment {
  name: string;
  version: string;
  environment: string;
  /** the service answered its liveness check */
  reachable: boolean;
}

/** The shared boot/heartbeat probe. One query key, so every caller (the boot
 *  gate, the deployment chip, the offline panel) rides the same request. */
export const HEALTH_KEY = ["health"] as const;

export function useHealth() {
  return useQuery<Health>({
    queryKey: HEALTH_KEY,
    queryFn: () => api.health({ timeoutMs: 8_000 }),
    // Keep probing while unreachable so recovery is automatic; a failed probe
    // is the signal itself, so it is never retried behind the user's back.
    refetchInterval: 15_000,
    retry: false,
    staleTime: 10_000,
  });
}

/** Deployment identity for display. Falls back to the product name so a label
 *  never renders as an empty gap while the first probe is in flight. */
export function useDeployment(): Deployment {
  const q = useHealth();
  return {
    name: q.data?.name || "Configer",
    version: q.data?.version || "",
    environment: q.data?.environment || "",
    reachable: !!q.data,
  };
}
