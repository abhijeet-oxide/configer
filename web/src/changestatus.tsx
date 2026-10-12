// Where a change is in its life, said the same way everywhere.
//
// This vocabulary used to live inside ChangeGraph, which was fine while the
// Change Flow was the only picture that drew a change's status. It is not any
// more: a parameter's own history draws the same states at a tenth of the size,
// and two hand-made copies of "rejected is red, broken-dashed and crossed" is
// exactly how one of them ends up saying amber next year. So the vocabulary is
// ONE module and both pictures read from it.
//
// The rule it exists to protect: a state is NEVER said in one channel alone. It
// is a colour AND a line style AND a mark, so the picture survives being small,
// being printed, and being read by somebody who cannot separate the hues.
//
// Colour means branch identity or status, and nothing else. A change's TYPE
// (hotfix, feature, bugfix) is a shape and a word, never a colour - so a red
// thing on screen always means the same thing.

import {
  BranchesOutlined,
  BugOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
  EyeOutlined,
  RocketOutlined,
  ShieldOutlined,
  ThunderboltOutlined,
  WrenchOutlined,
} from "./icons";
import type { ReactNode } from "react";
import type { ChangeState } from "./api";

/** Change types, said in a mark and a word. No colour: colour is for branch and
 *  status only, so a reader never has to wonder whether orange means urgent. */
export const TYPE_MARK: Record<string, { icon: ReactNode; label: string }> = {
  hotfix: { icon: <ThunderboltOutlined />, label: "Hotfix" },
  feature: { icon: <BranchesOutlined />, label: "Feature" },
  bugfix: { icon: <BugOutlined />, label: "Bugfix" },
  security: { icon: <ShieldOutlined />, label: "Security" },
  maintenance: { icon: <WrenchOutlined />, label: "Maintenance" },
  other: { icon: <EditOutlined />, label: "Change request" },
  change: { icon: <EditOutlined />, label: "Change request" },
};

export const typeMark = (category?: string) => TYPE_MARK[(category ?? "").toLowerCase()] ?? TYPE_MARK.change;

/** Where a change is in its life. This is the OTHER thing colour is allowed to
 *  mean, and every state gets three signals at once.
 *
 *  The value doubles as the CSS class suffix a picture stroking a path in this
 *  state uses (`.cf-flow.is-rejected path`), which is where the LINE STYLE is
 *  stated - once, in CSS, rather than again here in numbers that would drift. */
export type FlowStatus = "draft" | "review" | "approved" | "merged" | "rejected";

export const statusOf = (s: ChangeState): FlowStatus =>
  s === "published"
    ? "merged"
    : s === "rejected"
      ? "rejected"
      : s === "approved"
        ? "approved"
        : s === "under_review"
          ? "review"
          : "draft";

export interface StatusLook {
  /** the word on the card's status chip */
  label: string;
  /** the sentence a reader gets on hover */
  words: string;
  icon: ReactNode;
  /** it has not landed but it is ON ITS WAY: draw where it is headed, dotted,
   *  so a reviewer can see what is waiting on them and where it will end up */
  projects?: boolean;
}

export const STATUS: Record<FlowStatus, StatusLook> = {
  draft: {
    label: "Draft",
    words: "Draft - yours, and not sent for review yet",
    icon: <EditOutlined />,
  },
  review: {
    label: "Pending review",
    words: "Submitted - waiting for a reviewer",
    icon: <EyeOutlined />,
    projects: true,
  },
  approved: {
    label: "Approved",
    words: "Approved - waiting to be published",
    icon: <CheckCircleOutlined />,
    projects: true,
  },
  merged: {
    label: "Published",
    words: "Published - live in the repository",
    icon: <RocketOutlined />,
  },
  rejected: {
    label: "Rejected",
    words: "Rejected in review - it was never published",
    icon: <CloseCircleOutlined />,
  },
};

/** The colour a state is said in. Spelled out rather than built from the state
 *  name: a token that does not exist resolves to nothing, and a path stroked
 *  with nothing is simply not drawn.
 *
 *  Only four hues, and a fifth would start colliding with the lanes. Approved
 *  deliberately shares published's green because it has the same destiny; its
 *  long dash is what says it has not got there yet. */
export const STATUS_COLOR: Record<FlowStatus, string> = {
  draft: "var(--cf-draft)",
  review: "var(--cf-review)",
  approved: "var(--cf-merged)",
  merged: "var(--cf-merged)",
  rejected: "var(--cf-reject)",
};

export const statusColor = (s: FlowStatus) => STATUS_COLOR[s];
