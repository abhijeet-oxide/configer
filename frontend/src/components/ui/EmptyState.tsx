import type { ReactNode } from "react";
import { Button } from "antd";

// EmptyState replaces the bare AntD Empty in recomposed flows: an icon in a
// soft pressed well, a one-line title, a one-line hint and an optional action.
export default function EmptyState({
  icon,
  title,
  hint,
  actionLabel,
  onAction,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      {icon && (
        <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-brand-soft text-xl text-brand shadow-neu-inset">
          {icon}
        </div>
      )}
      <div className="text-sm font-semibold text-ink">{title}</div>
      {hint && <div className="max-w-[420px] text-xs text-ink-2">{hint}</div>}
      {actionLabel && onAction && (
        <Button type="primary" size="small" onClick={onAction} className="mt-2">
          {actionLabel}
        </Button>
      )}
      {children}
    </div>
  );
}
