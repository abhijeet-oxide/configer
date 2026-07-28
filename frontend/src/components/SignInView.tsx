import { Button, Typography } from "antd";
import { GithubOutlined, CheckCircleFilled } from "../icons";
import { theme as brand } from "../theme.config";
import { useDeployment } from "../deployment";
import { type SignedOutReason } from "../session";
import BrandMark from "./BrandMark";
import { toggleThemeWithReveal } from "../themeTransition";
import { useUI } from "../store";
import { SunOutlined, MoonOutlined } from "../icons";

// SignInView is the front door of a deployment that has sign-in configured:
// the FIRST page a visitor sees, before any application, any grid, any read.
//
// It exists because the alternative is what a signed-out visitor used to get -
// the whole app rendering into requests it is not allowed to make, and a popup
// repeating "your session has expired" over every one of them. Nothing here
// makes a repo-scoped request, so there is nothing to fail: one page, one
// action, and words that say which of the three ways to arrive here happened.

const COPY: Record<SignedOutReason, { title: string; body: string; cta: string }> = {
  new: {
    title: `Sign in to ${brand.appName}`,
    body: "Your configuration lives in Git. Sign in with GitHub and you'll see the repositories you have access to, the changes waiting for review, and everything you're allowed to edit.",
    cta: "Continue with GitHub",
  },
  expired: {
    title: "Your session has ended",
    body: "Sessions expire after a period away, and this one has. Nothing was lost: every change you saved is in Git. Sign in again to pick up where you left off.",
    cta: "Sign in again",
  },
  "signed-out": {
    title: "You're signed out",
    body: `You've been signed out of ${brand.appName} on this device. Your configuration and any submitted changes are safe in Git.`,
    cta: "Sign in again",
  },
};

// The one address that starts a login, with the page the user is on so the
// server can return them to it. The endpoint is provider-agnostic (GitHub
// today), so nothing here changes when a deployment adds another one.
export function loginHref(): string {
  const here = window.location.pathname + window.location.search;
  return `/api/auth/login?return_to=${encodeURIComponent(here)}`;
}

export default function SignInView({ reason }: { reason: SignedOutReason }) {
  const deployment = useDeployment();
  const mode = useUI((s) => s.mode);
  const copy = COPY[reason];
  const signedOut = reason === "signed-out";

  return (
    <div className="signin-screen">
      <Button
        className="signin-theme-toggle"
        type="text"
        aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        icon={mode === "dark" ? <SunOutlined /> : <MoonOutlined />}
        onClick={(e) => toggleThemeWithReveal({ x: e.clientX, y: e.clientY })}
      />
      <div className="signin-card">
        <div className="signin-brand">
          <BrandMark size={40} />
          <div className="signin-brand-text">
            <span className="signin-brand-name">{brand.appName}</span>
            <span className="signin-brand-tag">Configuration, managed in Git</span>
          </div>
        </div>

        <Typography.Title level={3} className="signin-title">
          {copy.title}
        </Typography.Title>
        <Typography.Paragraph type="secondary" className="signin-body">
          {copy.body}
        </Typography.Paragraph>

        <Button
          type="primary"
          size="large"
          block
          icon={<GithubOutlined />}
          href={signedOut ? "/api/auth/login" : loginHref()}
          className="signin-cta"
        >
          {copy.cta}
        </Button>

        <ul className="signin-points">
          <li>
            <CheckCircleFilled /> Configer reads and writes your repository's own files - nothing is
            copied into a separate database.
          </li>
          <li>
            <CheckCircleFilled /> Every edit becomes an ordinary branch, commit and pull request you
            can review in Git.
          </li>
          <li>
            <CheckCircleFilled /> You only see the applications and actions your role allows.
          </li>
        </ul>

        <Typography.Text type="secondary" className="signin-foot">
          {deployment.name}
          {deployment.version ? ` ${deployment.version}` : ""}
          {deployment.environment ? ` · ${deployment.environment}` : ""}
        </Typography.Text>
      </div>
    </div>
  );
}
