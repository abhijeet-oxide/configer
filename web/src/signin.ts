import { beginSignIn } from "./authkit/session";

/** Starts a platform sign-in and comes back to this page, or to `returnTo`. */
export function signIn(returnTo?: string): void {
  void beginSignIn({ returnTo: returnTo ?? window.location.pathname + window.location.search });
}
