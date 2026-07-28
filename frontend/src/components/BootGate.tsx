import { useEffect, useState } from "react";
import { Button, Typography } from "antd";
import { ReloadOutlined } from "../icons";
import { ApiError, apiBaseUrl } from "../api";
import { useHealth } from "../deployment";
import { theme as brand } from "../theme.config";
import BrandMark from "./BrandMark";
import { OfflineArt } from "./illustrations";

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
export function BootSplash({ label = "Starting" }: { label?: string }) {
  return (
    <div className="boot-screen">
      <div className="boot-splash">
        <BrandMark size={44} />
        <Typography.Text strong style={{ fontSize: 15 }}>
          {brand.appName}
        </Typography.Text>
        <span className="boot-progress" aria-label={label} />
      </div>
    </div>
  );
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
    <div className="boot-screen">
      <div className="boot-card">
        <div className="boot-card-brand">
          <BrandMark />
          <Typography.Text strong>{brand.appName}</Typography.Text>
        </div>
        <OfflineArt size={120} />
        <Typography.Title level={4} style={{ margin: "10px 0 0" }}>
          {misaddressed
            ? `${brand.appName} can’t find its service`
            : `${brand.appName} can’t reach its service`}
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 13.5 }}>
          {misaddressed ? (
            <>
              Something answered at the configured address, but it isn&rsquo;t the {brand.appName}
              {" "}API. The service address this page is built with looks wrong - an administrator
              can correct it.
            </>
          ) : (
            <>
              The service isn&rsquo;t responding right now. It may be starting up, restarting, or
              briefly under maintenance. Nothing you have saved is affected - your configuration
              lives in Git.
            </>
          )}
        </Typography.Text>
        {misaddressed && (
          <code className="boot-card-detail">
            {apiBaseUrl()}/health {"->"} {(error as ApiError).status}
          </code>
        )}
        <div className="boot-card-actions">
          <Button type="primary" icon={<ReloadOutlined />} loading={retrying} onClick={onRetry}>
            Try again
          </Button>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {retrying ? "Checking…" : `Checking again in ${left}s`}
        </Typography.Text>
      </div>
    </div>
  );
}
