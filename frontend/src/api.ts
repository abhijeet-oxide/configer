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
  schemaRef?: string;
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

export const api = {
  grid: () => get<Grid>("/grid"),
  compare: (left: string, right: string) =>
    get<DiffResult>(`/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`),
  plugins: () => get<PluginManifest[]>("/plugins"),
  render: (instance: string) =>
    get<{ instance: string; files: { path: string; content: string }[] }>(
      `/render/${encodeURIComponent(instance)}`,
    ),
};
