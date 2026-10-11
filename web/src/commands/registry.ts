// The command registry: every action the tool can perform, declared as data in
// one place, keyed by a stable id. It is the single source of truth behind both
// the search palette (a command becomes searchable the moment it is registered)
// and any toolbar button that chooses to render from it. Adding an action
// tomorrow is one registerCommand({...}) call in the owning feature - nothing in
// the search code changes. This mirrors how an editor's command palette is just
// a view over its command contributions.

import type { ReactNode } from "react";
import type { AppCtx, SearchScope } from "../search/types";

export interface Command {
  /** stable, namespaced id, e.g. "changes.submit" or "nav.approvals" */
  id: string;
  title: string;
  /** extra words to match on beyond the title (synonyms, the section name) */
  keywords?: string;
  /** a short group label shown as the result's subtitle, e.g. "Navigation" */
  category?: string;
  icon?: ReactNode;
  /** which surface offers this command; default "both" */
  scope?: SearchScope | "both";
  /** hide the command unless it applies in the current context (role, inApp) */
  when?: (ctx: AppCtx) => boolean;
  /** perform the action */
  run: (ctx: AppCtx, args?: unknown) => void;
}

const registry = new Map<string, Command>();

/** Register (or replace) a command. Idempotent by id, so a module that is
 *  imported more than once does not create duplicates. */
export function registerCommand(cmd: Command): void {
  registry.set(cmd.id, cmd);
}

/** All registered commands, in registration order. */
export function allCommands(): Command[] {
  return [...registry.values()];
}

/** Look one up by id (used when resolving a { kind: "command" } target). */
export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

/** Run a command by id if it exists and applies in the given context. */
export function runCommand(id: string, ctx: AppCtx, args?: unknown): void {
  const cmd = registry.get(id);
  if (!cmd) return;
  if (cmd.when && !cmd.when(ctx)) return;
  cmd.run(ctx, args);
}
