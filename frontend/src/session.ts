// Session state the whole app agrees on: is anyone signed in, and if not, WHY.
//
// "Not signed in" has three flavours and they deserve different words on the
// sign-in page: a first visit (nothing to explain), a session that ran out
// while the app was open (say so, so the user knows their work was not
// rejected), and a sign-out the user asked for (confirm it happened). Anything
// that learns one of these calls the setter here, and the gate renders it.
import { create } from "zustand";

export type SignedOutReason = "new" | "expired" | "signed-out";

interface SessionState {
  reason: SignedOutReason;
  /** the session ran out (or was never there) on a request the app just made */
  sessionExpired: () => void;
  /** the user signed out deliberately */
  signedOut: () => void;
  /** a fresh sign-in: forget how the last one ended */
  clear: () => void;
}

export const useSession = create<SessionState>((set) => ({
  reason: "new",
  sessionExpired: () => set((s) => (s.reason === "signed-out" ? s : { reason: "expired" })),
  signedOut: () => set({ reason: "signed-out" }),
  clear: () => set({ reason: "new" }),
}));
