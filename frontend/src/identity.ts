import { useQuery } from "@tanstack/react-query";
import { api, type AuthUser, type RoleName } from "./api";
import { useUI } from "./store";

// useIdentity is the one answer to "who is using Configer right now, and what
// can they do here". Every surface that shows the person (the rail's profile
// card, the Settings page, menus) reads this hook so name and role can never
// disagree between surfaces.
//
// Single-user deployments (login not configured) still have an identity: a
// local operator with full access. That keeps the profile surfaces meaningful
// everywhere instead of vanishing when OAuth is off.

export interface Identity {
  /** whether login is configured on this deployment */
  authEnabled: boolean;
  /** signed in (always true in single-user mode: the local operator) */
  signedIn: boolean;
  /** the raw platform user, when signed in via OAuth */
  user: AuthUser | null;
  /** what to call the person, always set: name > login > "Local user" */
  displayName: string;
  /** capability on the ACTIVE application, in glossary words */
  roleLabel: string;
  role: RoleName | null;
  admin: boolean;
  loading: boolean;
}

const ROLE_LABELS: Record<RoleName, string> = {
  viewer: "Viewer",
  editor: "Editor",
  approver: "Approver",
};

export function useIdentity(): Identity {
  const repoId = useUI((s) => s.repoId);
  const meQ = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
  const me = meQ.data;
  const signedIn = !me?.enabled || !!me.user;
  const roleQ = useQuery({
    queryKey: ["my-role", repoId],
    queryFn: () => api.myRole(repoId!),
    enabled: !!repoId && !!me && signedIn,
    staleTime: 60_000,
  });

  if (!me) {
    return {
      authEnabled: false, signedIn: false, user: null, displayName: "",
      roleLabel: "", role: null, admin: false, loading: true,
    };
  }

  if (!me.enabled) {
    // Single-user mode: no login, one local operator with every capability.
    return {
      authEnabled: false, signedIn: true, user: null, displayName: "Local user",
      roleLabel: "Full access", role: "approver", admin: true, loading: false,
    };
  }

  const user = me.user ?? null;
  const admin = !!user?.admin || !!roleQ.data?.admin;
  const role = roleQ.data?.role ?? null;
  return {
    authEnabled: true,
    signedIn: !!user,
    user,
    displayName: user?.name || user?.login || "",
    // Admins approve everywhere; that outranks any per-application role.
    roleLabel: admin ? "Administrator" : role ? ROLE_LABELS[role] : "",
    role,
    admin,
    loading: false,
  };
}
