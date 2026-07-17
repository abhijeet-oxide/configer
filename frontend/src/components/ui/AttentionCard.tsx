import type { ReactNode } from "react";
import { Button } from "antd";
import {
  ExclamationCircleFilled,
  CloseCircleFilled,
  CheckCircleFilled,
  InfoCircleFilled,
} from "../../icons";

// AttentionCard is one "Needs your attention" row from the reference: a
// severity icon, a title with a supporting line, and a right-aligned action.
// It sits INSIDE a SectionCard, so it reads as a flat, hairline-bordered row
// rather than a pressed-in well or another floating surface.
export type AttentionSeverity = "warn" | "danger" | "ok" | "info";

const ICON: Record<AttentionSeverity, ReactNode> = {
  warn: <ExclamationCircleFilled style={{ color: "var(--c-pending)", fontSize: 16 }} />,
  danger: <CloseCircleFilled style={{ color: "var(--c-danger)", fontSize: 16 }} />,
  ok: <CheckCircleFilled style={{ color: "var(--c-ok)", fontSize: 16 }} />,
  info: <InfoCircleFilled style={{ color: "var(--c-review)", fontSize: 16 }} />,
};

export default function AttentionCard({
  severity,
  title,
  sub,
  actionLabel,
  onAction,
  primary = false,
  extra,
}: {
  severity: AttentionSeverity;
  title: ReactNode;
  sub?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  /** render the action as the primary (brand) button */
  primary?: boolean;
  extra?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-card border border-line bg-surface-2 p-3">
      <span className="inline-flex shrink-0">{ICON[severity]}</span>
      <div className="min-w-0 flex-1">
        <div className="overflow-hidden text-[13px] font-semibold text-ellipsis whitespace-nowrap text-ink">
          {title}
        </div>
        {sub && (
          <div className="mt-px overflow-hidden text-xs text-ellipsis whitespace-nowrap text-ink-2">
            {sub}
          </div>
        )}
      </div>
      {extra}
      {actionLabel && onAction && (
        <Button size="small" type={primary ? "primary" : "default"} onClick={onAction} className="shrink-0">
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
