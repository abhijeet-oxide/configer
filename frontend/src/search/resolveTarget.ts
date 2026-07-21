// Turns a hit's structured Target into an actual navigation, using the same
// primitives the store already exposes. This is the ONLY place that knows how a
// target maps to app movement, so a hit made on the server and one made on the
// client behave the same when selected.

import type { AppCtx, Target } from "./types";
import { runCommand } from "../commands/registry";

export function resolveTarget(target: Target, ctx: AppCtx): void {
  const { nav } = ctx;
  switch (target.kind) {
    case "external":
      nav.openExternal(target.url);
      return;
    case "command":
      runCommand(target.commandId, ctx, target.args);
      return;
    case "navigate": {
      // Switch application first (only when the target names a different one),
      // then the section, then refine to a parameter/instance within it.
      if (target.app !== undefined && target.app !== null && target.app !== ctx.repoId) {
        nav.switchRepo(target.app);
      }
      nav.setSection(target.view);
      if (target.param) {
        nav.selectParam(target.param);
        nav.setJump("param", target.param, target.inst);
      } else if (target.inst) {
        nav.setJump("instance", target.inst);
      }
      return;
    }
  }
}
