import type { ReactNode } from "react";
import { Button } from "antd";
import {
  ExclamationCircleFilled,
  CloseCircleFilled,
  CheckCircleFilled,
  InfoCircleFilled,
} from "@ant-design/icons";

// AttentionCard is one "Needs your attention" row from the reference: a
// severity icon, a title with a supporting line, and a right-aligned action.
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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-3)",
        padding: "var(--sp-3)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        background: "var(--surface)",
        minWidth: 0,
      }}
    >
      <span style={{ flexShrink: 0, display: "inline-flex" }}>{ICON[severity]}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: "var(--fs-13)",
            fontWeight: 600,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        {sub && (
          <div
            style={{
              fontSize: "var(--fs-12)",
              color: "var(--text-2)",
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sub}
          </div>
        )}
      </div>
      {extra}
      {actionLabel && onAction && (
        <Button size="small" type={primary ? "primary" : "default"} onClick={onAction} style={{ flexShrink: 0 }}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
