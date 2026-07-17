import type { ReactNode } from "react";

// PageHeader standardizes the top block of every screen: a strong title, an
// optional description in secondary text, and a right-aligned actions slot.
export default function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** optional extra row under the title (context chips, filter tabs) */
  children?: ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xl leading-snug font-semibold text-ink">
            {title}
          </div>
          {description && <div className="mt-0.5 text-[13px] text-ink-2">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
