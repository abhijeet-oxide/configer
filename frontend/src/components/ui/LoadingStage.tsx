import type { ReactNode } from "react";
import { LoadingOutlined } from "@ant-design/icons";

// LoadingStage makes waiting informative: the existing skeleton keeps the
// page's shape while a stage line says what is actually happening
// ("Rendering files for prod-us-east...", "Computing differences...").
// Never fakes progress; the stage text changes only when the work does.
export default function LoadingStage({ stage, skeleton }: { stage: string; skeleton?: ReactNode }) {
  return (
    <div style={{ position: "relative", height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "var(--sp-2) var(--sp-4)",
          fontSize: "var(--fs-12)",
          color: "var(--text-2)",
          flexShrink: 0,
        }}
        role="status"
        aria-live="polite"
      >
        <LoadingOutlined style={{ color: "var(--brand)" }} />
        {stage}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{skeleton}</div>
    </div>
  );
}
