import { Tag, Tooltip } from "antd";
import { EditOutlined, EyeOutlined, CheckCircleOutlined, CloseOutlined } from "../icons";
import type { ChangeState } from "../api";
import { StatusPill, Stepper, type PillTone } from "./ui";

// CrSteps renders a change request's lifecycle like package tracking:
// Draft → Under Review → Published. Each step explains what is happening on
// Git underneath, so users learn GitOps gradually without needing it upfront.

export const stateMeta: Record<ChangeState, { color: string; label: string; explain: string }> = {
  draft: {
    color: "default",
    label: "Draft",
    explain: "Your edits are saved here in Configer only; nothing has been written to Git yet.",
  },
  under_review: {
    color: "processing",
    label: "Under Review",
    explain: "Saved to Git on its own branch (with a pull request when GitHub is connected), waiting for an approver.",
  },
  approved: {
    color: "cyan",
    label: "Approved",
    explain: "Approved by a reviewer; ready to be published (merged) to the target branch.",
  },
  published: {
    color: "success",
    label: "Published",
    explain: "Merged into the target Git branch. This is now the live configuration.",
  },
  rejected: {
    color: "error",
    label: "Rejected",
    explain: "Closed without publishing. The edits were not merged into Git.",
  },
};

export function StateTag({ state }: { state: ChangeState }) {
  const m = stateMeta[state];
  return (
    <Tooltip title={m.explain}>
      <Tag color={m.color}>{m.label}</Tag>
    </Tooltip>
  );
}

// StatePill is the design-layer chip for the same lifecycle (the reference's
// "Pending review" pill); one mapping so state colors never diverge.
const stateTone: Record<ChangeState, { tone: PillTone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  under_review: { tone: "pending", label: "Pending review" },
  approved: { tone: "review", label: "Approved" },
  published: { tone: "ok", label: "Published" },
  rejected: { tone: "danger", label: "Rejected" },
};

export function StatePill({ state, size = "md" }: { state: ChangeState; size?: "sm" | "md" }) {
  const m = stateTone[state];
  return (
    <Tooltip title={stateMeta[state].explain}>
      <span className="inline-flex">
        <StatusPill tone={m.tone} size={size}>
          {m.label}
        </StatusPill>
      </span>
    </Tooltip>
  );
}

// CrSteps is the wizards' Stepper applied to a change request's lifecycle:
// Draft -> Under review -> Published, numbered/icon nodes joined by a connector
// that fills brand as the request advances. Each step's plain explanation rides
// in a tooltip so the label stays to one line. A rejected request turns the
// review node red rather than adding a fourth column.
export default function CrSteps({ state }: { state: ChangeState }) {
  const failed = state === "rejected";
  const current = failed ? 1 : state === "draft" ? 0 : state === "under_review" || state === "approved" ? 1 : 2;
  const steps = [
    { label: "Draft", icon: <EditOutlined />, explain: stateMeta.draft.explain },
    {
      label: failed ? "Rejected" : "Under review",
      icon: failed ? <CloseOutlined /> : <EyeOutlined />,
      explain: failed ? stateMeta.rejected.explain : stateMeta.under_review.explain,
      error: failed,
    },
    { label: "Published", icon: <CheckCircleOutlined />, explain: stateMeta.published.explain },
  ];
  return <Stepper steps={steps} current={current} ariaLabel="Change request progress" />;
}
