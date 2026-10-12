// The tool's built-in commands. This is the ONE file a feature touches to make
// a new action searchable and runnable: add a registerCommand({...}) here (or in
// the feature's own module and import it from ./index), and it appears in the
// palette immediately, with zero changes to any search code. Everything here is
// declared as data; the palette and target resolution do the rest.

import {
  HomeOutlined,
  AppstoreOutlined,
  InboxOutlined,
  ClusterOutlined,
  HistoryOutlined,
  DatabaseOutlined,
  SettingOutlined,
  TableOutlined,
  FileTextOutlined,
  SwapOutlined,
  PullRequestOutlined,
  CheckCircleOutlined,
  PlusOutlined,
  SendOutlined,
} from "../icons";
import type { ReactNode } from "react";
import type { AppCtx } from "../search/types";
import { useUI } from "../store";
import { registerCommand, type Command } from "./registry";

// nav is the common shape: a command that simply moves to a section. Global
// destinations always apply; application tabs only apply while inside an app.
function nav(
  id: string,
  title: string,
  section: string,
  icon: ReactNode,
  opts?: { keywords?: string; category?: string; when?: (c: AppCtx) => boolean },
): Command {
  return {
    id,
    title,
    icon,
    keywords: opts?.keywords,
    category: opts?.category ?? "Navigation",
    when: opts?.when,
    run: (ctx) => ctx.nav.setSection(section),
  };
}

const inApp = (c: AppCtx) => c.inApp;

// Workspace-level destinations (offered everywhere).
const globalNav: Command[] = [
  nav("nav.home", "Home", "home", <HomeOutlined />, { keywords: "start dashboard" }),
  nav("nav.applications", "Applications", "workspace", <AppstoreOutlined />, {
    keywords: "apps repositories projects",
  }),
  nav("nav.approvals", "Approvals inbox", "inbox", <InboxOutlined />, {
    keywords: "review pending change requests",
  }),
  nav("nav.instances", "Instances estate", "estate", <ClusterOutlined />, {
    keywords: "deployments environments regions",
  }),
  nav("nav.changes", "Change history", "changelog", <HistoryOutlined />, {
    keywords: "releases audit log commits",
  }),
  nav("nav.repositories", "Repositories", "repos", <DatabaseOutlined />, {
    keywords: "git connect sources",
  }),
  nav("nav.settings", "Settings", "settings", <SettingOutlined />, {
    keywords: "appearance theme profile preferences",
  }),
];

// Application tabs (offered only while an application is open).
const appNav: Command[] = [
  nav("app.overview", "Overview", "overview", <AppstoreOutlined />, { when: inApp, category: "This application" }),
  nav("app.parameters", "Parameters", "config", <TableOutlined />, {
    when: inApp,
    category: "This application",
    keywords: "grid editor values",
  }),
  nav("app.instances", "Instances", "instances", <ClusterOutlined />, { when: inApp, category: "This application" }),
  nav("app.files", "Files", "files", <FileTextOutlined />, { when: inApp, category: "This application" }),
  nav("app.compare", "Compare", "compare", <SwapOutlined />, { when: inApp, category: "This application" }),
  nav("app.changes", "Changes", "changes", <PullRequestOutlined />, {
    when: inApp,
    category: "This application",
    keywords: "drafts history",
  }),
  nav("app.approvals", "Approvals", "approvals", <CheckCircleOutlined />, { when: inApp, category: "This application" }),
];

// Action-flavored commands: verbs the user searches for by intent. In this
// phase they route to where the action is performed; a later phase can have
// run() drive the flow directly.
const actions: Command[] = [
  {
    id: "action.new-application",
    title: "Create application",
    icon: <PlusOutlined />,
    category: "Actions",
    keywords: "new connect add repository onboard import",
    // Open the deep-linked New Application dialog (writes ?new=1 to the URL).
    run: () => useUI.getState().openNewApp(),
  },
  {
    id: "action.submit-changes",
    title: "Submit changes for review",
    icon: <SendOutlined />,
    category: "Actions",
    keywords: "open pull request propose draft",
    when: inApp,
    run: (ctx) => ctx.nav.setSection("changes"),
  },
];

for (const cmd of [...globalNav, ...appNav, ...actions]) registerCommand(cmd);
