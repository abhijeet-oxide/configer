// Signing out, in one place, so every entry point (the profile menu, the
// Settings page, the phone tier) ends the session the same way: the service
// forgets the session, the browser forgets everything that was read with it,
// and the app lands on the sign-out page instead of silently failing its next
// request. A failed sign-out says so rather than pretending it worked.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { notifyError } from "./notify";
import { useSession } from "./session";

export function useSignOut() {
  const qc = useQueryClient();
  const markSignedOut = useSession((s) => s.signedOut);
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      markSignedOut();
      // Nothing read under the old session may survive into the next one.
      qc.clear();
    },
    onError: (e) => notifyError(e),
  });
}
