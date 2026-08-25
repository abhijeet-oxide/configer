import { useQuery } from "@tanstack/react-query";
import {
  HomeOutlined,
  AppstoreOutlined,
  InboxOutlined,
  FileProtectOutlined,
  UserOutlined,
} from "../icons";
import { api } from "../api";
import { envHex, NavEntry, SideNav, type NavItem, type NavProfile } from "../uikit";
import brand from "../brand";
import { useUI } from "../store";
import { useIdentity } from "../identity";
import { useDeployment } from "../deployment";

// The navigation rail: the ONLY organization-scope navigator. It holds just
// what crosses applications: Home, Applications, Inbox (every change and
// approval that needs someone), Audit. Instances and Repositories are not
// top-level nouns - they live inside an application, reached through its tab
// strip. The rail's foot is the person: a profile card (who you are) that opens
// the Settings page, where every personal preference lives.
//
// The rail itself - its width, its item heights, the hover and active language,
// the collapse behaviour, the profile card, the badges - is `SideNav` from the
// shared design system, identical to the one the sibling tool mounts. What is
// Configer's is only WHICH entries there are and what they do.

// Which rail entry a section lights up. Every workspace-wide change and
// approval surface (changelog, drafts, approvals) resolves to the one Inbox
// entry. Application-scoped sections light up Applications: the rail shows the
// level, the tab strip shows the view. Settings (and the plugins admin surface
// reached from it) light up the profile card instead of a rail entry.
function railKey(section: string): string {
  switch (section) {
    case "home":
      return "home";
    case "changes":
    case "drafts":
    case "changelog":
    case "approvals":
    case "inbox":
      return "inbox";
    case "audit":
      return "audit";
    case "plugins":
    case "settings":
      return "profile";
    default:
      return "applications";
  }
}

export default function NavRail({
  collapsed = false,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { section, setSection } = useUI();
  const profile = useRailProfile(railKey(section) === "profile");
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });

  const repos = wsQ.data?.repos ?? [];
  // Inbox badge: only change requests actually awaiting a reviewer (open =
  // under review or approved). Drafts are the author's unsubmitted work - they
  // belong on Home and the app's Changes tab, not the reviewer's Inbox - so
  // counting them here made the badge promise items the Inbox never shows.
  const awaiting = repos.reduce((n, r) => n + (r.openChanges || 0), 0);
  const activeKey = railKey(section);

  const items: NavItem[] = [
    { key: "home", label: "Home", icon: <HomeOutlined />, onClick: () => setSection("home") },
    {
      key: "applications",
      label: "Applications",
      icon: <AppstoreOutlined />,
      onClick: () => setSection("workspace"),
    },
    {
      key: "inbox",
      label: "Inbox",
      icon: <InboxOutlined />,
      badge: awaiting,
      onClick: () => setSection("inbox"),
    },
    // The trail spans every application, so it stands at the workspace level
    // alongside the others - it never needs one selected.
    { key: "audit", label: "Audit", icon: <FileProtectOutlined />, onClick: () => setSection("audit") },
  ];

  return (
    <SideNav
      brand={brand}
      items={items}
      activeKey={activeKey}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      profile={profile}
      profileSlot={<SignInEntry collapsed={collapsed} />}
      footer={<DeploymentChip />}
    />
  );
}

// The person at the rail's foot. On a multi-user deployment that is the
// signed-in account; in single-user mode it is the local operator. Signed out,
// the card is replaced by the sign-in entry - the one place identity starts -
// which is why this returns null and the caller renders that instead.
function useRailProfile(active: boolean): NavProfile | null {
  const setSection = useUI((s) => s.setSection);
  const id = useIdentity();
  if (id.loading) return null;
  if (id.authEnabled && !id.signedIn) return null;
  return {
    name: id.displayName,
    // The person, and nothing about permissions: access belongs to an
    // application, not to a name in a sidebar. It is shown on each
    // application's card and in its context strip instead.
    ...(id.authEnabled && id.user?.login ? { sub: id.user.login } : {}),
    ...(id.user?.avatarUrl ? { avatarUrl: id.user.avatarUrl } : {}),
    active,
    onClick: () => setSection("settings"),
  };
}

/** The sign-in entry, standing in the profile card's place when nobody is
 *  signed in. Identity is where a session starts, so the rail's foot must not
 *  simply go blank. */
function SignInEntry({ collapsed }: { collapsed: boolean }) {
  const id = useIdentity();
  if (id.loading || !id.authEnabled || id.signedIn) return null;
  const login = () => {
    window.location.href = `/api/auth/login?return_to=${encodeURIComponent(
      window.location.pathname + window.location.search,
    )}`;
  };
  return (
    <NavEntry
      item={{ key: "signin", label: "Sign in", icon: <UserOutlined />, onClick: login }}
      active={false}
      collapsed={collapsed}
    />
  );
}

// DeploymentChip identifies this installation (version + environment) so
// support conversations and screenshots are unambiguous. It reads the service's
// own identity, so it is present on a workspace with no applications too.
function DeploymentChip() {
  const m = useDeployment();
  if (!m.reachable) return null;
  return (
    <div className="ui-nav-note">
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          flexShrink: 0,
          background: envHex(m.environment),
        }}
      />
      {m.name} {m.version} · {m.environment}
    </div>
  );
}
