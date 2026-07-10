// Central icon module: Phosphor icons via Iconify, bundled offline (per-icon
// data imports; no runtime fetch to the Iconify API, so it works in
// air-gapped deployments). Ic wraps <Icon> with sane inline alignment.
import { Icon, type IconifyIcon } from "@iconify/react";
import house from "@iconify-icons/ph/house";
import table from "@iconify-icons/ph/table";
import gitDiff from "@iconify-icons/ph/git-diff";
import gitPullRequest from "@iconify-icons/ph/git-pull-request";
import sealCheck from "@iconify-icons/ph/seal-check";
import clockCounterClockwise from "@iconify-icons/ph/clock-counter-clockwise";
import shieldCheck from "@iconify-icons/ph/shield-check";
import plugsConnected from "@iconify-icons/ph/plugs-connected";
import rocketLaunch from "@iconify-icons/ph/rocket-launch";
import downloadSimple from "@iconify-icons/ph/download-simple";
import activity from "@iconify-icons/ph/activity";
import scroll from "@iconify-icons/ph/scroll";
import usersThree from "@iconify-icons/ph/users-three";
import gearSix from "@iconify-icons/ph/gear-six";
import pencilSimpleLine from "@iconify-icons/ph/pencil-simple-line";
import tray from "@iconify-icons/ph/tray";
import hardDrives from "@iconify-icons/ph/hard-drives";
import squaresFour from "@iconify-icons/ph/squares-four";

export const icons = {
  home: house,
  editor: table,
  compare: gitDiff,
  changes: gitPullRequest,
  approvals: sealCheck,
  history: clockCounterClockwise,
  schemas: shieldCheck,
  plugins: plugsConnected,
  deployments: rocketLaunch,
  import: downloadSimple,
  drift: activity,
  audit: scroll,
  users: usersThree,
  settings: gearSix,
  edit: pencilSimpleLine,
  inbox: tray,
  systems: hardDrives,
  workspace: squaresFour,
} satisfies Record<string, IconifyIcon>;

export function Ic({
  icon,
  size = 16,
  style,
}: {
  icon: IconifyIcon;
  size?: number;
  style?: React.CSSProperties;
}) {
  return <Icon icon={icon} width={size} height={size} style={{ verticalAlign: "-0.18em", ...style }} />;
}
