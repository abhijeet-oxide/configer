import type { ReactNode } from "react";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
} from "../../icons";

// InlineNotice is the design system's one-line message: an icon, a sentence,
// and (optionally) one action, on a tinted strip the height of a control.
//
// It exists because most of what the app has to say is one sentence. A full
// Alert block - title line, description paragraph, generous padding - spends a
// whole band of the screen on it and reads as an interruption, which is wrong
// for something like "detected layout: kustomize". Reserve the full Alert for
// the rare message that genuinely needs a paragraph; everything else is this.

export type NoticeTone = "info" | "ok" | "warn" | "danger" | "neutral";

const TONE_CLASS: Record<NoticeTone, string> = {
  info: "bg-review-bg border-review-bd text-ink",
  ok: "bg-ok-bg border-ok-bd text-ink",
  warn: "bg-pending-bg border-pending-bd text-ink",
  danger: "bg-danger-bg border-danger-bd text-ink",
  neutral: "bg-surface-2 border-line text-ink-2",
};

const ICON_CLASS: Record<NoticeTone, string> = {
  info: "text-review",
  ok: "text-ok",
  warn: "text-pending",
  danger: "text-danger",
  neutral: "text-ink-3",
};

const DEFAULT_ICON: Record<NoticeTone, ReactNode> = {
  info: <InfoCircleOutlined />,
  ok: <CheckCircleOutlined />,
  warn: <ExclamationCircleOutlined />,
  danger: <CloseCircleOutlined />,
  neutral: <InfoCircleOutlined />,
};

export default function InlineNotice({
  tone = "info",
  icon,
  children,
  action,
  className = "",
}: {
  tone?: NoticeTone;
  /** override the tone's icon; pass null for no icon at all */
  icon?: ReactNode | null;
  children: ReactNode;
  /** one trailing control (a link button, "Try again"), kept on the same line */
  action?: ReactNode;
  className?: string;
}) {
  const glyph = icon === null ? null : (icon ?? DEFAULT_ICON[tone]);
  return (
    <div
      className={`flex items-center gap-2 rounded-card border px-3 py-1.5 text-[13px] leading-snug ${TONE_CLASS[tone]} ${className}`}
      role={tone === "danger" || tone === "warn" ? "alert" : undefined}
    >
      {glyph && <span className={`shrink-0 ${ICON_CLASS[tone]}`}>{glyph}</span>}
      <span className="min-w-0 flex-1">{children}</span>
      {action && <span className="shrink-0">{action}</span>}
    </div>
  );
}
