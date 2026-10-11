import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, UNAUTHORIZED_EVENT } from "../api";
import { useSession } from "../session";
import { BootSplash } from "./BootGate";
import SignInView from "./SignInView";

// AuthGate answers the second question the app has to ask (the first is
// BootGate's "is the service there?"): may this browser see anything at all.
//
// On a deployment with sign-in configured, a signed-out visitor is shown the
// sign-in page and NOTHING else renders. That is the whole point: every view
// below this gate reads something the service refuses without a session, so
// rendering them first produced a page built out of failed requests and a
// popup that came back as fast as it was dismissed. One page, one action.
//
// Deployments without sign-in (the single-user tool) never see this gate: the
// service says login is not configured and the app renders straight through.

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const reason = useSession((s) => s.reason);
  const sessionExpired = useSession((s) => s.sessionExpired);
  const clearReason = useSession((s) => s.clear);

  const meQ = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    staleTime: 60_000,
    // Identity is not a read to retry behind the user's back: either the
    // browser carries a session or it does not.
    retry: false,
  });

  // A 401 from anywhere means the session is gone. Rather than a popup per
  // failed request, note WHY and re-ask who we are; the gate then swaps the app
  // for the sign-in page, once.
  useEffect(() => {
    const onUnauthorized = () => {
      sessionExpired();
      void qc.invalidateQueries({ queryKey: ["me"] });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc, sessionExpired]);

  const me = meQ.data;
  const signedIn = !!me && (!me.enabled || !!me.user);

  // Forget how the last session ended only when a NEW one begins - the
  // transition from signed out to signed in. Clearing it merely because
  // somebody is signed in would race the expiry itself: the 401 arrives while
  // the previous identity is still cached, and the page would greet an
  // interrupted user with "Welcome" instead of telling them what happened.
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (signedIn && !wasSignedIn.current && reason !== "new") clearReason();
    wasSignedIn.current = signedIn;
  }, [signedIn, reason, clearReason]);

  // Before the answer arrives, show the product's own quiet canvas rather than
  // a flash of the app the visitor may not be allowed to see.
  if (!me && meQ.isPending) return <BootSplash label="Signing in" />;
  // The identity probe itself failed (not a 401 - the service answered the boot
  // probe). Let the app render and surface its own errors rather than locking
  // the user out of a working deployment over one failed read.
  if (!me) return <>{children}</>;
  if (me.enabled && !me.user) return <SignInView reason={reason} />;
  return <>{children}</>;
}
