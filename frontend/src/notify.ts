// A small bridge so code outside React (the react-query cache handlers) can
// raise theme-aware Ant Design notifications. A component inside <AntApp> calls
// setNotifier with the context instance on mount; until then we fall back to the
// console so nothing is ever swallowed silently.
import type { NotificationInstance } from "antd/es/notification/interface";
import { ApiError, TimeoutError } from "./api";
import { OfflineError } from "./offline";

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
  if (err instanceof OfflineError) return false;
  return true;
}

export function notifyError(err: unknown) {
  if (!shouldToast(err)) return;
  const { title, detail, requestId } = describeError(err);
  const description = requestId ? `${detail}${detail ? " " : ""}(ref: ${requestId})`.trim() : detail;
  if (notifier) {
    notifier.error({ message: title, description: description || undefined, placement: "bottomRight" });
  } else {
    console.error("[configer]", title, description, err);
  }
}
