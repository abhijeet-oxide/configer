import { useEffect, useState } from "react";
import { ReloadOutlined } from "../icons";
import { ApiError, apiBaseUrl } from "../api";
import { useHealth } from "../deployment";
import brand from "../brand";
import { BootSplash as SharedBootSplash, StatusScreen } from "../uikit";
import { ServiceDownArt } from "./illustrations";

// BootGate answers the first question the app has to ask: is the service there?
//
// Until we know, nothing else may render - every view would otherwise fire its
// own reads into the dark and paint a page made of failed requests. So the app
// boots behind one probe:
//
//   probing  -> a quiet branded screen (the logo, nothing that looks broken)
//   no answer-> the service-unavailable page below, retrying on its own
//   answered -> the app, for the rest of the session
//
// Once the service has answered even once, the gate steps aside for good: a
// later blip is a temporary outage, and the connection banner handles that
// without taking the workspace away from the user.

const RETRY_SECONDS = 15;

export default function BootGate({ children }: { children: React.ReactNode }) {
  const q = useHealth();
  // A probe that answers in a few hundred milliseconds should not flash a
  // splash screen; hold the boot screen back briefly so a fast start is silent.
  const [showSplash, setShowSplash] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShowSplash(true), 350);
    return () => clearTimeout(t);
  }, []);

  // q.data survives later failures, so its presence means "the service has
  // answered at least once" - the gate's one-way door.
  if (q.data) return <>{children}</>;
  if (q.isError) {
    return (
      <ServiceUnavailable
        error={q.error}
        onRetry={() => q.refetch()}
        retrying={q.isFetching}
      />
    );
  }
  return showSplash ? <BootSplash /> : null;
}

// A 4xx to the liveness probe means something answered - it just was not this
// API. That is an address problem (the configured base URL is missing its /api
// prefix, or points at the wrong service), and it is worth saying so: it is the
// difference between "wait for the service" and "fix one setting".
function isWrongAddress(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

// BootSplash is the in-between: the product's own mark on its own canvas, so
// the first paint already belongs to the app rather than being a blank page.
// The screen itself is the shared design system's, so this moment looks the
// same in every tool on the platform.
export function BootSplash({ label = "Starting" }: { label?: string }) {
  return <SharedBootSplash brand={brand} label={label} />;
}

// ServiceUnavailable is the full-page state for "the probe did not succeed".
// It says what happened in plain words, keeps retrying on its own with a
// visible count, and offers the manual retry - no stack traces, no dead end.
// When the failure is an address problem it names the address instead, because
// waiting will never fix that one.
function ServiceUnavailable({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const [left, setLeft] = useState(RETRY_SECONDS);
  useEffect(() => {
    if (retrying) {
      setLeft(RETRY_SECONDS);
      return;
    }
    const t = setInterval(() => setLeft((n) => (n <= 1 ? RETRY_SECONDS : n - 1)), 1000);
    return () => clearInterval(t);
  }, [retrying]);

  const misaddressed = isWrongAddress(error);
  return (
    <StatusScreen
      brand={brand}
      art={<ServiceDownArt size={140} />}
      title={misaddressed ? "Service not found at this address" : "Service unavailable"}
      actions={[
        {
          label: "Try again now",
          primary: true,
          icon: <ReloadOutlined />,
          loading: retrying,
          onClick: onRetry,
        },
      ]}
      note={
        misaddressed ? (
          <code>
            {apiBaseUrl()}/health {"->"} {(error as ApiError).status}
          </code>
        ) : (
          // The wait is said plainly rather than as a number nobody asked for:
          // it tells the reader the page is working on it, and that they do not
          // have to do anything.
          <span role="status" aria-live="polite">
            {retrying ? "Checking\u2026" : `Checking again in ${left}s`}
          </span>
        )
      }
    >
      {misaddressed ? (
        <>
          Something answered at the configured address, but it isn&rsquo;t the {brand.appName}{" "}
          API. The address this page is built with looks wrong - an administrator can correct it.
        </>
      ) : (
        <>
          {brand.appName} can&rsquo;t reach its service right now. It may be starting up,
          restarting, or briefly under maintenance. Nothing you have saved is affected - your
          configuration lives in Git.
        </>
      )}
    </StatusScreen>
  );
}
