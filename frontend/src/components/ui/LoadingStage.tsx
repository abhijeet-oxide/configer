import type { ReactNode } from "react";
import { LoadingOutlined } from "../../icons";

// LoadingStage makes waiting informative: the existing skeleton keeps the
// page's shape while a stage line says what is actually happening
// ("Rendering files for prod-us-east...", "Computing differences...").
// Never fakes progress; the stage text changes only when the work does.
export default function LoadingStage({ stage, skeleton }: { stage: string; skeleton?: ReactNode }) {
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs text-ink-2" role="status" aria-live="polite">
        <LoadingOutlined style={{ color: "var(--brand)" }} />
        {stage}
      </div>
      <div className="min-h-0 flex-1">{skeleton}</div>
    </div>
  );
}
