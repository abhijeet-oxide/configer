// Typed client for the Configer backend REST API.

export type Scope =
  | "default"
  | "global"
  | "environment"
  | "site"
  | "zone"
  | "instance";

export type CellState = "normal" | "new" | "deprecated" | "na";

export interface Instance {
  name: string;
  environment?: string;
  region?: string;
  zone?: string;
  site?: string;
  softwareVersion?: string;
  labels?: Record<string, string>;
  status?: string;
}

export interface Validation {
  required?: boolean;
  pattern?: string;
  enum?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  preset?: string;
  schemaRef?: string;
}

// A predefined validation rule from the backend's rule library, selectable
// from a dropdown in the rule editor.
export interface PresetRule {
  id: string;
  name: string;
  description: string;
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
  scope: Scope;
  secret: boolean;
  source: { file: string; path: string; format: string };
  validation?: Validation;
  default?: unknown;
  versionIntroduced?: string;
  versionDeprecated?: string;
  dependsOn?: string[];
}

export interface Cell {
  value: unknown;
  source: Scope;
  set: boolean;
  state: CellState;
  valid: boolean;
  message?: string;
  editable: boolean;
  /** staged in the current draft change request, not yet on Git */
  pending?: boolean;
}

// --- change requests -------------------------------------------------------

export type ChangeState = "draft" | "under_review" | "approved" | "published" | "rejected";

export interface ChangeItem {
  paramId: string;
  instance: string;
  old: unknown;
  new: unknown;
  updatedAt: string;
}

export interface ChangeRequest {
  id: number;
  title: string;
  description?: string;
  author: string;
  targetBranch: string;
  branch?: string;
  baseSha?: string;
  commitSha?: string;
  state: ChangeState;
  items: ChangeItem[] | null;
  prNumber?: number;
  prUrl?: string;
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
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: string;
  description: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
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
  grid: () => get<Grid>("/grid"),
  compare: (left: string, right: string) =>
    get<DiffResult>(`/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`),
  plugins: () => get<PluginManifest[]>("/plugins"),
  render: (instance: string) =>
    get<{ instance: string; files: { path: string; content: string }[] }>(
      `/render/${encodeURIComponent(instance)}`,
    ),
  presets: () => get<PresetRule[]>("/validation/presets"),
  setValue: (p: { instance: string; paramId: string; value: unknown; author?: string }) =>
    put<{ ok: boolean; value: unknown; pending: number; changeId: number }>("/values", p),
  revertValue: (paramId: string, instance: string) =>
    send<{ ok: boolean }>(
      "DELETE",
      `/values?paramId=${encodeURIComponent(paramId)}&instance=${encodeURIComponent(instance)}`,
    ),
  updateParameter: (id: string, patch: { type?: string; validation?: Validation; author?: string }) =>
    put<Parameter>(`/parameters/${encodeURIComponent(id)}`, patch),
  repoStatus: () => get<RepoStatus>("/repo/status"),
  repoSync: () => send<RepoStatus>("POST", "/repo/sync"),
  changes: () => get<ChangeRequest[]>("/changes"),
  draft: () => get<{ draft: ChangeRequest | null }>("/changes/draft"),
  change: (id: number) => get<ChangeRequest>(`/changes/${id}`),
  submitChange: (id: number, p: { title: string; description?: string; author?: string }) =>
    send<ChangeRequest>("POST", `/changes/${id}/submit`, p),
  mergeChange: (id: number) => send<ChangeRequest>("POST", `/changes/${id}/merge`),
  rejectChange: (id: number) => send<ChangeRequest>("POST", `/changes/${id}/reject`),
};
