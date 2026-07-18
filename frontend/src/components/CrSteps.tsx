import { Tag, Tooltip } from "antd";
import { EditOutlined, EyeOutlined, CheckCircleOutlined, CheckOutlined, CloseOutlined } from "../icons";
import type { ChangeState } from "../api";
import { StatusPill, type PillTone } from "./ui";

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

// CrSteps is the same single-line stepper the wizards use: numbered/icon
// nodes joined by a connector that fills brand as the request advances, a
// check on completed steps, a soft ring on the active one. Each step's plain
// explanation rides in a tooltip so the label stays to one line and never
// wraps into the cramped two-row look of a raw component stepper. A rejected
// request turns the review node red rather than adding a fourth column.
export default function CrSteps({ state }: { state: ChangeState }) {
  const failed = state === "rejected";
  const current = failed ? 1 : state === "draft" ? 0 : state === "under_review" || state === "approved" ? 1 : 2;
  const steps = [
    { label: "Draft", icon: <EditOutlined />, explain: stateMeta.draft.explain },
    {
      label: failed ? "Rejected" : "Under review",
      icon: failed ? <CloseOutlined /> : <EyeOutlined />,
      explain: failed ? stateMeta.rejected.explain : stateMeta.under_review.explain,
    },
    { label: "Published", icon: <CheckCircleOutlined />, explain: stateMeta.published.explain },
  ];
  return (
    <div className="flex items-start" role="list" aria-label="Change request progress">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const isErr = failed && i === 1;
        const filled = done || active;
        const accent = isErr ? "var(--c-danger)" : "var(--brand)";
        return (
          <div key={s.label} className="flex min-w-0 flex-1 items-start" role="listitem">
            <div className="flex min-w-0 flex-col items-center gap-1.5" style={{ flex: "0 0 auto" }}>
              <Tooltip title={s.explain}>
                <div
                  className="flex size-8 items-center justify-center rounded-full text-[13px]"
                  style={{
                    background: isErr ? "var(--c-danger)" : filled ? "var(--brand)" : "var(--surface-2)",
                    color: isErr || filled ? "#fff" : "var(--text-3)",
                    border: isErr || filled ? "none" : "1.5px solid var(--border-strong)",
                    boxShadow: active ? `0 0 0 4px color-mix(in srgb, ${accent} 18%, transparent)` : undefined,
                  }}
                >
                  {done ? (
                    <CheckOutlined style={{ fontSize: 13 }} />
                  ) : (
                    <span style={{ fontSize: 14, display: "inline-flex" }}>{s.icon}</span>
                  )}
                </div>
              </Tooltip>
              <span
                className="max-w-[9rem] truncate text-center text-xs leading-tight"
                style={{
                  color: active ? "var(--text)" : done ? "var(--text-2)" : "var(--text-3)",
                  fontWeight: active ? 600 : 400,
                }}
                title={s.label}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className="relative mx-1 mt-4 h-0.5 flex-1 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
                <div className="absolute inset-y-0 left-0 rounded-full" style={{ background: "var(--brand)", width: done ? "100%" : "0%" }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
