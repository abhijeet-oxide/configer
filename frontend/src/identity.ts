import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, setWritesAllowed, type AuthUser, type RoleName } from "./api";
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
  /** Capability on the ACTIVE application. A role is a property of (person,
   *  application): the same person is an approver on one and a viewer on the
   *  next, so no surface that shows a PERSON may label them with it. Surfaces
   *  that show an application read it from that application (RepoSummary.role,
   *  rendered by AccessPill) or from this hook while it is the active one. */
  role: RoleName | null;
  admin: boolean;
  /** may change configuration here: stage edits, submit, manage instances */
  canEdit: boolean;
  /** may publish: approve a change request and merge it */
  canApprove: boolean;
  loading: boolean;
}

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

  // Publish the capability to the request layer, which refuses a write from
  // someone who may not make one (see setWritesAllowed in api.ts). While the
  // identity is still loading the gate stays OPEN: no write affordance is on
  // screen yet anyway, and closing it early would refuse the offline queue's
  // replay - dropping edits the user already made. A definite "viewer" is the
  // only thing that closes it.
  const known = !!me;
  const mayWrite =
    !known || !me.enabled || !!me.user?.admin || !!roleQ.data?.admin ||
    roleQ.data?.role === "editor" || roleQ.data?.role === "approver";
  useEffect(() => setWritesAllowed(mayWrite), [mayWrite]);

  if (!me) {
    // Identity not known yet. Assume the least capability: a control that
    // appears and then disappears is worse than one that arrives a moment late,
    // and it must never be possible to click an action before we know it is
    // allowed.
    return {
      authEnabled: false, signedIn: false, user: null, displayName: "",
      role: null, admin: false,
      canEdit: false, canApprove: false, loading: true,
    };
  }

  if (!me.enabled) {
    // Single-user mode: no login, one local operator with every capability.
    return {
      authEnabled: false, signedIn: true, user: null, displayName: "Local user",
      role: "approver", admin: true,
      canEdit: true, canApprove: true, loading: false,
    };
  }

  const user = me.user ?? null;
  const admin = !!user?.admin || !!roleQ.data?.admin;
  const role = roleQ.data?.role ?? null;
  // The same rule the service enforces (api.requiredRole): reads need viewer,
  // any change needs editor, publishing needs approver, and a deployment admin
  // approves everywhere. Mirrored here so the UI can OFFER exactly what will
  // succeed - a control the caller cannot use should never be on screen.
  // Until the role read lands, `role` is null and both stay false.
  const canEdit = admin || role === "editor" || role === "approver";
  const canApprove = admin || role === "approver";
  return {
    authEnabled: true,
    signedIn: !!user,
    user,
    displayName: user?.name || user?.login || "",
    role,
    admin,
    canEdit,
    canApprove,
    loading: false,
  };
}
