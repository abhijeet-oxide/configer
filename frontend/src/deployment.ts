// The deployment's own identity: which Configer this is, which version, and
// which environment it serves.
//
// This is a property of the SERVICE, not of any one application, so it is read
// from /api/health - the only identity endpoint that answers before (and
// without) an application being connected. /api/meta carries the same fields
// but is repo-scoped, so a workspace with no applications cannot use it.
import { useQuery } from "@tanstack/react-query";
import { api, type Capabilities, type Health } from "./api";

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

/**
 * What this deployment supports. Until the answer arrives we assume the
 * conservative shape - hosted, no integrations - so no surface ever flashes an
 * option it then has to take away.
 */
export function useCapabilities(): Capabilities {
  const q = useQuery<Capabilities>({
    queryKey: ["capabilities"],
    queryFn: api.capabilities,
    staleTime: 300_000,
  });
  return (
    q.data ?? {
      localFolders: false,
      githubSignIn: false,
      githubBrowse: false,
      manualGitUrl: true,
      hosted: true,
    }
  );
}

/**
 * What a new application can be connected FROM, in the user's words. Written
 * once here because every surface that invites the first application repeats
 * it, and promising a "local folder" on a hosted deployment sends the user
 * looking for their own files on a machine they have never seen.
 */
export function sourceNoun(caps: Capabilities): string {
  return caps.localFolders ? "Git repository or local folder" : "Git repository";
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
