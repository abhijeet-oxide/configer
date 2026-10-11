import { apiBaseUrl } from "./api";
import { connection, type Probe } from "./uikit";

// Points the shared connection monitor at this deployment's health endpoint,
// the way Software Gateway's watchService does, so the rail's deployment pill
// and the kit's outage surfaces report the real service.
const probe: Probe = async (signal) => {
  const path = `${apiBaseUrl()}/health`;
  const res = await fetch(path, { cache: "no-store", headers: { Accept: "application/json" }, signal });
  if (res.status === 503) return { verdict: "unavailable", status: 503, detail: `${path} answered 503.` };
  if (res.status === 502 || res.status === 504)
    return { verdict: "unreachable", status: res.status, detail: `${path} answered ${res.status}.` };
  return res.ok
    ? { verdict: "ok", status: res.status }
    : { verdict: "unavailable", status: res.status, detail: `${path} answered ${res.status}.` };
};

connection.configure({ probe });
