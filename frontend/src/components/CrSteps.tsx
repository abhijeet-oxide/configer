import { Steps, Tag, Tooltip } from "antd";
import { EditOutlined, EyeOutlined, CheckCircleOutlined } from "@ant-design/icons";
import type { ChangeState } from "../api";

// CrSteps renders a change request's lifecycle like package tracking:
// Draft → Under Review → Published. Each step explains what is happening on
// Git underneath, so users learn GitOps gradually without needing it upfront.

export const stateMeta: Record<ChangeState, { color: string; label: string; explain: string }> = {
  draft: {
    color: "default",
    label: "Draft",
    explain: "Your edits are saved here in Configer only — nothing has been written to Git yet.",
  },
  under_review: {
    color: "processing",
    label: "Under Review",
    explain: "Saved to Git on its own branch (with a pull request when GitHub is connected), waiting for an approver.",
  },
  approved: {
    color: "cyan",
    label: "Approved",
    explain: "Approved by a reviewer — ready to be published (merged) to the target branch.",
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

export default function CrSteps({ state }: { state: ChangeState }) {
  const current = state === "draft" ? 0 : state === "under_review" || state === "approved" ? 1 : 2;
  const failed = state === "rejected";
  return (
    <Steps
      size="small"
      current={current}
      status={failed ? "error" : current === 2 ? "finish" : "process"}
      items={[
        {
          title: "Draft",
          icon: <EditOutlined />,
          description: "Edits collected in Configer",
        },
        {
          title: failed ? "Rejected" : "Under Review",
          icon: <EyeOutlined />,
          description: failed ? "Closed without publishing" : "On a Git branch, awaiting approval",
        },
        {
          title: "Published",
          icon: <CheckCircleOutlined />,
          description: "Merged to the target branch",
        },
      ]}
    />
  );
}
