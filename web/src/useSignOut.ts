// Signing out, in one place, so every entry point (the profile menu, the
// Settings page, the phone tier) ends the session the same way: here and at
// the platform's identity provider, landing on the platform's signed-out page.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { signOut } from "./authkit/session";
import { notifyError } from "./notify";

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // Nothing read under the old session may survive into the next one.
      qc.clear();
      await signOut(`${window.location.origin}/signed-out`);
    },
    onError: (e) => notifyError(e),
  });
}
