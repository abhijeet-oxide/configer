// Typed client for the Configer backend REST API.
import { markOffline, markOnline, OfflineError, saveSnapshot } from "./offline";

/** How widely an edit to a parameter lands: an instance-scoped parameter is
 *  bound inside each instance's own folder; a global one lives in a shared
 *  file every instance reads, so one edit applies to all. */
export type Scope = "instance" | "global";

/** Which precedence layer supplied a cell's value. */
export type CellSource = "default" | "derived" | "base" | "instance" | "";

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

/**
 * The pseudo-instance the Files explorer uses for its default "All instances"
 * view. The backend's render endpoint understands the same sentinel and returns
 * every instance's files unioned together, so a parameter link always lands on
 * its file regardless of which instance the caller was looking at.
 */
export const ALL_INSTANCES = "__all__";

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
  /** what this instance is for, in its owner's words - never derived from the
   *  product, which would say the same sentence about every instance of it */
  description?: string;
  /** the instance's directory in the repository (e.g. "instances/prod") */
  folder?: string;
  environment?: string;
  region?: string;
  zone?: string;
  site?: string;
  /** version identifier, e.g. "v24.3.1" */
  softwareVersion?: string;
  /** optional human label for the same release, e.g. "Titanium" */
  versionName?: string;
  labels?: Record<string, string>;
  status?: string;
}

// Fields accepted when creating or patching an instance. cloneFrom (on add)
// copies an existing instance's metadata and overlay values.
export interface InstanceInput {
  name?: string;
  description?: string;
  environment?: string;
  region?: string;
  zone?: string;
  site?: string;
  softwareVersion?: string;
  versionName?: string;
  status?: string;
  labels?: Record<string, string>;
  cloneFrom?: string;
  /** Take over a folder the repository already has, instead of scaffolding a
   * new one: how an instance somebody created on Git becomes managed here.
   * Mutually exclusive with cloneFrom. */
  folder?: string;
  author?: string;
}

/** One closed interval of an allowed-value or allowed-length restriction.
 *  Either end may be open (absent). */
export interface Span {
  min?: number;
  max?: number;
}

/** One branch of a union: a type plus the rules that go with it. */
export interface Alternative {
  /** how the schema spelled it ("uint32", "inet:ipv4-address") */
  label?: string;
  type?: string;
  pattern?: string;
  patterns?: string[];
  notPatterns?: string[];
  enum?: string[];
  bits?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  ranges?: Span[];
  lengths?: Span[];
}

export interface Validation {
  required?: boolean;
  pattern?: string;
  /** further regular expressions that must ALL hold on top of `pattern` - a
   *  schema can restrict a value through a chain of definitions, each adding
   *  one, and a value has to satisfy every one of them */
  patterns?: string[];
  /** regular expressions the value must NOT match (a schema's inverted
   *  restriction). Carried as a rule rather than as prose, because the one
   *  restriction a vendor bothered to invert was the one nothing checked. */
  notPatterns?: string[];
  enum?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  /** the DISJOINT spans a restriction really allows ("5..20 | 40..100").
   *  min/max carry only their outer edges, which accept the gap between them -
   *  when these are present they are what decides. */
  ranges?: Span[];
  lengths?: Span[];
  /** the named flags a value may be built from: any subset, space-separated */
  bits?: string[];
  /** alternative rule sets, of which the value must satisfy at least ONE (a
   *  schema union). Layering them on each other would refuse both legitimate
   *  spellings of "a number or the word auto". */
  anyOf?: Alternative[];
  /** digits allowed after the decimal point */
  maxDecimals?: number;
  /** the model declares this as state the device reports, not configuration */
  readOnly?: boolean;
  /** the unit the value is expressed in ("seconds", "mb"); shown, never parsed */
  units?: string;
  /** the schema's own wording for a refused value */
  errorMessage?: string;
  /** conditions stated in words because they cannot be checked against a
   *  single value on its own; displayed, never enforced */
  constraints?: string[];
  preset?: string;
  /** the schema document the rules were derived from */
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
  /** the name's steps, when splitting it on "." would land in the wrong
   *  places - a key that itself contains a dot ("query.dependencies") is ONE
   *  step. Absent whenever the split is already right, so read it through
   *  nameSegments() rather than directly. */
  nameSegments?: string[];
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
  /** a computed default expressed in terms of another parameter, e.g.
   *  "{admin-port}+1"; resolved read-only and overridden by any file value */
  derived?: string;
  /** mapping to a key in an external source; the source value surfaces as an
   *  incoming change the reviewer accepts, never applied silently */
  source?: SourceRef;
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
  /**
   * The committed value is a template EXPRESSION (Helm "{{ ... }}", a "${...}"
   * reference), not a literal. Such a cell is read-only in the grid: editing it
   * as a plain value would overwrite the template. Change it in file mode.
   */
  templated?: boolean;
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
  | "edit-file"
  | "unmanage-parameter"
  | "add-parameter"
  | "realign-bindings";

/** File contents equal ignoring end-of-file whitespace: a trailing-newline
 *  delta is a formatting artifact, never a configuration change, so diff
 *  surfaces (Files badges, Compare) treat such contents as identical. */
export const sameContent = (a?: string, b?: string): boolean =>
  a === b || (a ?? "").replace(/\s+$/, "") === (b ?? "").replace(/\s+$/, "");

/** Human label for a structural item ("" for plain cell edits). */
export const structuralLabel = (it: { action?: string; instance: string; old?: unknown; new?: unknown; file?: string }): string => {
  if (it.action === "add-instance")
    return `Add instance ${it.instance}${it.old ? ` (clone of ${String(it.old)})` : ""}`;
  if (it.action === "remove-instance") return `Retire instance ${it.instance}`;
  if (it.action === "update-instance") return `Update instance ${it.instance} settings`;
  if (it.action === "edit-file") return `Edited ${it.file ?? "a file"} directly`;
  if (it.action === "add-parameter") return `Start managing ${addedParamName(it)}`;
  if (it.action === "realign-bindings") {
    const p = realignPayload(it);
    const parts: string[] = [];
    if (p.moves?.length) parts.push(`${p.moves.length} parameter${p.moves.length === 1 ? "" : "s"} follow their entries`);
    if (p.dropped?.length) parts.push(`${p.dropped.length} no longer in the file`);
    return parts.length ? parts.join(", ") : "Catalog realigned";
  }
  return "";
};

/** One parameter's in-file address following the value it names. */
export interface BindingMove {
  paramId: string;
  name?: string;
  from: string;
  to: string;
}

/** What a realign-bindings item carries. */
export interface RealignPayload {
  moves?: BindingMove[];
  dropped?: BindingMove[];
}

export const realignPayload = (it: { new?: unknown }): RealignPayload =>
  (it.new && typeof it.new === "object" ? (it.new as RealignPayload) : {});

/** What a REVIEW should list. A direct file edit whose consequences are already
 *  spelled out - the settings it added, the entries the catalog followed - adds
 *  nothing by also saying "edited directly": the reader has just been told
 *  exactly what changed, in the terms they think in, and the file row is the
 *  same fact a second time with less in it.
 *
 *  So it is dropped, and ONLY when something else accounts for it. An edit that
 *  changed no settings - a comment, a reordering, a block nothing manages - has
 *  no other row to speak for it, and there the file row is the whole change.
 *  (The draft item itself is untouched: the bytes still publish, and the Source
 *  Control panel still lists every item there is, because that surface answers
 *  "what is staged" rather than "what changed".) */
export const reviewItems = (items: ChangeItem[]): ChangeItem[] => {
  const explained = new Set<string>();
  for (const it of items) {
    if ((it.action === "add-parameter" || it.action === "realign-bindings") && it.file)
      explained.add(it.file);
  }
  if (explained.size === 0) return items;
  return items.filter((it) => !(it.action === "edit-file" && it.file && explained.has(it.file)));
};

/** The name of the parameter an add-parameter item starts managing. The item
 *  carries the whole catalog entry, so the change can read as the setting
 *  rather than as its slug. */
export const addedParamName = (it: { paramId?: string; new?: unknown }): string => {
  const pm = it.new as Partial<Parameter> | undefined;
  return (pm && typeof pm === "object" && typeof pm.name === "string" && pm.name) || it.paramId || "a parameter";
};

/** A parameter's name steps: the ones the server spelled out when the dot
 *  split would land in the wrong places, otherwise the split itself. Every
 *  surface that nests or shortens a name reads it through here, so a key
 *  containing a dot stays one step everywhere. */
export const nameSegments = (p: Pick<Parameter, "name" | "nameSegments">): string[] =>
  p.nameSegments?.length ? p.nameSegments : p.name.split(".");

// --- change requests -------------------------------------------------------

/** The standard pagination envelope for cursor-paginated collections. Pass the
 *  previous response's `nextCursor` as `?cursor=` to fetch the next page. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

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

/** One value inside a file that Configer manages, and the line it is on. */
export interface ManagedValue {
  paramId: string;
  name: string;
  path: string;
  line: number;
  /** 1-based columns bracketing the VALUE on that line (end exclusive); 0 when
   *  it could not be narrowed and the whole line is the answer */
  col?: number;
  endCol?: number;
  type?: string;
  secret?: boolean;
  instance?: string;
}

/** One file a change request would rewrite, with exact before/after content
 * (the same bytes the submit will commit) so the UI can render a real diff. */
export interface FilePreview {
  file: string;
  status: "modified" | "added" | "removed";
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

/** One staged edit the preview could not apply. A submit would refuse it too,
 * so it is reported next to the diffs the other edits produce. */
export interface PreviewProblem {
  paramId?: string;
  instance?: string;
  action?: string;
  file?: string;
  message: string;
}

/** The byte-level plan for a change request: files it rewrites plus one-line
 * summaries of structural instance changes. */
export interface ChangePreview {
  files: FilePreview[] | null;
  structural: string[] | null;
  problems?: PreviewProblem[] | null;
}

/** Live pull-request status for a change request (CI checks + mergeability),
 * read fresh from the host. `supported` is false for pure-git deployments or a
 * change without a hosted PR. */
export interface PrStatus {
  supported: boolean;
  pr?: {
    number: number;
    url: string;
    state: string;
    merged: boolean;
    /** host merge-readiness: clean | blocked | dirty | unstable | behind | ... */
    mergeable?: string;
    /** rolled-up CI: passing | failing | pending | none */
    checks?: string;
    headSha?: string;
  };
}

/** One review note on a change request. */
export interface ChangeComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

/** one recorded sign-off on a change request */
export interface ChangeApproval {
  approver: string;
  createdAt: string;
}

/**
 * A change request's blast radius: how many instances it effectively changes
 * (including those a shared/global edit fans out to) and across which
 * environments, so the reviewer sees true reach, not just the rows edited.
 */
export interface ChangeImpact {
  instances: string[];
  instanceCount: number;
  environments: string[];
  touchesProduction: boolean;
  /** the change includes a shared (base-layer) edit whose reach is the fleet */
  global: boolean;
}

/** crRef is what to CALL a change on screen. A change request gets its number
 *  when a draft is sent for review, so a draft has none and the caller names it
 *  in its own words ("Your draft").
 *
 *  A change that is under review, approved, published or rejected is NEVER a
 *  draft, whatever its numbering - and reading a missing number as "draft" is
 *  how a published change came to be labelled "Your draft" long after it went
 *  live: changes recorded before numbers were handed out carry none. Those keep
 *  the internal id, which is what they were called at the time. */
export function crRef(cr: Pick<ChangeRequest, "number" | "id" | "state">): string | null {
  if (cr.number) return `CR-${cr.number}`;
  return cr.state === "draft" ? null : `CR-${cr.id}`;
}

export interface ChangeRequest {
  /** the store's own key: stable, internal, used in URLs */
  id: number;
  /** the CR number people say out loud, handed out at SUBMIT. Absent while
   *  the change is still a draft, because a draft is not a change request yet
   *  and numbering every abandoned one left holes in the sequence. */
  number?: number;
  title: string;
  description?: string;
  /** external ticket / CR id, e.g. JIRA-123 */
  reference?: string;
  /** hotfix | feature | bugfix | maintenance | security | other */
  category?: string;
  author: string;
  targetBranch: string;
  branch?: string;
  /** the trunk commit it branched FROM */
  baseSha?: string;
  /** its own commit */
  commitSha?: string;
  /** the trunk commit that brought it back in, once published */
  mergeSha?: string;
  state: ChangeState;
  items: ChangeItem[] | null;
  prNumber?: number;
  prUrl?: string;
  /** logins asked to review (informational; approval stays role-based) */
  reviewers?: string[];
  /** in-app review discussion, oldest first */
  comments?: ChangeComment[];
  /** recorded sign-offs (separation of duties + minimum-approval policy) */
  approvals?: ChangeApproval[];
  /** blast radius, present on change detail and list responses */
  impact?: ChangeImpact;
  createdAt: string;
  updatedAt: string;
}

export interface Row {
  param: Parameter;
  cells: Record<string, Cell>;
  /** a draft change stops managing this parameter: still here, still editable,
   *  and leaving the catalog when that change is published */
  pendingUnmanage?: boolean;
  /** a draft change STARTS managing this parameter: a direct file edit put the
   *  value in the staged bytes, and the catalog entry arrives when that change
   *  is published */
  pendingAdd?: boolean;
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
  /** parent SHAs; more than one means this commit merged another line in */
  parents?: string[];
  /** tag and branch names pointing at this commit, bare */
  refs?: string[];
}

// One point on a parameter's value timeline.
export interface ParamHistoryEntry extends Commit {
  value: string;
  present: boolean;
  changed: boolean;
}

// --- Configuration timeline: how the configuration evolved, as snapshots ---

/** What a snapshot did, at a glance. A version move outranks value edits. */
export type SnapshotKind = "version" | "structural" | "config" | "none";

/** An instance's software version moving at a snapshot. */
export interface VersionMove {
  instance: string;
  from: string;
  to: string;
}

/** An instance appearing or being retired at a snapshot. */
export interface InstanceMove {
  instance: string;
  action: "added" | "removed";
}

/** One parameter cell's before/after across a snapshot boundary. */
export interface CellChange {
  paramId: string;
  name: string;
  /** empty for a shared/global value */
  instance?: string;
  before: string;
  after: string;
  status: "added" | "removed" | "modified";
}

export interface ChangeSummary {
  added: number;
  removed: number;
  modified: number;
  total: number;
}

/** One dot on the timeline. */
export interface TimelineEntry extends Commit {
  /** the snapshot this one is compared against ("" for the oldest in view) */
  previous?: string;
  kind: SnapshotKind;
  summary: ChangeSummary;
  instances?: string[] | null;
  versions?: VersionMove[] | null;
  structure?: InstanceMove[] | null;
  /** repository files that moved between this snapshot and the previous one */
  files?: number;
}

/** One standing branch beside the trunk: an environment, not a piece of work. */
export interface BranchLane {
  name: string;
  head: string;
  /** the branch everything is published to */
  trunk?: boolean;
  /** commits this branch has that the trunk does not, newest first */
  commits?: Commit[] | null;
  /** commits the trunk has that this branch does not */
  behind: number;
}

/** One snapshot opened up: every parameter that changed at it. */
export interface SnapshotDetail {
  commit: Commit;
  previous: string;
  kind: SnapshotKind;
  summary: ChangeSummary;
  instances?: string[] | null;
  versions?: VersionMove[] | null;
  structure?: InstanceMove[] | null;
  changes: CellChange[] | null;
  instance: string;
  supported: boolean;
}

/** What a restore touches: the whole app, one instance, or one cell. */
export type RestoreScope = "all" | "instance" | "parameter";

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
  skipped?: SkippedFile[];
  /** what a product descriptor in the repository says the application IS.
   *  Absent for a repository that ships none. */
  product?: ProductDescriptor;
}

/** A region the detection rules can put on a map. */
export interface RegionPlace {
  region: string;
  lat: number;
  lon: number;
}

/** A product descriptor found in an instance's metadata: what the delivery
 *  pipeline recorded about the product and the release it built. */
export interface ProductDescriptor {
  file: string;
  product?: string;
  displayName?: string;
  version?: string;
  release?: string;
  variant?: string;
  environment?: string;
  extra?: Record<string, string>;
}

/** Why the scan left a file out. A bare path answers the wrong question: what
 *  someone needs to know is why their file was passed over. */
export interface SkippedFile {
  file: string;
  reason: "generated" | "ignored" | "structural";
  /** what produced it, when a recognizer knew - the specifics needed to decide
   *  whether to manage it anyway */
  origin?: FileOrigin;
}

export interface FileOrigin {
  id: string;
  /** what produced it, e.g. "flux bootstrap" */
  name: string;
  /** the command that will write over it again */
  regenerates?: string;
  /** what happens to an edit made here */
  note?: string;
  /** where the same change belongs so that it survives */
  instead?: string;
  docs?: string;
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

/** /repos/{id}/role: the caller's own effective capability on one application,
 *  and where it came from - so the UI can say WHY, which a bare "Viewer" only
 *  raises as a question. */
export interface MyRole {
  enabled: boolean;
  role: RoleName;
  admin: boolean;
  source?: "admin" | "configer" | "git" | "default";
  detail?: string;
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

// The liveness answer. It carries the same deployment identity as Meta, but
// needs no application connected, so it is what the boot check and every
// workspace-level surface identify the deployment from.
export interface Health {
  status: string;
  name?: string;
  version?: string;
  environment?: string;
}

/**
 * What this deployment can actually do. The UI offers only workflows that will
 * succeed here rather than presenting options that cannot: "Local folder"
 * browses the SERVER's filesystem, which is the user's own machine when
 * Configer runs there and somebody else's container when it is hosted.
 */
export interface Capabilities {
  localFolders: boolean;
  githubSignIn: boolean;
  githubBrowse: boolean;
  manualGitUrl: boolean;
  hosted: boolean;
}

/** The commit behind a finding: who did this, and when. */
export interface FindingCommit {
  sha: string;
  short: string;
  author: string;
  date: string;
  message: string;
}

/** One repository event detected between the acknowledged commit and HEAD,
 * said in the product's own terms: an instance appeared or went away, a
 * software version moved, new settings turned up in a managed file. The
 * file-level types are what is left when nothing larger explains it. */
export interface Finding {
  type:
    | "instance_gone"
    | "new_instance"
    | "version_changed"
    | "new_parameters"
    | "new_file"
    | "file_changed"
    | "file_deleted"
    | "file_renamed"
    | "new_folder";
  path: string;
  oldPath?: string;
  candidates?: number;
  params?: string[];
  /** The instance a finding is about (new, gone, or moved). */
  instance?: string;
  /** The registry entry adopting a new instance would create. */
  proposed?: Instance;
  /** A software version move. */
  from?: string;
  to?: string;
  /** The configuration files a folder-level finding covers. */
  files?: string[];
  commit?: FindingCommit;
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

/** A candidate parameter proposed from a pasted config blob (a ScanCandidate
 * plus whether the same file+path is already managed). */
export interface AnalyzeCandidate extends ScanCandidate {
  managed: boolean;
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
  skipped: SkippedFile[] | null;
  total: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: string;
  description: string;
  /** display hints (source plugins): icon slug, color name, category */
  icon?: string;
  color?: string;
  category?: string;
}

// --- external parameter sources --------------------------------------------

/** One config input an "Add source" form renders, described by its plugin. */
export interface SourceField {
  key: string;
  label: string;
  type: string; // text | branch | path | password
  required?: boolean;
  help?: string;
  /** a credential resolved server-side; never persisted */
  secret?: boolean;
}

/** A registered source provider (git, vault, ...) plus its config fields. */
export interface SourcePlugin extends PluginManifest {
  fields: SourceField[];
}

/** A parameter's mapping to a key in an external source. */
export interface SourceRef {
  sourceId: string;
  key: string;
  /** target one instance; empty means the parameter's own scope */
  instance?: string;
}

/** A configured external source (its connection metadata, never credentials). */
export interface Source {
  id: string;
  name: string;
  kind: string;
  secret?: boolean;
  config?: Record<string, string>;
  pluginName?: string;
  mappedParams?: number;
}

/** One key/value pair a source exposes; secret values are masked and carry a
 *  reference written back in place of the plaintext. */
export interface SourceKV {
  key: string;
  value: unknown;
  type?: string;
  secret?: boolean;
  ref?: string;
}

/** One selectable node when browsing a source (folder/file/secret key). */
export interface BrowseEntry {
  name: string;
  path: string;
  isDir?: boolean;
}

/** An upstream value that differs from the repository's current value. */
export interface IncomingChange {
  paramId: string;
  paramName: string;
  instance?: string;
  sourceId: string;
  sourceName: string;
  key: string;
  current: unknown;
  incoming: unknown;
  secret?: boolean;
}

// --- global search ---------------------------------------------------------

/** A structured navigation intent returned by the search index; the client
 *  resolves it through the same deep-links the store owns. */
export interface SearchTarget {
  kind: "navigate";
  app?: string;
  view: string;
  param?: string;
  inst?: string;
}

/** One cross-application search result (metadata only - never a value). */
export interface SearchHitDTO {
  type: "parameter" | "instance" | "change";
  id: string;
  appId: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  badges?: { text: string; color?: string }[];
  target: SearchTarget;
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
  /** "connecting" while a repository is first being added, "opening" while an
   *  already-connected one is being made ready on this process (applications
   *  open on first use, so a restart shows this briefly), "error" when either
   *  failed, and absent (ready) for an application that is serving. */
  status?: "connecting" | "opening" | "error" | "";
  /** the CALLER's capability on this application, and where it came from. A
   *  role belongs to a (person, application) pair - the same person is an
   *  approver on one and a viewer on the next - so it is carried per card. */
  role?: RoleName;
  roleSource?: "admin" | "configer" | "git" | "default" | "single-user";
}

/**
 * Whether an application can actually be READ yet.
 *
 * The portfolio also carries applications whose connection is still running,
 * and ones whose connection failed - both are shown so the user can watch or
 * clear them, but neither has a server behind it. Every surface that fans out
 * per-application reads (the inbox, the estate, the change log) must ask this
 * first, or it addresses an application the service does not have and turns one
 * failed connection into a stream of errors.
 */
export function isReady(r: RepoSummary): boolean {
  return !r.status;
}

/** The applications a repo-scoped read may address. */
export function readyRepos(repos: RepoSummary[] | undefined): RepoSummary[] {
  return (repos ?? []).filter(isReady);
}

/** Whether a proposed change name is free, and the branch it would produce. */
export interface ChangeNameCheck {
  title: string;
  /** false only when a change that is STILL OPEN already has this name. */
  available: boolean;
  /** the branch this change would get, shown so the name is never a surprise */
  branch: string;
  conflict?: { id: number; title: string; state: string; open: boolean };
  /** the plain sentence to put under the field, when there is one */
  message?: string;
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

/**
 * normalizeApiBase turns whatever an operator configured into a base the client
 * can append "/health", "/workspace" … to.
 *
 * Every endpoint this app calls is mounted under `/api` on the backend, so the
 * base has to END at that prefix. The natural thing to paste, though, is the
 * API service's origin - `https://configer-api.onrender.com` - and that sends
 * every call to `/health` instead of `/api/health`: a deployment that answers
 * every request with 404 while looking perfectly configured. So a bare origin
 * gets the `/api` prefix it meant.
 *
 * A value that already names a path is left alone (minus a trailing slash), so
 * a backend mounted behind `https://host/configer/api` - or any other prefix -
 * keeps working exactly as written.
 */
export function normalizeApiBase(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "/api";
  const base = value.replace(/\/+$/, "");
  if (!base) return "/api";
  // Relative values ("/api", "/configer/api") are already paths: use as given.
  if (base.startsWith("/")) return base;
  try {
    const url = new URL(base);
    // Bare origin: the operator gave us the host, not the API path.
    if (url.pathname === "" || url.pathname === "/") return `${url.origin}/api`;
  } catch {
    // Not parseable as a URL: pass it through rather than guessing.
  }
  return base;
}

// API base URL, resolved once. Precedence: a runtime override injected before
// the app boots (window.__CONFIGER__.apiBaseUrl, editable without a rebuild via
// public/config.js) > the build-time VITE_API_BASE_URL > the same-origin "/api"
// (nginx/Vite proxy it to the backend). This lets a static SPA point at a
// separate API host, and lets ops repoint it without rebuilding.
const API_BASE = normalizeApiBase(
  (typeof window !== "undefined" && window.__CONFIGER__?.apiBaseUrl) ||
    import.meta.env.VITE_API_BASE_URL,
);

/** Where this build is actually calling the API. Shown when a probe fails, so
 *  a misconfigured address is visible instead of guessed at. */
export const apiBaseUrl = () => API_BASE;

/** One field-level validation failure from the backend's error envelope. */
export interface FieldError {
  field: string;
  message: string;
}

/** Where a file stopped parsing. The PLACE is the actionable part of a syntax
 *  failure, so it travels as fields rather than inside the sentence: the editor
 *  puts a marker on that line instead of leaving the reader to search. */
export interface SyntaxDetail {
  file: string;
  line?: number;
  column?: number;
  /** the offending line's own text, so the message can show what it means */
  snippet?: string;
}

/**
 * ApiError is the single typed error every non-2xx response becomes. It mirrors
 * the backend's error envelope ({error, code, requestId, fields}) so the UI can
 * branch on a STABLE machine `code`/`status` (never on message text) and always
 * has a `requestId` to show the user and quote to support. A 2xx response never
 * produces one, so a handler that receives data can trust it succeeded: there
 * is no path where a failure is silently rendered as success.
 */
// --- pre-submit validation ------------------------------------------------
// Submitting a change is the moment it stops being one person's work, so it is
// the moment everything that can be checked gets checked. The check is a RUN
// with stages rather than a request that either answers or does not: on a
// fleet-sized change it takes seconds, and seconds behind a silent spinner is
// a screen that looks broken at exactly the wrong moment.

/** How a validation run ended. "error" is not a pass: a check that could not
 *  run has found nothing and proved nothing. */
export type ValidationRunState = "running" | "passed" | "failed" | "error";

export type ValidationStageState = "pending" | "running" | "passed" | "failed" | "skipped";

export interface ValidationStage {
  id: string;
  label: string;
  state: ValidationStageState;
  /** one line saying what this stage actually did ("128 values checked"),
   *  which is the difference between a progress bar and knowing something is
   *  happening */
  detail?: string;
  startedAt?: string;
  endedAt?: string;
}

/** One problem found in the change, named the way the person who made it would
 *  recognize it. */
export interface ValidationFinding {
  severity: "error" | "warning";
  /** what kind of check found it: type, mandatory, key, unique, leafref, must,
   *  when, choice, count, feature, status, schema */
  rule: string;
  file?: string;
  path?: string;
  line?: number;
  instance?: string;
  /** the catalog parameter this lands on, when one could be identified - what
   *  makes "fix this" a click rather than an investigation */
  paramId?: string;
  name?: string;
  message: string;
  /** the schema's own expression, for the reader who wants it */
  detail?: string;
  /** the model file the rule came from, so a vendor's constraint is never
   *  shown as the product's opinion */
  schema?: string;
  engine?: string;
}

/** An edit that could not be applied to the files at all. */
export interface ItemProblem {
  paramId?: string;
  instance?: string;
  action?: string;
  file?: string;
  message: string;
}

export interface ValidationRun {
  id: string;
  changeId: number;
  state: ValidationRunState;
  /** identifies the draft this run validated; a submit only trusts a run whose
   *  fingerprint still matches */
  fingerprint: string;
  stages: ValidationStage[];
  findings: ValidationFinding[];
  problems: ItemProblem[];
  engine?: string;
  /** false when no full-document validator could run. NOT the same as "no
   *  findings" - a client that treats them alike is telling the user their
   *  change was checked when nothing looked at it. */
  available: boolean;
  reason?: string;
  errors: number;
  warnings: number;
  documents: number;
  values: number;
  unmatched: number;
  /** checks passed over, with the reason - silence about them would present a
   *  partial check as a complete one */
  skipped?: string[];
  startedAt: string;
  endedAt?: string;
}

export interface EngineStatus {
  name: string;
  available: boolean;
  reason?: string;
}

/** What this deployment can actually check, for the panel that says so. */
export interface ValidationStatus {
  schemaDetected: boolean;
  modules: number;
  nodes: number;
  schemaDirs?: string[];
  schemaVersion?: string;
  engine?: string;
  available: boolean;
  reason?: string;
  engineVersion?: string;
  engines: EngineStatus[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  /** seconds to wait before retrying, from a 429 Retry-After header */
  readonly retryAfter?: number;
  readonly fields?: FieldError[];
  /** where a document stopped parsing, when that is what was rejected */
  readonly syntax?: SyntaxDetail;
  /** the validation run that refused a submit. A 422 from the gate carries the
   *  whole run, not just the fact of the refusal, so the dialog can show what
   *  is wrong and where instead of a red toast saying "invalid". */
  readonly validation?: ValidationRun;
  constructor(init: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    retryAfter?: number;
    fields?: FieldError[];
    syntax?: SyntaxDetail;
    validation?: ValidationRun;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
    this.fields = init.fields;
    this.syntax = init.syntax;
    this.validation = init.validation;
  }
  get isUnauthorized() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  /** a concurrency/state clash the user resolves by reloading (409/412) */
  get isConflict() { return this.status === 409 || this.status === 412; }
  get isValidation() { return this.status === 422; }
  get isRateLimited() { return this.status === 429; }
  get isServer() { return this.status >= 500; }
  /**
   * No application is connected to this deployment. Not a fault: it is the
   * ordinary state of a fresh (or emptied) workspace, so the UI shows an empty
   * state rather than an error, and never retries.
   */
  get isNoRepository() { return this.code === "no_repository"; }
  /**
   * The request named an application this deployment does not have (a stale
   * link, a removed application, or one whose connection never completed).
   * Like isNoRepository it is a STATE the UI renders as an empty page with a
   * way out - never a red failure toast, and never worth retrying.
   */
  get isUnknownRepository() { return this.code === "unknown_repository"; }
  /** true for failures a retry could plausibly fix (network/5xx/429) */
  get isRetryable() {
    if (this.isNoRepository || this.isUnknownRepository) return false; // reconnecting fixes it, not a retry
    return this.status === 429 || this.status >= 500;
  }
}

/** The request took too long and was aborted client-side. */
export class TimeoutError extends Error {
  constructor() {
    super("The request took too long and was cancelled");
    this.name = "TimeoutError";
  }
}

/** A connection that is taking longer than the dialog will wait. NOT a failure:
 *  the server is still copying the repository and the application appears when
 *  it is ready. It exists so the UI stops calling a slow clone an error - and
 *  so nothing tears the half-copied repository down behind the user's back,
 *  which is what made every retry afterwards fail. */
export class StillConnectingError extends Error {
  constructor(public readonly id: string) {
    super("still connecting");
    this.name = "StillConnectingError";
  }
}

// Default per-request timeout. A request that hangs must never leave the UI
// spinning forever: it is aborted and surfaced as a TimeoutError the user sees.
const DEFAULT_TIMEOUT_MS = 30_000;

// lastCatalogRev tracks the catalog revision from the most recent read that
// carried an ETag (grid, parameter, application). Catalog writes echo it as
// If-Match so the server can reject an edit built on a stale view (optimistic
// concurrency) instead of silently clobbering a concurrent change.
let lastCatalogRev: string | null = null;

// A 401 means the session is missing or expired. We dispatch an event rather
// than hard-redirecting, so the app can surface a graceful "sign in again"
// prompt; the auth layer listens for it.
export const UNAUTHORIZED_EVENT = "configer:unauthorized";
function emitUnauthorized() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
}

interface ReqOpts {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** external cancellation (e.g. a superseded search keystroke); aborting it
   *  aborts the request in flight alongside the built-in timeout */
  signal?: AbortSignal;
}

// request performs one fetch with a hard timeout, keeps the offline/online
// resilience layer informed, and captures the catalog revision from ETags. A
// network failure becomes OfflineError; a timeout becomes TimeoutError; the
// caller turns a non-2xx response into a typed ApiError.
async function request(path: string, init?: RequestInit, opts?: ReqOpts): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // Chain an external abort signal (a caller cancelling a superseded request)
  // into the same controller, so either the timeout or the caller can abort.
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      // Send the session cookie even when the API is on another origin (the
      // backend allows the configured origin with credentials).
      credentials: "include",
    });
  } catch {
    if (controller.signal.aborted) throw new TimeoutError();
    markOffline();
    throw new OfflineError();
  } finally {
    clearTimeout(timer);
  }
  markOnline();
  const etag = res.headers.get("ETag");
  if (etag) lastCatalogRev = etag;
  return res;
}

// httpError turns a non-2xx response into a typed ApiError, parsing the
// standardized envelope and surfacing a 401 to the auth layer.
async function httpError(res: Response): Promise<ApiError> {
  let body: {
    error?: string; code?: string; requestId?: string;
    fields?: FieldError[]; syntax?: SyntaxDetail; validation?: ValidationRun;
  } = {};
  try {
    body = await res.json();
  } catch {
    // non-JSON error body: fall back to the status line
  }
  const retryHeader = res.headers.get("Retry-After");
  const err = new ApiError({
    status: res.status,
    code: body.code || `http_${res.status}`,
    message: body.error || res.statusText || `Request failed (${res.status})`,
    requestId: body.requestId,
    retryAfter: retryHeader ? Number(retryHeader) || undefined : undefined,
    fields: body.fields,
    syntax: body.syntax,
    validation: body.validation,
  });
  if (err.isUnauthorized) emitUnauthorized();
  return err;
}

async function get<T>(path: string, opts?: ReqOpts): Promise<T> {
  const res = await request(path, undefined, opts);
  if (!res.ok) throw await httpError(res);
  return res.json() as Promise<T>;
}

// snapGet caches the successful response locally so the UI can keep working
// from the last snapshot when the service is temporarily unreachable.
async function snapGet<T>(path: string, snapKey: string): Promise<T> {
  const data = await get<T>(path);
  saveSnapshot(snapKey, data);
  return data;
}

// --- capability gate ------------------------------------------------------
// The service is the authority on who may change what, and it enforces the
// rule on every request. This is the client-side backstop: a person with view
// access must not be able to START a change, so a write is refused HERE rather
// than travelling to the service to come back as a red toast over a value the
// user already typed.
//
// The UI hides write affordances from a viewer (see identity.ts's canEdit), and
// this makes that guarantee whole: a control that slips through, a stale tab
// whose role was just downgraded, or a keyboard path nobody gated still cannot
// send a write. It is deliberately NOT a security boundary - the service is -
// it is what keeps "view only" honest in the interface.
//
// It applies to REPOSITORY-SCOPED writes only, because that is the only thing
// the role describes. Signing out, connecting a new application, managing the
// workspace: none of those belong to an application, and gating them on one
// application's role locked people out of the product - out of creating their
// first application, and out of signing out again.
let writesAllowed = true;

/** Whether a path is scoped to one application, and therefore governed by the
 *  caller's role in it. Everything else (auth, the workspace, the deployment)
 *  is not. */
function repoScoped(path: string): boolean {
  return path.startsWith("/repos/");
}

/** Publish what the signed-in person may do. Called by the identity layer;
 *  `true` while the deployment has no login (single-user mode). */
export function setWritesAllowed(allowed: boolean) {
  writesAllowed = allowed;
}

/** ApiError shaped exactly like the service's own refusal, so every existing
 *  error path (toasts, field errors, mutation onError) treats it identically. */
function forbiddenWrite(): ApiError {
  return new ApiError({
    status: 403,
    code: "forbidden",
    message: "your access to this application is view only; this action needs editor",
  });
}

async function send<T>(method: string, path: string, body?: unknown, opts?: ReqOpts): Promise<T> {
  if (!writesAllowed && repoScoped(path)) throw forbiddenWrite();
  const res = await request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
      body: body === undefined ? "{}" : JSON.stringify(body),
    },
    opts,
  );
  if (!res.ok) throw await httpError(res);
  // 204 No Content and empty bodies must not blow up JSON parsing.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const put = <T,>(path: string, body: unknown, opts?: ReqOpts) => send<T>("PUT", path, body, opts);

// putCatalog is a PUT to a direct-commit catalog resource: it attaches the
// last-known catalog revision as If-Match, so a stale edit is rejected (412)
// rather than silently overwriting a concurrent change.
const putCatalog = <T,>(path: string, body: unknown) =>
  put<T>(path, body, lastCatalogRev ? { headers: { "If-Match": lastCatalogRev } } : undefined);

/** The current catalog revision the client last observed (for diagnostics). */
export const catalogRev = () => lastCatalogRev;

export const api = {
  // --- workspace level (not repo-scoped) ---
  health: (opts?: { timeoutMs?: number }) => get<Health>("/health", opts),
  capabilities: () => get<Capabilities>("/capabilities"),
  me: () => get<AuthState>("/auth/me"),
  logout: () => send<{ ok: boolean }>("POST", "/auth/logout"),
  myRole: (repoId: string) => get<MyRole>(`/repos/${encodeURIComponent(repoId)}/role`),
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
  // Global metadata search across every application. Cancellable so a superseded
  // keystroke aborts its request rather than racing later ones.
  search: (q: string, opts?: { scope?: "global" | "app"; repo?: string; limit?: number; signal?: AbortSignal }) => {
    const qs = new URLSearchParams({ q });
    if (opts?.scope) qs.set("scope", opts.scope);
    if (opts?.repo) qs.set("repo", opts.repo);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    return get<{ hits: SearchHitDTO[] }>(`/search?${qs.toString()}`, { signal: opts?.signal });
  },
  githubStatus: () => get<GitHubStatus>("/github/status"),
  browseFolders: (path?: string) =>
    get<FolderListing>(`/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  /** The picker's listing: what the credential can reach, most recently pushed
   *  first. `truncated` means the window ended before the account did, so the
   *  UI must say so rather than let a missing repository read as a missing
   *  repository. */
  githubRepos: () => get<{ repos: GitHubRepo[]; truncated?: boolean }>("/github/repos"),
  /** Search GitHub itself, scoped server-side to the user's own account and
   *  their organizations - the only way to reach a repository outside the
   *  listing's window. */
  githubSearchRepos: (q: string, opts?: { signal?: AbortSignal }) =>
    get<{ repos: GitHubRepo[]; total?: number; scoped?: boolean }>(
      `/github/repos/search?q=${encodeURIComponent(q)}`,
      { signal: opts?.signal },
    ),
  /** Organizations the user belongs to, so the picker can name one it can see
   *  no repositories in instead of leaving it invisible. */
  githubOrgs: () =>
    get<{ orgs: { login: string }[]; grantUrl?: string; needsReauth?: boolean }>("/github/orgs"),
  githubBranches: (fullName: string) =>
    get<{ default: string; branches: string[] }>(`/github/branches?repo=${encodeURIComponent(fullName)}`),
  // connectRepo starts an async connection: the server clones/opens in the
  // background and returns 202 with a `status:"connecting"` summary. Use
  // waitForRepoReady to await the result.
  // Is this change name free, and what branch would it produce? Called while
  // the user types, so a clash is found before the name becomes a branch.
  checkChangeName: (title: string, id?: number, category?: string) =>
    get<ChangeNameCheck>(
      rp(
        `/changes/name-check?title=${encodeURIComponent(title)}${id ? `&id=${id}` : ""}` +
          (category ? `&category=${encodeURIComponent(category)}` : ""),
      ),
    ),

  connectRepo: (p: { url: string; name?: string; branch?: string; token?: string; mode?: "remote" }) =>
    send<RepoSummary>("POST", "/repos", p),
  // waitForRepoReady polls the portfolio until the given repository leaves the
  // "connecting" state, resolving with its summary when ready or throwing an
  // ApiError when the background connection failed or timed out.
  waitForRepoReady: async (
    id: string,
    opts?: { timeoutMs?: number; onPoll?: (ws: Workspace) => void },
  ): Promise<RepoSummary> => {
    // Long enough for a large repository on a slow link. Past it the wait ends,
    // but the connection does not: see connectApplication.
    const deadline = Date.now() + (opts?.timeoutMs ?? 300_000);
    // Backing off matters here. A local repository is ready almost at once, so
    // the first checks are quick; a large one takes minutes, and asking every
    // second and a half for all of them is a request every 1.5s for five
    // minutes to learn a single boolean. Quick at first, calm once it is clear
    // this will take a while.
    let wait = 600;
    for (;;) {
      const ws = await get<Workspace>("/workspace");
      // Every poll is a fresh portfolio: handing it to the cache keeps the
      // page behind the dialog current without a second request for the same
      // bytes, which is where most of the duplication came from.
      opts?.onPoll?.(ws);
      const repo = ws.repos.find((r) => r.id === id);
      if (repo && repo.status === "error") {
        throw new ApiError({ status: 422, code: "connect_failed", message: repo.error || "connecting the repository failed" });
      }
      if (repo && repo.status !== "connecting") return repo;
      if (Date.now() > deadline) throw new StillConnectingError(id);
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(Math.round(wait * 1.4), 4000);
    }
  },
  // connectApplication is the whole "create an application" step: start the
  // connection, wait for the background clone/open, and hand back the ready
  // application. A FAILED connection leaves nothing behind - the half-connected
  // entry is cleared - so the portfolio never grows a ghost application that
  // answers every read with "not connected" and cannot be opened to be removed.
  //
  // A SLOW one is left exactly where it is. Clearing it would pull the folder
  // out from under a git clone that is still writing, and the next attempt then
  // collides with the one still running: one slow repository became an error on
  // every try after it.
  connectApplication: async (
    p: {
      url: string;
      name?: string;
      branch?: string;
      token?: string;
      mode?: "remote";
    },
    onPoll?: (ws: Workspace) => void,
  ): Promise<RepoSummary> => {
    const started = await api.connectRepo(p);
    try {
      return await api.waitForRepoReady(started.id, { onPoll });
    } catch (err) {
      if (err instanceof StillConnectingError) throw err;
      try {
        await api.removeRepo(started.id);
      } catch {
        // best effort: the failure the user needs to see is the original one
      }
      throw err;
    }
  },
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
  }) => putCatalog<ApplicationDetails>(rp("/application"), p),
  deinit: (author?: string) =>
    send<{ ok: boolean; removed: boolean }>("POST", rp("/deinit"), { author }),
  /** The proposal. `manage` names files to include that the scan would
   *  otherwise pass over - the user overriding a default for their own
   *  repository, one file at a time. */
  discover: (manage?: string[]) =>
    send<Discovery>("POST", rp("/discover"), manage?.length ? { manage } : undefined),
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
  // locate returns the 1-based line where a value lives in a real file, so the
  // Details pane can open the file and jump straight to it (0 when unknown).
  locate: (file: string, path: string, format?: string) => {
    const qs = new URLSearchParams({ file, path });
    if (format) qs.set("format", format);
    return get<{ line: number }>(rp(`/locate?${qs.toString()}`));
  },
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
    return get<{
      parameter: string;
      instance: string;
      entries: ParamHistoryEntry[] | null;
      lastChange: ParamHistoryEntry | null;
      supported: boolean;
    }>(rp(`/parameters/${encodeURIComponent(id)}/history${suffix}`));
  },
  // The configuration timeline: snapshots of how the configuration evolved.
  // `instance` narrows the story to one instance; omitted, it covers the whole
  // application.
  timeline: (opts?: { instance?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.instance) qs.set("instance", opts.instance);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return get<{
      scope: string;
      instance: string;
      snapshots: TimelineEntry[] | null;
      /** the branch being published to */
      branch: string;
      /** its head commit: where the application is right now */
      head: string;
      /** the trunk plus every standing environment branch */
      lanes: BranchLane[] | null;
      supported: boolean;
    }>(rp(`/timeline${suffix}`));
  },
  // One snapshot opened up. The instance must match the timeline it was read
  // from, so the comparison baseline is the same.
  timelineSnapshot: (sha: string, opts?: { instance?: string; limit?: number }) => {
    const qs = new URLSearchParams({ sha });
    if (opts?.instance) qs.set("instance", opts.instance);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    return get<SnapshotDetail>(rp(`/timeline/snapshot?${qs.toString()}`));
  },
  // Stage the edits that bring a scope back to a snapshot. Nothing touches Git
  // until the resulting draft is submitted and published, so a restore is
  // reviewed like any other change.
  restore: (p: {
    ref: string;
    scope: RestoreScope;
    instance?: string;
    paramId?: string;
    global?: boolean;
  }) =>
    send<{ draftId: number; applied: number; skipped: string[]; ref: string; scope: string }>(
      "POST",
      rp("/restore"),
      { ...p, author: "Local user" },
    ),
  plugins: () => get<PluginManifest[]>(rp("/plugins")),
  // External parameter sources.
  sourcePlugins: () => get<SourcePlugin[]>(rp("/source-plugins")),
  sources: () => get<Source[]>(rp("/sources")),
  addSource: (s: { id?: string; name: string; kind: string; secret?: boolean; config: Record<string, string>; author?: string }) =>
    send<Source>("POST", rp("/sources"), s),
  updateSource: (id: string, patch: { name?: string; secret?: boolean; config?: Record<string, string>; author?: string }) =>
    send<Source>("PUT", rp(`/sources/${encodeURIComponent(id)}`), patch),
  deleteSource: (id: string, author?: string) =>
    send<{ ok: boolean; removed: string }>("DELETE", rp(`/sources/${encodeURIComponent(id)}`), { author }),
  browseSource: (id: string, path?: string) =>
    get<{ entries: BrowseEntry[] }>(rp(`/sources/${encodeURIComponent(id)}/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`)),
  sourceContents: (id: string) =>
    get<{ source: Source; count: number; values: SourceKV[] }>(rp(`/sources/${encodeURIComponent(id)}/contents`)),
  mapParamToSource: (paramId: string, ref: { sourceId: string; key: string; instance?: string } | null, author?: string) =>
    send<{ ok: boolean }>("POST", rp(`/parameters/${encodeURIComponent(paramId)}/source`),
      ref ? { ...ref, author } : { clear: true, author }),
  incomingChanges: () => get<{ changes: IncomingChange[] }>(rp("/sources/incoming")),
  acceptIncoming: (changes: { paramId: string; instance?: string }[], author?: string) =>
    send<{ ok: boolean; staged: number; pending: number; changeId: number }>(
      "POST", rp("/sources/incoming/accept"), { changes, author }),
  refreshSources: () =>
    send<{ ok: boolean; sources: { id: string; ok: boolean; count?: number; error?: string }[] }>(
      "POST", rp("/sources/refresh")),
  scan: () => send<ScanResult>("POST", rp("/scan")),
  // Parse a pasted config blob into candidate parameters (incremental import).
  analyzeImport: (content: string, file?: string) =>
    send<{ file: string; count: number; candidates: AnalyzeCandidate[] | null }>(
      "POST", rp("/import/analyze"), { content, file }),
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
    put<{
      ok: boolean;
      staged: number;
      kind?: "values" | "file";
      managedChanges?: number;
      /** settings this edit ADDED to the file that nothing managed yet; each is
       *  staged as a parameter the change starts managing, so they show up in
       *  the grid and in the review instead of only inside a file diff */
      newParameters?: number;
      /** catalog entries that had to follow their values to a new address,
       *  because the edit inserted or removed an entry of a repeated structure
       *  and everything below it shifted */
      movedParameters?: number;
      /** catalog entries whose value the edit took out of the file */
      droppedParameters?: number;
      detail?: string;
    }>(rp("/files/draft"), p),
  /** Copy one entry of a repeated structure (an XML element that occurs several
   *  times under its parent, a YAML/JSON list entry) and stage the result. The
   *  copy is APPENDED after the last entry of its kind, so no existing entry is
   *  renumbered and no binding starts reading a different thing. */
  duplicateEntry: (p: { instance?: string; file: string; path: string; author?: string }) =>
    send<{ ok: boolean; file: string; newPath: string; newParameters: number; movedParameters?: number }>(
      "POST", rp("/files/duplicate"), p),
  presets: () => get<PresetRule[]>(rp("/validation/presets")),
  regions: () => get<RegionPlace[]>(rp("/regions")),
  /** Every value in one file that a parameter is bound to, with the line it
   *  sits on in the content the explorer shows. */
  managedValues: (file: string, instance?: string) =>
    get<{ file: string; values: ManagedValue[] }>(
      rp(`/files/managed?file=${encodeURIComponent(file)}${instance ? `&instance=${encodeURIComponent(instance)}` : ""}`),
    ),
  setValue: (p: { instance: string; paramId: string; value?: unknown; action?: CellAction; scope?: "global"; author?: string }) =>
    put<{ ok: boolean; value: unknown; pending: number; changeId: number }>(rp("/values"), p),
  // Fan a single parameter's edit across many instances in one request. Each
  // target reports success or a per-target error; valid targets still stage.
  bulkSetValue: (p: { paramId: string; edits: { instance: string; value?: unknown }[]; action?: CellAction }) =>
    put<{ ok: boolean; staged: number; results: { instance: string; ok: boolean; error?: string }[]; pending: number; changeId: number }>(
      rp("/values/bulk"), p),
  // Seed one instance from another: stage every parameter whose value differs.
  copyInstanceFrom: (target: string, source: string) =>
    send<{ ok: boolean; staged: number; source: string; pending: number; changeId: number }>(
      "POST", rp(`/instances/${encodeURIComponent(target)}/copy-from`), { source }),
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
  // Undo many at once: ONE request, one write. Per-item DELETEs serialize on
  // the draft lock, and a selection of eighty took long enough to look broken.
  revertValues: (items: { paramId: string; instance: string }[]) =>
    send<{ ok: boolean; removed: number; pending: number }>("DELETE", rp("/values/bulk"), { items }),
  /** STAGE "stop managing a parameter" on the draft: when the change is
   *  published the parameter leaves the catalog and the grid, and every file
   *  keeps its value. Not the same as deleteParameter, which retires it and
   *  removes the value from every file. */
  unmanageParameter: (id: string, author?: string) =>
    send<{ ok: boolean; staged: string; pending: number; changeId: number }>(
      "POST", rp(`/parameters/${encodeURIComponent(id)}/unmanage`), { author }),
  updateParameter: (
    id: string,
    patch: {
      type?: string;
      /** element type when type is "list" (e.g. ipv4, integer) */
      itemType?: string;
      validation?: Validation;
      displayName?: string;
      description?: string;
      category?: string;
      scope?: Scope;
      secret?: boolean;
      default?: unknown;
      /** computed default from another parameter, e.g. "{admin-port}+1" */
      derived?: string;
      /** attach or re-map: always produced by the interactive picker */
      bindings?: Binding[];
      author?: string;
    },
  ) => putCatalog<Parameter>(rp(`/parameters/${encodeURIComponent(id)}`), patch),
  repoStatus: () => get<RepoStatus>(rp("/repo/status")),
  repoSync: () => send<RepoStatus>("POST", rp("/repo/sync")),
  // The change list is cursor-paginated server-side ({items, nextCursor,
  // hasMore}); the views want the newest page as an array, so unwrap `items`
  // (and cache the array so the offline snapshot keeps its shape).
  changes: async () => {
    const page = await get<Page<ChangeRequest>>(rp("/changes"));
    const items = page.items ?? [];
    saveSnapshot(snapKey("changes"), items);
    return items;
  },
  // Explicit-repo reads for the global (cross-application) views: the inbox
  // and the instances estate aggregate over every repository, not just the
  // active one, so they cannot go through rp().
  changesOf: async (repoId: string) => {
    const page = await get<Page<ChangeRequest>>(`/repos/${encodeURIComponent(repoId)}/changes`);
    return page.items ?? [];
  },
  instancesOf: (repoId: string) =>
    get<{ instances: Instance[] | null }>(`/repos/${encodeURIComponent(repoId)}/instances`),
  findingsOf: (repoId: string) =>
    get<FindingsResult>(`/repos/${encodeURIComponent(repoId)}/repo/findings`),
  repoStatusOf: (repoId: string) =>
    get<RepoStatus>(`/repos/${encodeURIComponent(repoId)}/repo/status`),
  draft: () => snapGet<{ draft: ChangeRequest | null }>(rp("/changes/draft"), snapKey("draft")),
  change: (id: number) => get<ChangeRequest>(rp(`/changes/${id}`)),
  previewChange: (id: number) => get<ChangePreview>(rp(`/changes/${id}/preview`)),
  prStatus: (id: number) => get<PrStatus>(rp(`/changes/${id}/pr-status`)),
  submitChange: (
    id: number,
    p: {
      title: string;
      description?: string;
      reference?: string;
      category?: string;
      author?: string;
      /** submit despite blocking findings. Not a way around the gate: the
       *  reason is written into the change itself, where the approver reads it. */
      override?: boolean;
      overrideReason?: string;
    },
  ) => send<ChangeRequest>("POST", rp(`/changes/${id}/submit`), p),
  /** What this deployment can check. Workspace-wide question, repo-scoped
   *  answer: the models live in the repository. */
  validationStatus: () => get<ValidationStatus>(rp("/validation/status")),
  /** Start validating a change. Returns immediately with a run to watch. */
  startValidation: (id: number) => send<ValidationRun>("POST", rp(`/changes/${id}/validation`), {}),
  /** The run's current state. Poll while `state` is "running". */
  validationRun: (id: number, runId?: string) =>
    get<ValidationRun>(rp(`/changes/${id}/validation${runId ? `?run=${encodeURIComponent(runId)}` : ""}`)),
  approveChange: (id: number) => send<ChangeRequest>("POST", rp(`/changes/${id}/approve`), { author: "Local user" }),
  mergeChange: (id: number) => send<ChangeRequest>("POST", rp(`/changes/${id}/merge`)),
  rejectChange: (id: number) => send<ChangeRequest>("POST", rp(`/changes/${id}/reject`)),
  revertChange: (id: number) =>
    send<{ draftId: number; applied: number; skipped: string[]; source: number }>(
      "POST",
      rp(`/changes/${id}/revert`),
      { author: "Local user" },
    ),
  addComment: (id: number, body: string, author?: string) =>
    send<ChangeRequest>("POST", rp(`/changes/${id}/comments`), { body, author }),
  setReviewers: (id: number, reviewers: string[]) =>
    put<ChangeRequest>(rp(`/changes/${id}/reviewers`), { reviewers }),
};
