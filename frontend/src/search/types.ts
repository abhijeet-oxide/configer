// The shared vocabulary of the global search framework. Everything the palette
// renders is a SearchHit; everything that produces hits is a SearchProvider.
// Adding a new searchable thing tomorrow is one registry.register() call - the
// palette, ranking, and navigation below never change. This file imports
// nothing from the rest of the app on purpose: it is the dependency root, so
// providers, the command registry, and target resolution can all build on it
// without cycles.

import type { ReactNode } from "react";
import type { Grid, ChangeRequest, Workspace } from "../api";

/** The two search surfaces. "global" spans every application (metadata only);
 *  "app" is scoped to the open application and may reach its loaded values. */
export type SearchScope = "global" | "app";

/** The kind of thing a hit points at. New entity types extend this union. */
export type HitType =
  | "application"
  | "parameter"
  | "instance"
  | "change"
  | "command"
  | "file";

/** Where selecting a hit takes you. A target is a structured intent, never a
 *  raw URL: the client resolves it through the same deep-link vocabulary the
 *  store already owns (?param=&inst= over /application/<id>/<tab>), so a hit
 *  minted on the server and one minted on the client navigate identically. */
export type Target =
  | { kind: "navigate"; app?: string | null; view: string; param?: string; inst?: string }
  | { kind: "command"; commandId: string; args?: unknown }
  | { kind: "external"; url: string };

/** A small colored label on a result (e.g. "3 invalid", "global", "under review"). */
export interface HitBadge {
  text: string;
  color?: string;
}

/** One search result, normalized so the palette renders every entity the same. */
export interface SearchHit {
  type: HitType;
  /** unique within a result set; the palette keys on `${type}:${id}` */
  id: string;
  title: string;
  subtitle?: string;
  badges?: HitBadge[];
  icon?: ReactNode;
  /** the extra text a query is matched against beyond the title */
  keywords?: string;
  /** filled by the ranking layer; providers may leave it 0 */
  score: number;
  target: Target;
}

/** The navigation primitives a target (or a command) uses to move the app.
 *  Built once by the palette from the store + react-query, and passed down so
 *  neither providers nor commands import the store directly. */
export interface Nav {
  switchRepo: (id: string | null) => void;
  setSection: (section: string) => void;
  selectParam: (id: string | null) => void;
  setJump: (kind: "param" | "instance" | "cell", id: string, inst?: string) => void;
  openExternal: (url: string) => void;
}

/** The ambient application context a command reads to decide whether it applies
 *  (`when`) and how to run. Kept tiny and serializable-ish on purpose. */
export interface AppCtx {
  repoId: string | null;
  section: string;
  /** true when the current view belongs to one application */
  inApp: boolean;
  nav: Nav;
}

/** The already-loaded data providers search over. The palette fills these from
 *  the shared react-query cache, so a keystroke never triggers a fetch. */
export interface SearchData {
  workspace?: Workspace;
  grid?: Grid;
  changes?: ChangeRequest[];
}

/** Everything a provider needs to answer a query. */
export interface SearchContext {
  mode: SearchScope;
  repoId: string | null;
  inApp: boolean;
  data: SearchData;
  appCtx: AppCtx;
}

/** A source of results for one entity type. `scope` gates which surface it
 *  serves; "both" runs in global and app modes. `query` may be async (a
 *  server-backed provider) - the registry awaits it. */
export interface SearchProvider {
  id: string;
  scope: SearchScope | "both";
  query: (ctx: SearchContext, q: string) => SearchHit[] | Promise<SearchHit[]>;
}
