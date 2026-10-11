import { useQuery } from "@tanstack/react-query";
import {
  HomeOutlined,
  AppstoreOutlined,
  InboxOutlined,
  FileProtectOutlined,
} from "../icons";
import { api } from "../api";
import { ConnectionPill, SideNav, type NavItem } from "../uikit";
import brand from "../brand";
import { useUI } from "../store";
import { useDeployment } from "../deployment";

// The navigation rail: the ONLY organization-scope navigator. It holds just
// what crosses applications: Home, Applications, Inbox (every change and
// approval that needs someone), Audit. Instances and Repositories are not
// top-level nouns - they live inside an application, reached through its tab
// strip. Like Software Gateway, entries are grouped under section labels, the
// foot is the deployment pill, and the person lives in the top bar's account menu.
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
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });

  const repos = wsQ.data?.repos ?? [];
  // Inbox badge: only change requests actually awaiting a reviewer (open =
  // under review or approved). Drafts are the author's unsubmitted work - they
  // belong on Home and the app's Changes tab, not the reviewer's Inbox - so
  // counting them here made the badge promise items the Inbox never shows.
  const awaiting = repos.reduce((n, r) => n + (r.openChanges || 0), 0);
  const activeKey = railKey(section);

  const items: NavItem[] = [
    { key: "home", label: "Home", icon: <HomeOutlined />, section: "Workspace", onClick: () => setSection("home") },
    {
      key: "applications",
      label: "Applications",
      icon: <AppstoreOutlined />,
      section: "Workspace",
      onClick: () => setSection("workspace"),
    },
    {
      key: "inbox",
      label: "Inbox",
      icon: <InboxOutlined />,
      section: "Governance",
      badge: awaiting,
      onClick: () => setSection("inbox"),
    },
    // The trail spans every application, so it stands at the workspace level
    // alongside the others - it never needs one selected.
    { key: "audit", label: "Audit", icon: <FileProtectOutlined />, section: "Governance", onClick: () => setSection("audit") },
  ];

  return (
    <SideNav
      brand={brand}
      items={items}
      activeKey={activeKey}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      footer={<DeploymentChip />}
    />
  );
}

// The rail's foot, the same as Software Gateway's DeploymentNote: one quiet
// pill naming the environment and build, that opens the kit's connection
// detail (heartbeat, last check) with this deployment's facts on top. The
// person moved to the top bar's account menu, where Software Gateway has it.
function DeploymentChip() {
  const m = useDeployment();
  const environment = m.environment || "…";
  const facts = [
    { label: "Environment", value: environment },
    { label: "Version", value: m.version || "Loading…" },
  ];
  return (
    <div className="ui-nav-note">
      <ConnectionPill
        service={brand.appName}
        placement="bottomLeft"
        triggerLabel={
          <>
            <span className="ui-nav-note-environment" title={`Environment: ${environment}`}>
              {/^dev(elopment)?$/i.test(environment) ? "Development" : environment}
            </span>
            {m.version && <span className="ui-nav-note-version">{m.version}</span>}
          </>
        }
        facts={facts}
      />
    </div>
  );
}
