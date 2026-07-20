// Typed client for the Configer backend REST API.
import { markOffline, markOnline, OfflineError, saveSnapshot } from "./offline";

/** How widely an edit to a parameter lands: an instance-scoped parameter is
 *  bound inside each instance's own folder; a global one lives in a shared
 *  file every instance reads, so one edit applies to all. */
export type Scope = "instance" | "global";

/** Which precedence layer supplied a cell's value. */
export type CellSource = "default" | "base" | "instance" | "";

/** One real-file location a parameter's value lives at. File may contain
 *  "{folder}" / "{instance}" templates expanded per instance. */
export interface Binding {
  file: string;
  path: string;
  format?: string;
  layer?: string;
  /** 1-based source line the value lives on (0/absent when unknown); display only */
  line?: number;
}

/** The parameter's bindings ([] for a design-phase parameter). */
export const bindingsOf = (p: Parameter): Binding[] => p.bindings ?? [];

/** The parameter's first binding (display convenience). */
export const primaryBinding = (p: Parameter): Binding =>
  p.bindings?.[0] ?? { file: "", path: "", format: "" };

/** Expand a binding's file template for one instance. */
export const expandBinding = (
  b: Binding,
  inst?: { name: string; folder?: string } | null,
): string =>
  !inst
    ? b.file
    : b.file
        .replace(/\{folder\}/g, inst.folder || `instances/${inst.name}`)
        .replace(/\{instance\}/g, inst.name);

export type CellState = "normal" | "new" | "deprecated" | "na";

export interface Instance {
  name: string;
  /** the instance's directory in the repository (e.g. "instances/prod") */
  folder?: string;
  environment?: string;
  region?: string;
  zone?: string;
  site?: string;
  softwareVersion?: string;
  labels?: Record<string, string>;
  status?: string;
}

// Fields accepted when creating or patching an instance. cloneFrom (on add)
// copies an existing instance's metadata and overlay values.
export interface InstanceInput {
  name?: string;
  environment?: string;
  region?: string;
  zone?: string;
  site?: string;
  softwareVersion?: string;
  status?: string;
  labels?: Record<string, string>;
  cloneFrom?: string;
  author?: string;
}

export interface Validation {
  required?: boolean;
  pattern?: string;
  enum?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  preset?: string;
  schemaRef?: string;
}

// A predefined validation rule from the backend's rule library, selectable
// from a dropdown in the rule editor.
export interface PresetRule {
  id: string;
  name: string;
  description: string;
  /** a valid sample value, shown in editors and error messages */
  example?: string;
  pattern?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
}

export interface Parameter {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  category: string;
  type: string;
  /** element type when type === "list" */
  itemType?: string;
  scope: Scope;
  secret: boolean;
  /** real-file locations this parameter's value lives at; a deduplicated
   *  parameter carries several, and an edit fans out to all of them */
  bindings?: Binding[];
  validation?: Validation;
  default?: unknown;
  versionIntroduced?: string;
  versionDeprecated?: string;
  dependsOn?: string[];
  /** onboarding proposal only: the value discovery read from each instance's
   *  files (instance name -> value), for previewing the grid before init */
  observed?: Record<string, unknown>;
}

export interface Cell {
  value: unknown;
  source: CellSource;
  /** repository file/path that supplied the value (when from a file) */
  file?: string;
  path?: string;
  set: boolean;
  state: CellState;
  valid: boolean;
  message?: string;
  editable: boolean;
  /** staged in the current draft change request, not yet on Git */
  pending?: boolean;
}

export type CellAction = "set" | "reset" | "exclude";

/** All draft item actions: cell edits plus structural instance changes. */
export type ItemAction =
  | CellAction
  | "add-instance"
  | "remove-instance"
  | "update-instance"
  | "edit-file";

/** File contents equal ignoring end-of-file whitespace: a trailing-newline
 *  delta is a formatting artifact, never a configuration change, so diff
 *  surfaces (Files badges, Compare) treat such contents as identical. */
export const sameContent = (a?: string, b?: string): boolean =>
  a === b || (a ?? "").replace(/\s+$/, "") === (b ?? "").replace(/\s+$/, "");

/** Human label for a structural item ("" for plain cell edits). */
export const structuralLabel = (it: { action?: string; instance: string; old?: unknown; file?: string }): string => {
  if (it.action === "add-instance")
    return `Add instance ${it.instance}${it.old ? ` (clone of ${String(it.old)})` : ""}`;
  if (it.action === "remove-instance") return `Retire instance ${it.instance}`;
  if (it.action === "update-instance") return `Update instance ${it.instance} settings`;
  if (it.action === "edit-file") return `Edited ${it.file ?? "a file"} directly`;
  return "";
};

// --- change requests -------------------------------------------------------

export type ChangeState = "draft" | "under_review" | "approved" | "published" | "rejected";

export interface ChangeItem {
  paramId: string;
  instance: string;
  /** "global" marks a scope-level edit applying to every instance */
  scope?: string;
  /** repository path of a direct file edit (action "edit-file") */
  file?: string;
  action?: ItemAction;
  old: unknown;
  new: unknown;
  updatedAt: string;
}

/** One review note on a change request. */
export interface ChangeComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface ChangeRequest {
  id: number;
  title: string;
  description?: string;
  /** external ticket / CR id, e.g. JIRA-123 */
  reference?: string;
  /** hotfix | feature | bugfix | maintenance | security | other */
  category?: string;
  author: string;
  targetBranch: string;
  branch?: string;
  baseSha?: string;
  commitSha?: string;
  state: ChangeState;
  items: ChangeItem[] | null;
  prNumber?: number;
  prUrl?: string;
  /** logins asked to review (informational; approval stays role-based) */
  reviewers?: string[];
  /** in-app review discussion, oldest first */
  comments?: ChangeComment[];
  createdAt: string;
  updatedAt: string;
}

export interface Row {
  param: Parameter;
  cells: Record<string, Cell>;
}

export interface CategoryNode {
  key: string;
  title: string;
  count: number;
  children?: CategoryNode[];
}

export interface Grid {
  project: string;
  instances: Instance[];
  rows: Row[];
  categories: CategoryNode[];
}

export interface DiffChange {
  paramId: string;
  name: string;
  left: unknown;
  right: unknown;
  status: "added" | "removed" | "modified" | "unchanged";
}

export interface DiffResult {
  left: string;
  right: string;
  changes: DiffChange[];
  summary: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
    total: number;
  };
}

// A commit in the application history.
export interface Commit {
  sha: string;
  short: string;
  author: string;
  email?: string;
  date: string;
  message: string;
}

// One point on a parameter's value timeline.
export interface ParamHistoryEntry extends Commit {
  value: string;
  present: boolean;
  changed: boolean;
}

// Git-liveness snapshot: the managed tree vs its origin remote.
export interface RepoStatus {
  branch: string;
  remote?: string;
  ahead: number;
  behind: number;
  lastSync?: string;
  syncError?: string;
  provider?: string;
  autoSyncMs?: number;
  /** the remote branch was deleted; local work continues safely */
  upstreamGone?: boolean;
}

// The application identity stored in Git (.configer/application.yaml):
// display name, description, and free-form user metadata.
export interface ApplicationDetails {
  name: string;
  description?: string;
  layout?: string;
  metadata?: Record<string, string>;
}

// Project summary; initialized=false routes the UI into onboarding.
export interface ProjectInfo {
  initialized: boolean;
  project: string;
  branch?: string;
  remote?: string;
  instances?: Instance[];
  paramCount?: number;
}

// The onboarding proposal: detected layout, derived instances, and
// deduplicated parameters with templated bindings + schema validation.
export interface Discovery {
  detection: {
    layout: string;
    score: number;
    instances: { name: string; folder: string; environment?: string }[];
    baseDirs?: string[];
    note?: string;
  };
  instances: Instance[];
  parameters: Parameter[];
  sharedFiles?: string[];
  skipped?: string[];
}

// --- platform: identity, roles, audit -------------------------------------

export type RoleName = "viewer" | "editor" | "approver";

export interface AuthUser {
  login: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  admin: boolean;
}

/** /auth/me: whether login is configured, and who is signed in. */
export interface AuthState {
  enabled: boolean;
  user?: AuthUser | null;
}

export interface Member {
  repo: string;
  login: string;
  role: RoleName;
}

export interface AuditEvent {
  id: number;
  at: string;
  login: string;
  repo?: string;
  action: string;
  detail?: string;
}

// Deployment identity for professional, environment-aware messaging.
export interface Meta {
  name: string;
  version: string;
  environment: string;
  project?: string;
  branch?: string;
}

// One repository event detected between the acknowledged commit and HEAD.
export interface Finding {
  type: "new_file" | "file_changed" | "file_deleted" | "file_renamed" | "new_folder";
  path: string;
  oldPath?: string;
  candidates?: number;
  params?: string[];
  detail: string;
}

export interface FindingsResult {
  baseSha: string;
  headSha: string;
  findings: Finding[];
}

// Ingest scan result (import wizard).
export interface ScanCandidate {
  name: string;
  path: string;
  type: string;
  value: unknown;
  file: string;
  format: string;
}

export interface ScanFile {
  file: string;
  format: string;
  parser: string;
  candidates: ScanCandidate[] | null;
  error?: string;
}

export interface ScanResult {
  root: string;
  files: ScanFile[] | null;
  skipped: string[] | null;
  total: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: string;
  description: string;
}

// One repository in the workspace, as summarized by the portfolio endpoint.
export interface RepoSummary {
  id: string;
  name: string;
  origin?: string;
  local?: boolean;
  /** managed through the GitHub API with no clone (R2) */
  noClone?: boolean;
  branch?: string;
  project?: string;
  /** connected but not yet initialized (no .configer): routes to onboarding */
  needsSetup?: boolean;
  params: number;
  instances: number;
  environments?: Record<string, number>;
  openChanges: number;
  drafts: number;
  behind?: number;
  syncError?: string;
  provider?: string;
  remote?: string;
  addedAt: string;
  error?: string;
}

export interface Workspace {
  name: string;
  version: string;
  environment: string;
  repos: RepoSummary[];
}

// --- GitHub browsing (New Application flow) --------------------------------

/** Whether the server can browse GitHub right now, and through what. */
export interface GitHubStatus {
  available: boolean;
  /** "session" (the signed-in user's access) or "server" (deployment token) */
  source: "session" | "server" | "";
  login?: string;
  /** whether "Sign in with GitHub" is configured on this deployment */
  signInEnabled: boolean;
}

// --- local folder browsing (New Application → Local folder) ----------------

/** One selectable sub-folder in the local folder picker. */
export interface FolderEntry {
  name: string;
  path: string;
  isRepo: boolean;
  hasConfiger: boolean;
}

/** A directory listing from the server's own filesystem (localhost mode). */
export interface FolderListing {
  path: string;
  name: string;
  /** parent directory path, or "" at the filesystem root */
  parent: string;
  isRepo: boolean;
  hasConfiger: boolean;
  folders: FolderEntry[];
}

export interface GitHubRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  description?: string;
  defaultBranch?: string;
  pushedAt?: string;
  url: string;
}

// The active repository. Every repo-scoped call is routed to
// /api/repos/<id>/...; when unset the legacy unscoped routes hit the
// server's default repository, so the app works before the workspace loads.
let activeRepo: string | null = null;

export function setApiRepo(id: string | null) {
  activeRepo = id;
}

// rp scopes a path to the active repository.
const rp = (path: string) => (activeRepo ? `/repos/${encodeURIComponent(activeRepo)}${path}` : path);

// snapKey namespaces offline snapshots per repository, so a snapshot from one
// configuration is never shown while another is selected.
export const snapKey = (key: string) => `${activeRepo ?? "default"}:${key}`;

// API base URL, resolved once. Precedence: a runtime override injected before
// the app boots (window.__CONFIGER__.apiBaseUrl, editable without a rebuild via
// public/config.js) > the build-time VITE_API_BASE_URL > the same-origin "/api"
// (nginx/Vite proxy it to the backend). This lets a static SPA point at a
// separate API host, and lets ops repoint it without rebuilding.
const API_BASE =
  (typeof window !== "undefined" && window.__CONFIGER__?.apiBaseUrl) ||
  import.meta.env.VITE_API_BASE_URL ||
  "/api";

// request marks the connection online/offline as a side effect, so every API
// call keeps the resilience layer informed. Network failures become
// OfflineError (handled gracefully), HTTP errors carry the server's message.
async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch {
    markOffline();
    throw new OfflineError();
  }
  markOnline();
  return res;
}

async function get<T>(path: string): Promise<T> {
  const res = await request(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// snapGet caches the successful response locally so the UI can keep working
// from the last snapshot when the service is temporarily unreachable.
async function snapGet<T>(path: string, snapKey: string): Promise<T> {
  const data = await get<T>(path);
  saveSnapshot(snapKey, data);
  return data;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

const put = <T,>(path: string, body: unknown) => send<T>("PUT", path, body);

export const api = {
  // --- workspace level (not repo-scoped) ---
  health: () => get<{ status: string }>("/health"),
  me: () => get<AuthState>("/auth/me"),
  logout: () => send<{ ok: boolean }>("POST", "/auth/logout"),
  members: (repoId: string) =>
    get<{ members: Member[]; users: AuthUser[]; defaultRole: RoleName; enabled: boolean }>(
      `/repos/${encodeURIComponent(repoId)}/members`),
  setMember: (repoId: string, login: string, role: RoleName) =>
    put<{ ok: boolean }>(`/repos/${encodeURIComponent(repoId)}/members`, { login, role }),
  removeMember: (repoId: string, login: string) =>
    send<{ ok: boolean }>("DELETE", `/repos/${encodeURIComponent(repoId)}/members/${encodeURIComponent(login)}`),
  audit: (opts?: { repo?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.repo) qs.set("repo", opts.repo);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return get<{ events: AuditEvent[] | null }>(`/audit${suffix}`);
  },
  workspace: () => get<Workspace>("/workspace"),
  githubStatus: () => get<GitHubStatus>("/github/status"),
  browseFolders: (path?: string) =>
    get<FolderListing>(`/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  githubRepos: () => get<{ repos: GitHubRepo[] }>("/github/repos"),
  githubBranches: (fullName: string) =>
    get<{ default: string; branches: string[] }>(`/github/branches?repo=${encodeURIComponent(fullName)}`),
  connectRepo: (p: { url: string; name?: string; branch?: string; token?: string; mode?: "remote" }) =>
    send<RepoSummary>("POST", "/repos", p),
  renameRepo: (id: string, name: string) =>
    send<RepoSummary>("PATCH", `/repos/${encodeURIComponent(id)}`, { name }),
  removeRepo: (id: string) =>
    send<{ ok: boolean; removed: string }>("DELETE", `/repos/${encodeURIComponent(id)}`),

  // --- active-repository scoped ---
  meta: () => snapGet<Meta>(rp("/meta"), snapKey("meta")),
  projectInfo: () => get<ProjectInfo>(rp("/project")),
  application: () => get<ApplicationDetails>(rp("/application")),
  updateApplication: (p: {
    name?: string;
    description?: string;
    metadata?: Record<string, string>;
    author?: string;
  }) => put<ApplicationDetails>(rp("/application"), p),
  deinit: (author?: string) =>
    send<{ ok: boolean; removed: boolean }>("POST", rp("/deinit"), { author }),
  discover: () => send<Discovery>("POST", rp("/discover")),
  initApp: (p: {
    name: string;
    description?: string;
    layout?: string;
    instances: Instance[];
    parameters: Parameter[];
    ignoreFiles?: string[];
    author?: string;
  }) => send<{ ok: boolean; parameters: number; instances: number; skipped?: string[] }>("POST", rp("/init"), p),
  grid: () => snapGet<Grid>(rp("/grid"), snapKey("grid")),
  compare: (left: string, right: string, opts?: { leftRef?: string; rightRef?: string }) => {
    const qs = new URLSearchParams({ left, right });
    if (opts?.leftRef) qs.set("leftRef", opts.leftRef);
    if (opts?.rightRef) qs.set("rightRef", opts.rightRef);
    return get<DiffResult>(rp(`/compare?${qs.toString()}`));
  },
  refs: () => get<{ current: string; branches: string[] | null; tags: string[] | null }>(rp("/repo/refs")),
  history: (limit?: number) =>
    get<{ commits: Commit[] | null; supported: boolean }>(rp(`/history${limit ? `?limit=${limit}` : ""}`)),
  parameterHistory: (id: string, opts?: { instance?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.instance) qs.set("instance", opts.instance);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return get<{ parameter: string; instance: string; entries: ParamHistoryEntry[] | null; supported: boolean }>(
      rp(`/parameters/${encodeURIComponent(id)}/history${suffix}`),
    );
  },
  plugins: () => get<PluginManifest[]>(rp("/plugins")),
  scan: () => send<ScanResult>("POST", rp("/scan")),
  importParameters: (p: { parameters: Partial<Parameter>[]; ignoreFiles: string[]; author?: string }) =>
    send<{ ok: boolean; imported: number; skipped: string[] }>("POST", rp("/import"), p),
  findings: () => get<FindingsResult>(rp("/repo/findings")),
  ackFindings: () => send<{ ok: boolean }>("POST", rp("/repo/findings/ack")),
  retireFile: (file: string, author?: string) =>
    send<{ ok: boolean; retired: string[] }>("POST", rp("/parameters/retire-file"), { file, author }),
  render: (instance: string, opts?: { draft?: boolean; ref?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.ref) qs.set("ref", opts.ref);
    else if (opts?.draft === false) qs.set("draft", "false");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return get<{ instance: string; files: { path: string; content: string }[] }>(
      rp(`/render/${encodeURIComponent(instance)}${suffix}`),
    );
  },
  stageFileEdit: (p: { instance?: string; path: string; content: string; author?: string }) =>
    put<{ ok: boolean; staged: number; kind?: "values" | "file"; managedChanges?: number; detail?: string }>(
      rp("/files/draft"), p),
  presets: () => get<PresetRule[]>(rp("/validation/presets")),
  setValue: (p: { instance: string; paramId: string; value?: unknown; action?: CellAction; scope?: "global"; author?: string }) =>
    put<{ ok: boolean; value: unknown; pending: number; changeId: number }>(rp("/values"), p),
  addParameter: (param: Partial<Parameter>, author?: string) =>
    send<Parameter>("POST", rp("/parameters"), { param, author }),
  // --- instances (registry lifecycle) ---
  instanceRegistry: () => get<{ instances: Instance[] | null }>(rp("/instances")),
  addInstance: (p: InstanceInput) =>
    send<{ ok: boolean; staged: boolean; pending: number; changeId: number }>("POST", rp("/instances"), p),
  updateInstance: (name: string, patch: InstanceInput) =>
    put<Instance>(rp(`/instances/${encodeURIComponent(name)}`), patch),
  deleteInstance: (name: string, author?: string) =>
    send<{ ok: boolean; staged: boolean; pending: number; changeId: number }>(
      "DELETE", rp(`/instances/${encodeURIComponent(name)}`), { author }),
  deleteParameter: (id: string, author?: string) =>
    send<{ ok: boolean }>("DELETE", rp(`/parameters/${encodeURIComponent(id)}`), { author }),
  revertValue: (paramId: string, instance: string) =>
    send<{ ok: boolean }>(
      "DELETE",
      rp(`/values?paramId=${encodeURIComponent(paramId)}&instance=${encodeURIComponent(instance)}`),
    ),
  updateParameter: (
    id: string,
    patch: {
      type?: string;
      validation?: Validation;
      displayName?: string;
      description?: string;
      category?: string;
      scope?: Scope;
      secret?: boolean;
      default?: unknown;
      /** attach or re-map: always produced by the interactive picker */
      bindings?: Binding[];
      author?: string;
    },
  ) => put<Parameter>(rp(`/parameters/${encodeURIComponent(id)}`), patch),
  repoStatus: () => get<RepoStatus>(rp("/repo/status")),
  repoSync: () => send<RepoStatus>("POST", rp("/repo/sync")),
  changes: () => snapGet<ChangeRequest[]>(rp("/changes"), snapKey("changes")),
  // Explicit-repo reads for the global (cross-application) views: the inbox
  // and the instances estate aggregate over every repository, not just the
  // active one, so they cannot go through rp().
  changesOf: (repoId: string) =>
    get<ChangeRequest[]>(`/repos/${encodeURIComponent(repoId)}/changes`),
  instancesOf: (repoId: string) =>
    get<{ instances: Instance[] | null }>(`/repos/${encodeURIComponent(repoId)}/instances`),
  findingsOf: (repoId: string) =>
    get<FindingsResult>(`/repos/${encodeURIComponent(repoId)}/repo/findings`),
  repoStatusOf: (repoId: string) =>
    get<RepoStatus>(`/repos/${encodeURIComponent(repoId)}/repo/status`),
  draft: () => snapGet<{ draft: ChangeRequest | null }>(rp("/changes/draft"), snapKey("draft")),
  change: (id: number) => get<ChangeRequest>(rp(`/changes/${id}`)),
  submitChange: (
    id: number,
    p: { title: string; description?: string; reference?: string; category?: string; author?: string },
  ) => send<ChangeRequest>("POST", rp(`/changes/${id}/submit`), p),
  mergeChange: (id: number) => send<ChangeRequest>("POST", rp(`/changes/${id}/merge`)),
  rejectChange: (id: number) => send<ChangeRequest>("POST", rp(`/changes/${id}/reject`)),
  addComment: (id: number, body: string, author?: string) =>
    send<ChangeRequest>("POST", rp(`/changes/${id}/comments`), { body, author }),
  setReviewers: (id: number, reviewers: string[]) =>
    put<ChangeRequest>(rp(`/changes/${id}/reviewers`), { reviewers }),
};
