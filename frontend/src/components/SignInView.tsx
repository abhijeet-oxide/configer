import { Button, Typography } from "antd";
import { GithubOutlined, CheckCircleFilled, MoonOutlined, SunOutlined } from "../icons";
import { theme as brand } from "../theme.config";
import { useDeployment } from "../deployment";
import { type SignedOutReason } from "../session";
import { BrandLockup } from "../uikit";
import { pointOf, useTheme } from "../uikit";
import { useUI } from "../store";
import { SessionExpiredArt, SignedOutArt, WorkspaceArt } from "./illustrations";

// The front door of a deployment that has sign-in configured: the FIRST page a
// visitor sees, before any application, any grid, any read.
//
// It exists because the alternative is what a signed-out visitor used to get -
// the whole app rendering into requests it is not allowed to make, and a popup
// repeating "your session has expired" over every one of them. Nothing here
// makes a repo-scoped request, so there is nothing to fail.
//
// Three ways to arrive, two shapes:
//
//   arriving   -> the welcome: a split page whose left half is the product's
//                 own subject matter (config files, stacked and wired, with the
//                 gear that resolves them), because a stranger's first question
//                 is "what is this", not "where do I type".
//   ending     -> a single centered card: an ended session is a small, finished
//                 event, and a half-page illustration would make it look like a
//                 fault. One picture, one sentence, one way back in.
//
// Both stand on the same canvas as the boot screen and the service-unavailable
// page, so every page that stands between a person and their work belongs to
// one family.

/** The one address that starts a login, carrying the page to come back to -
 *  by default the one the user is on. A caller that is mid-flow passes where it
 *  wants to resume instead, so signing in returns to the step rather than to
 *  the page. The endpoint is provider-agnostic (GitHub today), so nothing here
 *  changes when a deployment adds another. */
export function loginHref(returnTo?: string): string {
  const here = returnTo ?? window.location.pathname + window.location.search;
  return `/api/auth/login?return_to=${encodeURIComponent(here)}`;
}

/** Every page in this family sits on the same canvas, with the theme toggle in
 *  the same corner: someone who lands here in the wrong theme can fix it before
 *  signing in. */
function AuthCanvas({ children }: { children: React.ReactNode }) {
  const mode = useUI((s) => s.mode);
  const { toggleMode } = useTheme();
  return (
    <div className="auth-screen">
      <Button
        className="auth-theme-toggle"
        type="text"
        aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        icon={mode === "dark" ? <SunOutlined /> : <MoonOutlined />}
        onClick={(e) => toggleMode(pointOf(e))}
      />
      {children}
    </div>
  );
}

/** The brand lockup: the mark, the product, and what it does. It is the shared
 *  design system's, so it is the same block on the boot screen, the
 *  service-unavailable page and here - and so the alignment bug it used to
 *  carry cannot come back on one page and not the others. (The name and the
 *  caption are different widths, and this card centres its text: aligned to
 *  the card rather than to itself, the short name floated to the middle of the
 *  box the caption sized and read as a hole punched beside the mark.) */
function Lockup({ size = 34 }: { size?: number }) {
  return <BrandLockup brand={brand} size={size} />;
}

function DeploymentLine() {
  const deployment = useDeployment();
  return (
    <Typography.Text type="secondary" className="auth-foot">
      {deployment.name}
      {deployment.version ? ` ${deployment.version}` : ""}
      {deployment.environment ? ` · ${deployment.environment}` : ""}
    </Typography.Text>
  );
}

export default function SignInView({ reason }: { reason: SignedOutReason }) {
  if (reason === "new") return <Welcome />;
  return <SessionEnded reason={reason} />;
}

// --- arriving ---------------------------------------------------------------

function Welcome() {
  return (
    <AuthCanvas>
      <div className="auth-split">
        {/* Left: what this is. The illustration is the product's own material -
            config files in order - not a stock padlock. */}
        <aside className="auth-aside">
          <Lockup />
          <div className="auth-aside-inner">
            <div className="auth-aside-art">
              <WorkspaceArt />
            </div>
            <div className="auth-aside-copy">
              <h2 className="auth-aside-title">Your repository, as a grid you can edit.</h2>
              <p className="auth-aside-text">
                Configer reads the configuration already in your Git repository, shows it as
                parameters across instances, and writes your edits back into those same files.
              </p>
            </div>
          </div>
        </aside>

        {/* Right: the one thing to do. */}
        <main className="auth-main">
          <div className="auth-panel">
            <Typography.Title level={2} className="auth-title">
              Welcome
            </Typography.Title>
            <Typography.Paragraph type="secondary" className="auth-body">
              Sign in to continue to {brand.appName}. You will see the repositories you already
              have access to on GitHub - nothing else.
            </Typography.Paragraph>

            <Button
              type="primary"
              size="large"
              block
              icon={<GithubOutlined />}
              href={loginHref()}
              className="auth-cta"
            >
              Continue with GitHub
            </Button>

            <ul className="auth-points">
              <li>
                <CheckCircleFilled /> Your configuration stays in Git. Configer edits your
                repository's own files and never copies them into a separate database.
              </li>
              <li>
                <CheckCircleFilled /> Every change becomes an ordinary branch, commit and pull
                request, reviewable wherever you review code today.
              </li>
              <li>
                <CheckCircleFilled /> You see the applications your role allows, and nothing
                outside it.
              </li>
            </ul>

            <div className="auth-note">
              No account yet? Sign in once and an administrator can give you access to an
              application.
            </div>
            <DeploymentLine />
          </div>
        </main>
      </div>
    </AuthCanvas>
  );
}

// --- ending -----------------------------------------------------------------

const ENDED: Record<
  "expired" | "signed-out",
  { title: string; body: string; cta: string; art: (size: number) => React.ReactNode }
> = {
  expired: {
    title: "Session expired",
    body: "Sessions end after a period away, and this one has. Nothing was lost: every change you saved is in Git.",
    cta: "Sign in again",
    art: (size) => <SessionExpiredArt size={size} />,
  },
  "signed-out": {
    title: "You're signed out",
    body: "This device no longer holds a session. Your configuration and any submitted changes are safe in Git.",
    cta: "Sign in again",
    art: (size) => <SignedOutArt size={size} />,
  },
};

function SessionEnded({ reason }: { reason: "expired" | "signed-out" }) {
  const copy = ENDED[reason];
  return (
    <AuthCanvas>
      <div className="auth-centered">
        <div className="auth-card">
          <Lockup size={30} />
          <div className="auth-card-art">{copy.art(140)}</div>
          <Typography.Title level={3} className="auth-title">
            {copy.title}
          </Typography.Title>
          <Typography.Paragraph type="secondary" className="auth-body">
            {copy.body}
          </Typography.Paragraph>
          {/* One action. Every page of this product needs a session, so a
              second button ("go to the start page") would lead straight back
              here - a dead end dressed up as a choice. */}
          <div className="auth-card-actions">
            <Button
              type="primary"
              size="large"
              block
              icon={<GithubOutlined />}
              // An ended session starts over at the beginning rather than at
              // whichever deep link happened to expire.
              href="/api/auth/login"
              className="auth-cta"
            >
              {copy.cta}
            </Button>
          </div>
          <DeploymentLine />
        </div>
      </div>
    </AuthCanvas>
  );
}
