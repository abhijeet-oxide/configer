// A small bridge so code outside React (the react-query cache handlers) can
// raise theme-aware Ant Design notifications. A component inside <AntApp> calls
// setNotifier with the context instance on mount; until then we fall back to the
// console so nothing is ever swallowed silently.
import type { NotificationInstance } from "antd/es/notification/interface";
import { ApiError, TimeoutError } from "./api";
import { OfflineError } from "./offline";
import { recordNote } from "./notifications";

let notifier: NotificationInstance | null = null;

export function setNotifier(n: NotificationInstance) {
  notifier = n;
}

// describeError turns any thrown value into a user-facing title + description,
// so the UI NEVER shows a raw stack, a false success, or nothing at all. The
// stable machine code and the requestId are included so a user can quote them.
export function describeError(err: unknown): { title: string; detail: string; requestId?: string } {
  if (err instanceof ApiError) {
    if (err.isForbidden) return { title: "You do not have permission for that", detail: err.message, requestId: err.requestId };
    if (err.isRateLimited)
      return {
        title: "Too many requests",
        detail: err.retryAfter ? `Please wait ${err.retryAfter}s and try again.` : err.message,
        requestId: err.requestId,
      };
    if (err.isConflict) return { title: "This changed since you loaded it", detail: err.message, requestId: err.requestId };
    if (err.isNoRepository)
      return { title: "No application is connected yet", detail: "Add an application to start managing its configuration." };
    if (err.isUnknownRepository)
      return { title: "That application is not connected here", detail: err.message };
    if (err.status === 502 || err.status === 504)
      return { title: "A downstream service did not respond", detail: err.message, requestId: err.requestId };
    if (err.isServer) return { title: "Something went wrong on the server", detail: err.message, requestId: err.requestId };
    return { title: err.message, detail: "", requestId: err.requestId };
  }
  if (err instanceof TimeoutError) return { title: "The request timed out", detail: "The service did not respond in time. Please try again." };
  if (err instanceof OfflineError)
    return { title: "You appear to be offline", detail: "Configer will keep working from the last snapshot and sync when the connection returns." };
  if (err instanceof Error) return { title: err.message, detail: "" };
  return { title: "Unexpected error", detail: String(err) };
}

// shouldToast decides whether an error deserves a popup. A 401 is handled by the
// sign-in prompt, and an offline blip is handled by the persistent offline
// banner, so neither should raise a transient toast on top.
export function shouldToast(err: unknown): boolean {
  if (err instanceof ApiError && err.isUnauthorized) return false;
  // "No application is connected" is a state, not a failure: the workspace
  // shows its own empty state and invites the user to connect one.
  if (err instanceof ApiError && err.isNoRepository) return false;
  // Same for an application this deployment does not have: the workspace shows
  // that state once, with a way out, instead of one toast per failed read.
  if (err instanceof ApiError && err.isUnknownRepository) return false;
  if (err instanceof OfflineError) return false;
  return true;
}

// A message from the service is a fragment ("the repository could not be
// found"): correct in a toast title, wrong in the middle of a paragraph. This
// makes one out of it, so inline notices read as sentences.
export function sentence(text?: string): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const head = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(head) ? head : head + ".";
}

export function notifyError(err: unknown) {
  if (!shouldToast(err)) return;
  const { title, detail, requestId } = describeError(err);
  const description = requestId ? `${detail}${detail ? " " : ""}(ref: ${requestId})`.trim() : detail;
  // Recorded first, so a message that scrolls past (or lands while the user is
  // looking elsewhere) can still be read afterwards from the bell.
  recordNote({ kind: "error", title, detail: detail || undefined, requestId });
  if (notifier) {
    notifier.error({ message: title, description: description || undefined, placement: "bottomRight" });
  } else {
    console.error("[configer]", title, description, err);
  }
}

/** Raise (and record) a non-failure notification worth keeping - something
 *  finished, something arrived. Transient "saved" confirmations stay plain
 *  messages; this is for the ones a user may want to look up later. */
export function notify(kind: "success" | "info" | "warning", title: string, detail?: string) {
  recordNote({ kind, title, detail });
  if (notifier) notifier[kind]({ message: title, description: detail, placement: "bottomRight" });
}
